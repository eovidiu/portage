## Context

`runCopyTick` opens with `loadActiveJob`, an unconditional Neon HTTP query, and the `*/5` cron calls
it 288 times a day. Neon's free plan autosuspends a compute after five minutes of inactivity and
that timeout is fixed, so a query every five minutes never lets the timer expire. The result is a
compute that is awake 99.7% of wall clock at an average 0.268 CU — paying for presence, not work.

Constraints that shape the design:

- The Worker has **no storage bindings today**; this introduces the first one. The account has zero
  KV namespaces.
- `wrangler.toml` is gitignored. The tracked template is `wrangler.toml.example`, which CI copies
  into place. Any binding must be added to both.
- The advisory lock (`src/sync/lock.ts`) is the only user of the WebSocket `Pool` driver and is
  reached only when there is genuinely work; the idle path is HTTP-only. So the fix is entirely
  about the one query in front of it.
- `copy_jobs.updated_at` currently means "last ticked", not "last changed", because
  `resetConsecutiveErrors` and `recomputeCounters` write it on every successful tick.
- Real job durations range from ~1 h for 40 tracks to 2 days 3 h 32 m for 447 tracks (~8-9
  tracks/hour under the `COPY_BATCH_*=2` clamps).

## Goals / Non-Goals

**Goals:**
- An idle heartbeat performs zero database work, so Neon's autosuspend timer expires and the
  compute scales to zero between the twice-daily syncs.
- Copy jobs keep working exactly as they do now, at the same cadence, with no user-visible change.
- Correctness never depends on the new storage layer; only cost does.
- A wedged copy job cannot silently re-create the 24/7 burn.

**Non-Goals:**
- Removing the `*/5` cron. Cron triggers are free and capped at 5 per account; portage uses 3.
- Replacing the cron with Durable Object alarms. That is the more elegant event-driven design but a
  new platform primitive, a migration, and a much larger blast radius than the problem warrants.
- Reducing the database work done by HTTP routes (`/readyz`, `/sync/status`, the copy job detail
  endpoint). Those only run while someone is actually using the app and are not the 24/7 driver;
  a live `wrangler tail` sample showed zero HTTP traffic.
- Any schema migration.

## Decisions

**A KV flag rather than a Durable Object or a wider cron interval.**
KV is the smallest primitive that answers "is there work?" without a database round trip. A wider
interval (say `*/30`) would still wake the compute 48 times a day — roughly 4 h/day of forced
uptime, ~120 CU-hours/month, still over quota — while making copies six times slower. A Durable
Object with alarms would be genuinely event-driven and cost nothing when idle, but it is a new
primitive with its own migration and a far larger change. KV keeps the existing engine, cron and
lock untouched, and the whole gate is a handful of lines.

**The flag is a cache, never a source of truth.**
Every failure path reports "an active job may exist" so the caller falls through to the query it
already ran before this change. A KV outage therefore costs money, never correctness — it degrades
to exactly today's behaviour. This is why the read helper is named for a hedge
(`mayHaveActiveCopyJob`) rather than a fact: the name makes the fail-open semantics obvious at the
call site.

**Terminal-only release, driven off the existing chokepoints.**
`createJob` is the only place a job becomes active, and `setStatus` plus `cancelJob` are the only
writers of terminal statuses, so those three are the complete set of hooks. `setStatus` also drives
the non-terminal `matching → writing` hop, so the release must branch on whether the target status
is terminal — clearing there would make the next tick skip a live job. Both functions already
return whether their guarded `UPDATE` actually applied, so a no-op (a concurrent cancel already
landed the job terminal) is distinguishable and does not double-clear.

