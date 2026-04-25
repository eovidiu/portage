# F-011: Sync run logging and metrics

## Summary

Every sync run produces a structured summary persisted in `sync_runs` and a corresponding log line emitted to Cloudflare's observability. Read endpoints expose the most recent run, a recent-run list, and aggregate statistics over a configurable period.

## Linked tests

[T-011](../tests/T-011-sync-logging.md)

## Dependencies

- F-009 (the orchestrator owns writing the `sync_runs` row)
- F-001 (read endpoints require JWT)

## Behavioural specification

### Run summary line

- **Given** an orchestrator run that just transitioned to a terminal state
- **When** the run completes
- **Then** the system emits exactly one log line with:
  - `event = 'sync_run_completed'`
  - `run_id`
  - `status` (succeeded / partial / failed)
  - `tracks_seen`, `matched_isrc`, `matched_fuzzy`, `unmatched`, `errors`
  - `duration_ms`
  - `error_code` (only when status != succeeded)

### Latest status

- **Given** at least one run has completed
- **When** the client calls `GET /sync/status`
- **Then** the response is the most recent `sync_runs` row in JSON, plus:
  - `last_succeeded_at` (most recent run with `status = 'succeeded'`)
  - `lag_hours` (hours since `last_succeeded_at`)

### Recent runs

- **Given** a `limit` between 1 and 100 (default 20)
- **When** the client calls `GET /sync/runs?limit=<n>`
- **Then** the response is an array of run summaries ordered by `started_at DESC`

### Aggregate stats

- **Given** a `period` of `day`, `week`, or `month`
- **When** the client calls `GET /stats?period=<period>`
- **Then** the response includes:
  - `runs_total`, `runs_succeeded`, `runs_partial`, `runs_failed`
  - `tracks_processed_total`
  - `match_rate` (matched / processed, 0..1)
  - `match_rate_isrc` (matched_isrc / processed)
  - `match_rate_fuzzy` (matched_fuzzy / processed)
  - `unmatched_pending` (current count, not period-bound)

## Detailed requirements

| ID | Requirement |
|---|---|
| F-011-R1 | The summary log line MUST be valid JSON on a single line. |
| F-011-R2 | The log line MUST NOT contain access tokens, refresh tokens, or any secret. |
| F-011-R3 | The log line MUST be emitted regardless of run outcome (success, partial, failure). |
| F-011-R4 | `GET /sync/status` MUST return HTTP 200 even when zero runs have ever completed; the response in that case is `{"status": "no_runs_yet"}`. |
| F-011-R5 | `GET /sync/runs` MUST cap `limit` at 100; values above MUST be coerced to 100. |
| F-011-R6 | `GET /stats?period=<p>` MUST accept exactly the strings `day`, `week`, `month`. Any other value MUST return HTTP 400. |
| F-011-R7 | `match_rate` MUST be returned as a decimal in [0, 1] with 4 significant digits. |
| F-011-R8 | All read endpoints MUST execute in under 200 ms p95 against a `sync_runs` table containing 1000 rows. |
| F-011-R9 | Aggregate computations MUST run as single SQL queries; no N+1 patterns. |
| F-011-R10 | `lag_hours` MUST be a positive number rounded to one decimal place. |

## API contract

### `GET /sync/status`

```
HTTP/1.1 200 OK
Content-Type: application/json

{
  "run_id": "f7a3...",
  "status": "succeeded",
  "started_at": "2026-04-25T07:23:14.812Z",
  "finished_at": "2026-04-25T07:23:42.118Z",
  "duration_ms": 27306,
  "tracks_seen": 14,
  "matched_isrc": 11,
  "matched_fuzzy": 2,
  "unmatched": 1,
  "errors": 0,
  "last_succeeded_at": "2026-04-25T07:23:42.118Z",
  "lag_hours": 5.4
}
```

### `GET /sync/runs?limit=20`

```
HTTP/1.1 200 OK
Content-Type: application/json

{
  "runs": [
    { "run_id": "...", "status": "...", "started_at": "...", "finished_at": "...", "duration_ms": 0, "tracks_seen": 0, "matched_isrc": 0, "matched_fuzzy": 0, "unmatched": 0, "errors": 0 }
  ]
}
```

### `GET /stats?period=week`

```
HTTP/1.1 200 OK
Content-Type: application/json

{
  "period": "week",
  "from": "2026-04-18T00:00:00Z",
  "to": "2026-04-25T00:00:00Z",
  "runs_total": 14,
  "runs_succeeded": 13,
  "runs_partial": 1,
  "runs_failed": 0,
  "tracks_processed_total": 142,
  "match_rate": 0.9437,
  "match_rate_isrc": 0.7958,
  "match_rate_fuzzy": 0.1479,
  "unmatched_pending": 5
}
```

## Data effects

Read-only on `sync_runs`, `matches`, `unmatched`.

## Failure modes

| Mode | Cause | Recovery |
|---|---|---|
| Empty `sync_runs` table | First deployment | `GET /sync/status` returns `no_runs_yet` |
| Database unreachable | Neon outage | All endpoints return 503 |
| Aggregation slow | Large `sync_runs` table | Add appropriate indexes; F-011-R8 |

## Acceptance criteria

- All tests in T-011 pass
- A run completes and `GET /sync/status` returns its data immediately
- A request with an invalid `period` parameter returns 400
- All read endpoints respond well under 200 ms p95 against test data of 1000 rows
