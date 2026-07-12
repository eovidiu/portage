# Proposal: f-029-ntfy-notifications

## Why

Sync runs happen unattended (cron 2x/day) and the operator only learns about failures by
querying `/sync/runs` or Neon after the fact. The worst failure class — free-tier isolate
kills that leave runs `'running'` until `markAbandonedRuns` sweeps them 12 h later — is
invisible until someone goes looking. Push notifications via ntfy.sh close this gap:
the operator hears about every run outcome and every problem on their phone, with zero
additional infrastructure (ntfy.sh public server, one HTTP POST per run).

## What Changes

- New optional Worker config: `NTFY_TOPIC` (secret — the topic is effectively a password
  on the public ntfy.sh server), `NTFY_URL` (base URL, defaults to `https://ntfy.sh`,
  overridable for self-hosted instances), `NTFY_TOKEN` (optional Bearer token secret).
- New module `src/notify/ntfy.ts` that publishes a plain-text run summary to
  `{NTFY_URL}/{NTFY_TOPIC}` using the documented `Title` / `Priority` / `Tags` headers.
- The scheduled cron path and the manual `POST /sync/run` path both send a notification
  for the final run outcome (`succeeded` / `partial` / `failed`); `skipped_locked` sends
  nothing.
- When the pre-run `markAbandonedRuns` sweep marks one or more runs `'abandoned'`, a
  high-priority notification reports the count — this is the only way the isolate-kill
  failure class can ever reach the operator.
- The feature is a complete no-op when `NTFY_TOPIC` is unset: no fetch, no log noise,
  no behavior change. Existing deployments are unaffected until the secret is set.
- A notification failure can never fail, delay (beyond a 5 s fetch timeout), or alter a
  sync run; it produces a structured `ntfy_notify_failed` log line instead.

## Capabilities

### New Capabilities

- `sync-notifications`: publishing sync-run outcomes and abandoned-run alerts to an
  ntfy topic — configuration, message contract (title/priority/tags/body), trigger
  points, failure isolation, and subrequest budget (≤ 2 per invocation).

### Modified Capabilities

<!-- none — orchestrator/sync behavior is unchanged; notifications observe outcomes
     that F-009 already produces. -->

## Impact

- **New code**: `src/notify/ntfy.ts` (+ tests `tests/notify/ntfy.test.ts`).
- **Touched code**: `src/env.ts` (3 optional vars), `src/scheduled.ts` (notify after
  `runSync` resolves and on the catch path), `src/routes/run.ts` (notify on final
  outcome of manual runs), `src/db/sync_runs.ts` (`markAbandonedRuns` must surface the
  swept count), `src/sync/orchestrator.ts` (propagate abandoned count into the result).
- **External dependency**: ntfy.sh publish HTTP API, grounded against
  https://docs.ntfy.sh/publish/ (POST `{base}/{topic}`; headers `Title`, `Priority`
  with values `1`–`5`, `Tags`; auth `Authorization: Bearer <token>`; body plain UTF-8
  text ≤ 4096 bytes).
- **Budget**: +1 subrequest per run outcome, +1 when an abandoned sweep fires — inside
  the free-tier 50-subrequest cap (production runs currently use well under half).
- **Operator action to activate**: `wrangler secret put NTFY_TOPIC`, subscribe to the
  topic in the ntfy app.
