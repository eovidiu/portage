# T-009: Sync orchestration tests

Covers F-009.

---

## T-009-01: Run row created before any provider call

**Type**: assertion

**Setup**: Empty `sync_runs`. Instrument outbound HTTP to record first call timestamp; instrument DB to record `sync_runs` insert timestamp.

**Action**: Trigger the orchestrator.

**Assertion**: The `sync_runs` insert timestamp is `<=` the first outbound HTTP call timestamp.

**Pass**: TRUE if comparison holds.

---

## T-009-02: Successful run reaches succeeded status

**Type**: assertion

**Setup**: Mocks for F-005 through F-008 all return success; non-empty Liked Songs set.

**Action**: Trigger the orchestrator and wait for completion.

**Assertion**: The terminal `sync_runs` row has `status = 'succeeded'` AND `finished_at IS NOT NULL`.

**Pass**: TRUE if both hold.

---

## T-009-03: Run counts populated correctly

**Type**: assertion

**Setup**: 10 new tracks in Spotify mock; 7 match via ISRC, 2 via fuzzy, 1 unmatched, 0 errors.

**Action**: Run end to end.

**Assertion**: The `sync_runs` row has `tracks_seen = 10`, `matched_isrc = 7`, `matched_fuzzy = 2`, `unmatched = 1`, `errors = 0`.

**Pass**: TRUE if all five fields equal.

---

## T-009-04: Per-track error transitions to partial

**Type**: assertion

**Setup**: 5 new tracks; force one F-006 call to throw an unrecoverable per-track error.

**Action**: Run the orchestrator.

**Assertion**: The `sync_runs` row has `status = 'partial'` AND `errors >= 1`.

**Pass**: TRUE if both hold.

---

## T-009-05: F-005 hard failure marks run failed

**Type**: assertion

**Setup**: Spotify token cannot be refreshed (mock returns invalid_grant on refresh).

**Action**: Run the orchestrator.

**Assertion**: The `sync_runs` row has `status = 'failed'` AND `error_code = 'spotify_reauth_required'`.

**Pass**: TRUE if both hold.

---

## T-009-06: Concurrent invocation skipped

**Type**: assertion

**Setup**: Hold the Postgres advisory lock manually from a separate session before starting the orchestrator.

**Action**: Trigger the orchestrator.

**Assertion**: The orchestrator returns code `skipped_locked` AND no new `sync_runs` row is inserted AND a log line with `event = 'sync_skipped_locked'` is emitted.

**Pass**: TRUE if all three hold.

---

## T-009-07: Lock is released after success

**Type**: assertion

**Setup**: Run a successful orchestration. After completion, attempt to acquire the same advisory lock from a separate session.

**Action**: Issue `pg_try_advisory_lock(<key>)` from a separate session.

**Assertion**: The lock is acquired (returns true).

**Pass**: TRUE if acquired.

---

## T-009-08: Lock is released after exception

**Type**: assertion

**Setup**: Force F-007 to throw an unhandled exception. After the orchestrator unwinds, attempt to acquire the lock from a separate session.

**Action**: Trigger the orchestrator; after it terminates, try to acquire the lock.

**Assertion**: The lock is acquired.

**Pass**: TRUE if acquired.

---

## T-009-09: Abandoned run cleaned up

**Type**: assertion

**Setup**: Insert a `sync_runs` row with `status = 'running'` and `started_at = now() - interval '15 minutes'`. Lock is NOT held.

**Action**: Trigger a new orchestrator invocation.

**Assertion**: The abandoned row is updated to `status = 'failed'`, `error_code = 'abandoned'`. A new `sync_runs` row exists for the current run.

**Pass**: TRUE if both hold.

---

## T-009-10: Wall-time cap enforced

**Type**: metric

**Setup**: Mock Spotify and Tidal endpoints to introduce 0.5 s latency per call. Configure 1000 new tracks in the mock.

**Action**: Run the orchestrator. Record total wall time before the orchestrator returns.

**Measurement**: Wall time in seconds.

**Pass**: metric value MUST be ≤ 305 s (300 s cap plus 5 s grace).

---

## T-009-11: Wall-time cap reflected in run status

**Type**: assertion

**Setup**: Same as T-009-10.

**Action**: Run the orchestrator; inspect the row.

**Assertion**: The `sync_runs.status = 'partial'` AND `error_code = 'wall_time_exceeded'`.

**Pass**: TRUE if both hold.

---

## T-009-12: Idempotent re-run produces no duplicates

**Type**: assertion

**Setup**: Run the orchestrator end-to-end successfully. Capture row counts in `tracks`, `matches`, and unique playlist tracks.

**Action**: Run the orchestrator again immediately, with no new Spotify likes.

**Assertion**: After the second run, `tracks` count, `matches` count, and playlist track count are all unchanged.

**Pass**: TRUE if all three counts unchanged.

---

## T-009-13: F-008 failure does not delete matches

**Type**: assertion

**Setup**: 5 new tracks; F-006/F-007 succeed; F-008 returns HTTP 500 on every add-tracks call.

**Action**: Run the orchestrator.

**Assertion**: All 5 expected `matches` rows exist after the run.

**Pass**: TRUE if count == 5.

---

## T-009-14: Single completion log line

**Type**: metric

**Setup**: Run a successful orchestration. Capture log output.

**Action**: Inspect logs.

**Measurement**: Number of log lines with `event == 'sync_run_completed'` for that run id.

**Pass**: metric value MUST equal 1.

---

## T-009-15: Partial run persists per-track error_details (F-009-R12)

**Type**: behaviour

**Setup**: Mock `matchByIsrc` to return `{matched: 1, skipped: 0, errors: [{spotify_id: "spX", error_code: "tidal_429", message: "Second 429 received; track deferred to F-007"}]}`. Mock `matchByFuzzy` to return `{matched: 1, unmatched: 0, errors: []}`. Mock `writePlaylist` to succeed.

**Action**: Invoke `runSyncOnce()`.

**Assertion**:
- `sync_runs.status === 'partial'`
- `sync_runs.errors === 1`
- `sync_runs.error_details` is a JSONB array of length 1
- `error_details[0].error_code === 'tidal_429'`
- `error_details[0].spotify_id === 'spX'`
- `error_details[0].message` is a non-empty string

---

## T-009-16: Succeeded run leaves error_details NULL (F-009-R13)

**Type**: behaviour

**Setup**: Mock `matchByIsrc` and `matchByFuzzy` to return non-zero matches with empty `errors[]`. Mock `writePlaylist` to succeed.

**Action**: Invoke `runSyncOnce()`.

**Assertion**:
- `sync_runs.status === 'succeeded'`
- `sync_runs.errors === 0`
- `sync_runs.error_details IS NULL`

---

## T-009-17: error_details length matches errors count (F-009-R12 invariant)

**Type**: behaviour

**Setup**: Mock `matchByIsrc` to return two errors with distinct codes (`tidal_429` and `tidal_500`). Mock `matchByFuzzy` to return one error (`tidal_parse_error`). Total: three errors.

**Action**: Invoke `runSyncOnce()`.

**Assertion**:
- `sync_runs.errors === 3`
- `jsonb_array_length(sync_runs.error_details) === 3`
- The set of `error_code` values in the array equals `{'tidal_429', 'tidal_500', 'tidal_parse_error'}`