**Two asymmetric self-heal paths, because the two drift directions have different costs.**
A flag stuck *set* costs one idle query per tick and is cleared by the first tick that queries and
finds nothing — self-healing in five minutes, and the cost until then is exactly today's cost. A
flag stuck *clear* is worse: a live job becomes invisible to every tick and stalls. Only a query
can discover that, so it is recovered by the job inspection endpoint (which the UI polls for a
job's whole life, giving recovery in seconds) and, as a backstop, by reconciling against
`copy_jobs` on the twice-daily sync path — which already pays to wake the compute, so the extra
query is free.

**The sweep keys off corrected `updated_at`, not a wall-clock cap.**
Two obvious designs are both wrong. A cap on `created_at` would have killed the real 447-track job
at 2 days 3 h, and a 2,000-track playlist would legitimately need over a week. Keying off
`updated_at` as it stands is equally broken, because `resetConsecutiveErrors` and
`recomputeCounters` bump it on every successful tick, so a job that ticks forever without
progressing never looks stale.

The fix is to make `updated_at` mean what its name says: make both writes conditional on something
having actually changed. `resetConsecutiveErrors` gains `AND consecutive_errors <> 0`;
`recomputeCounters` skips its `UPDATE` when the recomputed counters equal the stored ones. Every
other writer of `updated_at` in the copy path (`setStatus`, `cancelJob`, the write-batch markers,
`incrementConsecutiveErrors`) already corresponds to a real change. This also removes two pointless
writes per tick. Staleness then becomes a simple, honest predicate, and a healthy job — which moved
a counter every ~7 minutes even on the slowest real run — is never at risk.

**The sweep runs on the sync path, not the tick.**
Hosting it on the copy tick would reintroduce the very query being removed. It belongs next to
`markAbandonedRuns`, which already runs unconditionally at the top of `runSync` for exactly the
same reason. Detection latency is therefore up to 12 hours, which is appropriate for a condition
that should never occur.

## Risks / Trade-offs

- **Flag lost on write, so a live job never ticks** → recovered by the job inspection endpoint
  within one UI poll, and by the sync reconcile within 12 h. Residual: a job created with the UI
  closed and no sync due could stall for up to 12 h.
- **KV eventual consistency (~60 s)** → a newly armed flag may briefly read as absent, delaying a
  new job's first tick by at most one 5-minute period; after a clear, at most ~60 s of extra idle
  queries. Both are acceptable at this cadence.
- **Binding missing in production**, since `wrangler.toml` is gitignored and a deploy from a machine
  without the block would silently ship without KV → the fail-open design degrades to today's
  behaviour rather than breaking. Detect it by the absence of the new idle outcome in logs, by the
  `copy_active_flag_failed` log event, and by Neon `active_time` failing to drop. The namespace step
  goes into the pre-deploy checklist, and `wrangler deploy` prints its binding list.
- **Import direction**: `src/db/copy_jobs.ts` gains an import from `src/copy/`. No cycle exists
  because the flag module imports only the `Env` type; a comment in that module records the
  constraint so it is not broken later.
- **Existing test suites desynchronise** if the sync path's new query consumes one of the ordered
  mock responses the orchestrator tests queue up → both orchestrator test files mock the copy-jobs
  module explicitly.
- **The sweep fails a job a human was still nursing** → the window is hours, not minutes, the sweep
  only touches jobs with no observable change at all, and a swept job is reported through the same
  terminal notification path as any other failure.

## Migration Plan

1. Create the namespace: `npx wrangler kv namespace create COPY_STATE`. Wrangler does not auto-patch
   TOML configs, so paste the printed id into the gitignored `wrangler.toml` by hand and mirror the
   block into `wrangler.toml.example` with a placeholder id.
2. Merge the code change on green CI. The placeholder id is fine for CI and for tests: wrangler
   validates `id` only as a non-empty string, and the test pool provisions a local simulated
   namespace keyed by binding name, so no `vitest.config.ts` or workflow change is needed.
3. Deploy and confirm `COPY_STATE` appears in the binding list wrangler prints.
4. Verify against the Neon control plane that the compute reaches `idle` and that `active_time`
   stops tracking wall clock. This is the only verification that actually proves the fix.

**Rollback**: remove the `[[kv_namespaces]]` block and redeploy, or revert the commit. Because every
KV failure falls through to the database query, a Worker running this code with no binding behaves
exactly as it did before the change.

## Open Questions

- The exact staleness window for the sweep. Six hours is proposed: it is two orders of magnitude
  above the observed ~7-minute progress cadence of the slowest real job, and well inside the
  twice-daily sweep cadence. It is a constant, easy to revise once there is evidence.
