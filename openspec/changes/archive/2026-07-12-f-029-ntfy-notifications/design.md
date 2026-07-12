# Design: f-029-ntfy-notifications

## Context

Portage runs unattended (cron `23 7/19 * * *`). Run outcomes land in `sync_runs` and
structured logs, but nothing pushes them to the operator. The known worst failure class —
free-tier isolate kills — cannot self-report at all; `markAbandonedRuns` (src/db/sync_runs.ts)
sweeps those rows on the *next* cron and already returns the swept count, which the
orchestrator currently discards.

ntfy.sh is a zero-infrastructure pub-sub push service: publishing is a single
`POST {base}/{topic}` with optional `Title` / `Priority` / `Tags` headers
(canonical contract: https://docs.ntfy.sh/publish/). On the public server the topic name
is the only access control, so it is handled as a secret.

## Goals / Non-Goals

**Goals:**
- Push a notification for the final outcome of every sync run — scheduled, manual, and
  manual runs that outlive the 25 s HTTP race — plus an alert when abandoned runs are swept.
- Zero behavior change when `NTFY_TOPIC` is unset; zero possibility of a notification
  failure breaking a sync.
- Stay within free-tier budget: ≤ 2 extra subrequests per invocation, ≤ 5 s added wall time.

**Non-Goals:**
- No notification history/read model, no per-track detail in messages (the SPA covers that).
- No `skipped_locked` notifications (not a run; would double-notify alongside the winner).
- No retries — a missed notification is acceptable; the next run notifies again.
- No self-hosted ntfy setup automation (`NTFY_URL` override is the extent of support).

## Decisions

### D1 — Hook point: a wrapper around `runSync`, not the call sites
The exported `runSync` becomes a thin wrapper: it runs the pre-run `markAbandonedRuns`
sweep (moved up from the current body, same execution order), notifies if the sweep
caught anything, delegates to the current implementation (renamed `runSyncCore`, minus
the sweep), then notifies the outcome. Rationale: `runSync` is the single choke point
both `src/scheduled.ts` and `src/routes/sync/run.ts` already call — hooking here covers
every path including manual runs that continue past the 25 s race, and neither caller
changes. Alternative considered: notify from `scheduled.ts` + `run.ts` separately —
rejected because the manual route's 202/timeout path loses the final result, and two
call sites drift.

### D2 — Notify synchronously (await), bounded by a 5 s fetch timeout
The wrapper awaits the notification before returning. Alternative — `ctx.waitUntil` —
was rejected: the orchestrator has no `ExecutionContext`, and threading one through two
call sites for a ≤ 5 s bounded POST buys nothing. `AbortSignal.timeout(5000)` caps the
cost; cron budget is 30 s wall with real runs at 2–17 s.

### D3 — Failure isolation: the notify module never throws
`sendNtfyNotification` catches everything (including abort) and emits a structured
`ntfy_notify_failed` log line with `error` message and target topic omitted (the topic
is a secret; log the base URL only). A crash in `runSyncCore`'s pre-lock section
(`acquireLock` throwing) still propagates to callers exactly as today — the wrapper
notifies a failure, then rethrows.

### D4 — Config: `NTFY_TOPIC` + `NTFY_TOKEN` as secrets, `NTFY_URL` as optional var
The public-server topic is the credential (docs: "the topic is essentially a password"),
so it goes through `wrangler secret put`, never `[vars]`. `NTFY_URL` defaults to
`https://ntfy.sh` in code; only self-hosters set it. Feature gate is `NTFY_TOPIC`
presence — one check, no separate enable flag.

### D5 — Message contract
Headers per https://docs.ntfy.sh/publish/ (`Title`, `Priority` 1–5, `Tags` emoji
shortcodes; body plain UTF-8 ≤ 4096 bytes):

| Event | Title | Priority | Tags |
|---|---|---|---|
| succeeded | `Portage sync succeeded` | 2 (low) | `white_check_mark` |
| partial | `Portage sync partial` | 4 (high) | `warning` |
| failed | `Portage sync failed` | 4 (high) | `rotating_light` |
| abandoned sweep | `Portage: N abandoned run(s) swept` | 4 (high) | `ghost` |

Body: counts line (`seen/isrc/fuzzy/unmatched/errors`), `error_code` when present, and
`run_id` for correlation with `/sync/runs`. When `NTFY_TOKEN` is set, add
`Authorization: Bearer <token>`.

## Risks / Trade-offs

- [Topic leakage = anyone can read/spam notifications] → topic is a Worker secret,
  never logged, never committed; message bodies carry only counts/codes, no tokens or PII.
- [ntfy.sh outage adds up to 5 s to every run] → acceptable against the 30 s wall budget;
  timeout is hard via AbortSignal.
- [+1–2 subrequests per run] → current production runs sit well under the 50 cap
  (`MATCH_BATCH_*` clamped to 2); notification cost is negligible.
- [Isolate killed mid-run still sends nothing for *that* run] → inherent; the next run's
  abandoned-sweep notification is the designed detection path.
- [Manual-run notification duplicates what the operator already sees in the HTTP response]
  → accepted; consistency beats special-casing, and 202-timeout manual runs genuinely
  need the push.

## Migration Plan

1. Ship code (inert — `NTFY_TOPIC` unset in production).
2. Operator: create a private, hard-to-guess topic name; subscribe in the ntfy app;
   `wrangler secret put NTFY_TOPIC`; optionally `NTFY_TOKEN` for a reserved topic.
3. `npx wrangler deploy`; trigger a manual run to confirm the push arrives.
4. Rollback: delete the secret (feature returns to no-op) — no code revert needed.

## Open Questions

None — the ntfy contract is verified against the canonical docs, and the hook point is
fully determined by existing call sites.
