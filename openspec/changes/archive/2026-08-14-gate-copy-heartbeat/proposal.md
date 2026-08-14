## Why

The `*/5 * * * *` cron fires 288 times a day and its first action is an unconditional Neon query
(`loadActiveJob` in `src/copy/engine.ts`), even when no copy job exists. Neon's free plan
autosuspends a compute after 5 minutes of inactivity and that timeout is not configurable, so a
query every 5 minutes holds the compute permanently awake. Measured on 2026-08-14: `active_time`
1,153,840 s against 1,156,900 s of elapsed billing period — **99.7% uptime** — and 85.86 of the
100 CU-hour monthly quota consumed by day 13, at an average of 0.268 CU (i.e. idling, not working).

Only four copy jobs have ever existed, all terminal, none since 2026-07-26, so roughly 5,500
consecutive ticks have done nothing but the idle query. A live `wrangler tail` sample confirms the
only recurring event is that cron logging `{"event":"scheduled_copy_tick_completed","outcome":"idle"}`,
with zero HTTP traffic — nothing else contributes.

Left alone the quota is exhausted around 2026-08-16, at which point Neon suspends the compute until
2026-09-01 and the twice-daily sync stops entirely.

## What Changes

- The copy tick reads a Cloudflare KV flag before touching Neon. When the flag is absent the tick
  returns immediately, so an idle heartbeat performs **zero** database work. This adds the Worker's
  first storage binding (`COPY_STATE`); the account currently has no KV namespaces.
- The flag is armed when a copy job is created and released on every terminal transition
  (`setStatus` to a terminal status, and `cancelJob`). It is a cache of `copy_jobs`, never a source
  of truth: any KV failure reports "maybe active" so the caller falls through to the authoritative
  query. Correctness depends only on Postgres; only cost depends on KV.
- Two self-heal paths cover flag drift. A flag left set with no active job is cleared by the next
  tick. A flag lost on write is re-armed by `GET /api/copy/jobs/:job_id` (which the UI polls for a
  job's whole life) and, as a 12-hour backstop, reconciled on the twice-daily `runSync` path.
- A stuck-copy-job sweep is added, because `copy_jobs` has no analogue of `markAbandonedRuns`.
  Without it a wedged job pins the flag set forever and reintroduces the same bill.
- `updated_at` on `copy_jobs` is corrected to mean "last actual change" rather than "last ticked".
  Today `resetConsecutiveErrors` and `recomputeCounters` write `updated_at = now()` on every
  successful tick, which makes staleness undetectable and costs two pointless writes per tick. Both
  become conditional on something having actually changed.

## Capabilities

### New Capabilities
<!-- None. This changes how an existing capability is driven, not what the product does. -->

### Modified Capabilities
- `playlist-copy`: the copy-job tick gains a precondition (it performs no database work unless an
  active-job flag is present), the job lifecycle gains flag-arming and flag-releasing obligations at
  creation and terminal transitions, and a stalled job now reaches a terminal state on its own
  instead of remaining non-terminal indefinitely.

## Impact

- **Code**: `src/copy/active-flag.ts` (new), `src/copy/engine.ts`, `src/db/copy_jobs.ts`,
  `src/routes/copy/jobs.ts`, `src/sync/orchestrator.ts`, `src/env.ts`.
- **Config**: a `[[kv_namespaces]]` block in both `wrangler.toml` (gitignored, real id) and
  `wrangler.toml.example` (tracked, placeholder id — CI copies this file). No changes needed to
  `vitest.config.ts`, `tsconfig.json`, or `.github/workflows/ci.yml`.
- **Operations**: a one-time `npx wrangler kv namespace create COPY_STATE` before the deploy that
  ships this. Wrangler does not auto-patch TOML configs, so the printed id is pasted by hand.
  `docs/operations/pre-deploy-checklist.md` and `docs/operations/self-hosting.md` gain that step.
- **Data**: no schema migration. `copy_jobs.updated_at` changes meaning but not type or nullability.
- **Budget**: 288 KV reads/day against a 100,000/day free-tier limit, and roughly 2 writes per copy
  job against 1,000/day. Cron triggers stay at 3 of the 5 allowed per account.
- **Expected result**: idle days drop from ~24 h of Neon compute to the ~2 wake windows the
  twice-daily sync already needs, i.e. under 10 CU-hours/month against the 100 CU-hour quota.
