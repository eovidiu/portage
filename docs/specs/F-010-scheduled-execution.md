# F-010: Scheduled execution

## Summary

The Worker's `scheduled` handler invokes the orchestrator (F-009) on cron triggers configured in `wrangler.toml`. Two daily runs are configured at 07:23 and 19:23 UTC by default. The handler MUST tolerate one missed run by relying on the cursor in F-005 to catch up on the next successful run.

## Linked tests

[T-010](../tests/T-010-scheduled-execution.md)

## Dependencies

- F-009 (the only thing the handler does is call the orchestrator)
- Cloudflare Workers cron triggers

## Behavioural specification

### Scheduled invocation, normal

- **Given** the Worker is deployed with cron `23 7,19 * * *`
- **When** the Cloudflare scheduler fires at one of those times
- **Then** the Worker's `scheduled` export is invoked with the event
- **And** the handler calls the orchestrator (F-009)
- **And** awaits its completion before returning

### Scheduled invocation, orchestrator skipped

- **Given** another orchestrator is already running
- **When** the scheduled handler invokes the orchestrator
- **Then** the orchestrator returns `skipped_locked`
- **And** the handler logs a `scheduled_skipped_locked` line
- **And** returns without error

### Scheduled invocation, orchestrator failed

- **Given** the orchestrator throws or returns `failed`
- **When** the scheduled handler completes
- **Then** the handler logs the failure
- **And** does NOT raise to Cloudflare in a way that would cause retry storms

### Manual trigger

- **Given** an authenticated client
- **When** the client calls `POST /sync/run`
- **Then** the route handler invokes the same orchestrator path used by `scheduled`
- **And** responds with `{"run_id": "<uuid>", "status": "<final_status>"}` synchronously if the run completes within 25 seconds
- **And** responds with `{"run_id": "<uuid>", "status": "running"}` and HTTP 202 if the run is still in progress

## Detailed requirements

| ID | Requirement |
|---|---|
| F-010-R1 | `wrangler.toml` MUST declare cron triggers `["23 7 * * *", "23 19 * * *"]`. |
| F-010-R2 | The cron schedule MUST be expressed in UTC; documentation MUST note the local time conversion for the operator's primary timezone. |
| F-010-R3 | The `scheduled` export MUST be a function `(event, env, ctx) => Promise<void>` that calls the orchestrator. |
| F-010-R4 | `ctx.waitUntil` MUST be used to extend the lifetime of any post-orchestrator logging. |
| F-010-R5 | A scheduled run MUST NOT exceed Cloudflare's CPU time limits; the orchestrator's wall-time cap (F-009-R4) is independent and stricter. |
| F-010-R6 | The manual `POST /sync/run` endpoint MUST require JWT (F-001). |
| F-010-R7 | The manual endpoint MUST race the orchestrator against a 25-second timer; if the orchestrator has not finished, the response MUST be HTTP 202 with the in-progress run id. |
| F-010-R8 | If the cron triggers do not fire for any reason, the cursor in F-005 MUST guarantee no track is missed on the next successful run. |
| F-010-R9 | The scheduled handler MUST NOT throw uncaught exceptions; all errors MUST be caught and logged. |
| F-010-R10 | A redeployment in the middle of a scheduled invocation MUST NOT corrupt state; F-009's lock and idempotency rules cover this. |

## API contract

### `POST /sync/run`

Auth: JWT.

Request body: empty or `{}`.

Synchronous success (run completed within 25 s):
```
HTTP/1.1 200 OK
Content-Type: application/json

{
  "run_id": "f7a3...",
  "status": "succeeded" | "partial" | "failed",
  "tracks_seen": 12,
  "matched_isrc": 10,
  "matched_fuzzy": 1,
  "unmatched": 1,
  "errors": 0,
  "duration_ms": 18234
}
```

Asynchronous (run still in progress):
```
HTTP/1.1 202 Accepted
Content-Type: application/json

{
  "run_id": "f7a3...",
  "status": "running"
}
```

Lock contention:
```
HTTP/1.1 409 Conflict
Content-Type: application/json

{
  "error": "run_in_progress",
  "current_run_id": "f7a3..."
}
```

## Data effects

- Indirect, via F-009

## Failure modes

| Mode | Cause | Recovery |
|---|---|---|
| Cron does not fire | Cloudflare incident | Manual `POST /sync/run`; cursor catches up |
| Scheduled handler exceeds CPU | Should not occur with the F-009 wall-time cap | Investigate; reduce per-run batch size if catch-up is huge |
| Manual trigger called repeatedly | Operator behaviour | F-009 lock prevents concurrent runs; second call returns 409 |

## Acceptance criteria

- All tests in T-010 pass
- A manually-triggered run produces a valid `sync_runs` row identical in structure to a cron-triggered run
- Disabling the cron, then re-enabling after 24 hours, results in a single catch-up run that processes all likes from the gap
- A 409 is returned if a second `POST /sync/run` arrives while a first is in progress

## Amendment 2026-05-02 (F-015): operational guidance for backfill vs steady state

Steady-state cron schedule (`23 7 * * *`, `23 19 * * *` UTC) processes ~5 new
tracks per invocation, well within the Workers Free 50-subrequest cap.

For BACKFILL of a historical Liked Songs library, a cron-every-15-minutes
schedule drains the queue without exceeding Free-tier limits. Procedure:

1. Edit `wrangler.toml`: set `crons = ["*/15 * * * *"]`
2. `npx wrangler deploy`
3. Wait until `tracks.count − unmatched.count(status='skipped') ≈ matches.count`
   (verify via SQL on Neon)
4. Edit `wrangler.toml` back to `["23 7 * * *", "23 19 * * *"]`
5. `npx wrangler deploy`

Backfill duration estimate: `tracks_total / MATCH_BATCH_ISRC` invocations,
multiplied by the cron interval. For 1000 tracks at 5/run with 15-min cron,
~50 hours of unattended operation. The mid-sweep `spotify_resume_url`
state (F-005 amendment) ensures Spotify pagination resumes between invocations
without re-fetching processed pages.
