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
| F-009-R12 | Per-track errors caught by F-006 (matchByIsrc) and F-007 (matchByFuzzy) MUST be persisted to `sync_runs.error_details` as a JSONB array of `{spotify_id, error_code, message}` records. The array length MUST equal `sync_runs.errors`. |
| F-009-R13 | `error_details` MUST be `NULL` for runs with `errors = 0` (succeeded runs and outer-fatal failed runs that never reached matching). |
| F-009-R14 | The `error_code` values inside `error_details[]` MUST be drawn from the closed set defined by F-006 and F-007: `tidal_429`, `tidal_<status>` (e.g. `tidal_404`, `tidal_500`), `tidal_error`, `tidal_parse_error`, `isrc_fatal`, `fuzzy_fatal`. |

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

## Amendment 2026-05-02 (F-015): per-invocation budgets

To fit within the Cloudflare Workers Free 50-subrequest cap, the orchestrator
imposes per-invocation budgets on every loop:

- **R10** — Each invocation MUST process at most `MATCH_BATCH_ISRC` tracks via
  the ISRC stage and at most `MATCH_BATCH_FUZZY` tracks via the fuzzy stage.
  Defaults are 5 each; operator overrides via env vars.
- **R11** — Each invocation MUST fetch at most `LIKED_PAGES_PER_RUN` Spotify
  pages (default 1). Mid-sweep state survives in `sync_state` per F-005-R12-R16.
- **R12** — Status `succeeded` means "this slice completed without errors".
  Pending queue depth (un-matched tracks remaining, mid-sweep resume URL set)
  is normal operational state and does NOT downgrade the run to `partial`.
  The `partial` status is reserved for `errors > 0 ∧ progress > 0` per the
  state machine in `architecture.md` §8.1.
- **R13** — Defaults can be overridden via Worker env vars:
  - `MATCH_BATCH_ISRC` — integer ≥1 (defaults to 5; invalid input ⇒ default)
  - `MATCH_BATCH_FUZZY` — integer ≥1 (defaults to 5; invalid input ⇒ default)
  - `LIKED_PAGES_PER_RUN` — integer ≥1 (defaults to 1; invalid input ⇒ default)

## Amendment 2026-05-03: per-track error_details persistence (R12-R14)

Phase 1 diagnostic audit (`.harness/diagnostics/phase1-partials-2026-05-03.md`)
established that ~5–7% of cron runs land as `partial` with `errors > 0`, but
the per-track error code and `spotify_id` are emitted only as `console.log`
JSON (24-hour retention via `wrangler tail`) and never persisted. This makes
intermittent partials undiagnosable from DB alone.

This amendment makes any partial run diagnosable from a single SQL query by
persisting the per-track failure detail to a new column.

- Adds R12 (persist), R13 (null discipline), R14 (closed code set).
- Adds column `sync_runs.error_details JSONB DEFAULT NULL`. Migration is
  purely additive; old rows remain `NULL`.
- Existing `errors` INT and `error_code` TEXT columns retained unchanged.
- T-009-15 / T-009-16 / T-009-17 added to gate the new persistence behaviour.

Diagnostic query post-deploy:

```sql
SELECT detail->>'error_code' AS code, COUNT(*) AS n
FROM sync_runs, jsonb_array_elements(error_details) AS detail
WHERE status = 'partial' AND started_at > NOW() - INTERVAL '7 days'
GROUP BY 1 ORDER BY 2 DESC;
```
