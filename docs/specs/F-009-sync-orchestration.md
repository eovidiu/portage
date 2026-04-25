# F-009: Sync orchestration

## Summary

The orchestrator runs the full sync sequence: fetch from Spotify (F-005), match (F-006 then F-007), write to Tidal playlist (F-008), and record run statistics (F-011). It enforces a single-run lock, handles abandoned runs, and produces a structured outcome consumed by F-011 logging.

## Linked tests

[T-009](../tests/T-009-sync-orchestration.md)

## Dependencies

- F-005, F-006, F-007, F-008
- F-011 (logging consumes the orchestrator's output)
- Postgres `sync_runs` table

## Behavioural specification

### Successful run, end to end

- **Given** valid tokens for both providers and a non-empty new-likes set
- **When** the orchestrator runs
- **Then** it inserts a `sync_runs` row with `status = 'running'` and `started_at = now()`
- **And** acquires the run lock (Postgres advisory lock with key `sync_run_lock`)
- **And** invokes F-005 to fetch new tracks
- **And** invokes F-006 then F-007 for each new track
- **And** invokes F-008 to write the matched tracks to the Tidal playlist
- **And** updates the `sync_runs` row with counts and `status = 'succeeded'`, `finished_at = now()`
- **And** releases the run lock

### Run with partial errors

- **Given** some per-track errors (e.g., F-006 returned 5xx for individual tracks)
- **When** the orchestrator completes
- **Then** the `sync_runs` row is set to `status = 'partial'` if `errors > 0` AND `(matched_isrc + matched_fuzzy + unmatched) > 0`

### Run with hard failure before any progress

- **Given** the Spotify token cannot be refreshed
- **When** the orchestrator attempts F-005
- **Then** the `sync_runs` row is set to `status = 'failed'`, `finished_at = now()`, with `error_code = 'spotify_reauth_required'`

### Abandoned run cleanup

- **Given** a previous `sync_runs` row in `status = 'running'` whose `started_at` is more than 600 seconds ago
- **When** a new orchestrator invocation begins
- **Then** the orchestrator marks the abandoned row as `failed` with `error_code = 'abandoned'`
- **And** proceeds with the new run

### Concurrent invocation

- **Given** another orchestrator instance is already running
- **When** the second invocation tries to acquire the lock
- **Then** the lock acquisition fails immediately
- **And** the second invocation exits with `status = 'skipped_locked'` (logged but no `sync_runs` row created)

## Detailed requirements

| ID | Requirement |
|---|---|
| F-009-R1 | The orchestrator MUST acquire a Postgres advisory lock named `sync_run_lock` (a deterministic 64-bit integer key) at the start of every run. |
| F-009-R2 | If the lock cannot be acquired immediately, the orchestrator MUST exit with code `skipped_locked` and emit a log line; it MUST NOT create a `sync_runs` row. |
| F-009-R3 | A `sync_runs` row MUST be created before any provider API call. |
| F-009-R4 | The orchestrator MUST honour a hard wall-time cap of 300 seconds; on hitting the cap, it MUST update the run row to `status = 'partial'` with `error_code = 'wall_time_exceeded'`. |
| F-009-R5 | An abandoned run (>600s since `started_at`, status still `running`) MUST be transitioned to `failed` by the next orchestrator invocation. |
| F-009-R6 | Per-track errors in F-006/F-007 MUST NOT abort the run; they MUST be counted and the next track MUST proceed. |
| F-009-R7 | A failure in F-005 (fetch) MUST abort the run before matching begins. |
| F-009-R8 | A failure in F-008 (playlist write) MUST NOT delete or alter the matches that were created in this run. |
| F-009-R9 | The orchestrator MUST be idempotent at the run level: re-running the orchestrator after a failure MUST NOT cause duplicate `tracks` rows, duplicate `matches` rows, or duplicate playlist entries. |
| F-009-R10 | The orchestrator MUST emit one structured log line on completion summarising the run (consumed by F-011). |
| F-009-R11 | The lock MUST be released in a finally block; lock leaks MUST NOT occur on exceptions. |

## State machine

The `sync_runs.status` state machine is defined in `architecture.md` §8.1.

## Data effects

- Inserts one `sync_runs` row per attempted run (except `skipped_locked`)
- Drives all downstream data effects (via F-005 through F-008)

## Failure modes

| Mode | Cause | Recovery |
|---|---|---|
| `skipped_locked` | Concurrent run | Next scheduled run will pick up |
| `abandoned` | Worker died mid-run | Next run cleans up the orphan and proceeds |
| `wall_time_exceeded` | Very large catch-up batch | Next run continues from cursor |
| `spotify_reauth_required` | Spotify token unrecoverable | Operator runs `GET /auth/spotify` |
| `tidal_reauth_required` | Tidal token unrecoverable | Operator runs `GET /auth/tidal` |

## Acceptance criteria

- All tests in T-009 pass
- An end-to-end run on a synthetic dataset produces correct counts in the `sync_runs` row
- Killing the worker mid-run leaves the database in a recoverable state; the next run completes successfully
- Two concurrent invocations: one runs, the other exits cleanly with no `sync_runs` row
