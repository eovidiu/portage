# T-010: Scheduled execution tests

Covers F-010.

---

## T-010-01: Cron triggers declared correctly

**Type**: assertion

**Setup**: Inspect `wrangler.toml`.

**Action**: Parse the `[triggers]` section.

**Assertion**: The `crons` array equals exactly `["23 7 * * *", "23 19 * * *"]`.

**Pass**: TRUE if exact match.

---

## T-010-02: Scheduled handler invokes orchestrator

**Type**: assertion

**Setup**: Spy on the orchestrator entry function.

**Action**: Invoke the Worker's `scheduled` export programmatically with a mock `ScheduledEvent`.

**Assertion**: The orchestrator entry function is called exactly once.

**Pass**: TRUE if call count == 1.

---

## T-010-03: Scheduled handler awaits orchestrator completion

**Type**: assertion

**Setup**: Orchestrator mock returns a promise that resolves after 100 ms; capture the promise returned by `scheduled`.

**Action**: Invoke `scheduled`; await its returned value.

**Assertion**: At resolution time, the orchestrator's promise has already resolved (orchestrator completion timestamp <= scheduled handler completion timestamp).

**Pass**: TRUE if comparison holds.

---

## T-010-04: Skipped_locked logged but not raised

**Type**: assertion

**Setup**: Pre-acquire the orchestrator advisory lock.

**Action**: Invoke `scheduled`.

**Assertion**: The handler returns successfully (no exception thrown to Cloudflare runtime) AND a log line with `event = 'scheduled_skipped_locked'` was emitted.

**Pass**: TRUE if both hold.

---

## T-010-05: Orchestrator failure does not throw

**Type**: assertion

**Setup**: Force the orchestrator to throw a synthetic error.

**Action**: Invoke `scheduled`.

**Assertion**: The handler completes without re-throwing AND the error is logged with `event = 'scheduled_failed'`.

**Pass**: TRUE if both hold.

---

## T-010-06: Manual POST /sync/run requires JWT

**Type**: assertion

**Setup**: Worker deployed.

**Action**: `POST /sync/run` with no `Authorization` header.

**Assertion**: Response status is 401.

**Pass**: TRUE if 401.

---

## T-010-07: Synchronous response when run finishes within 25 s

**Type**: assertion

**Setup**: Mock orchestrator to complete in 1 s with a successful run.

**Action**: `POST /sync/run` with valid JWT.

**Assertion**: Response status is 200 AND body contains `run_id`, `status = "succeeded"`, and the count fields per F-010 contract.

**Pass**: TRUE if all conditions hold.

---

## T-010-08: 202 returned when run exceeds 25 s

**Type**: assertion

**Setup**: Mock orchestrator to take 35 s.

**Action**: `POST /sync/run` with valid JWT; record response time and body.

**Assertion**: Response status is 202 AND body equals `{"run_id": <uuid>, "status": "running"}` AND response time `<= 26 s`.

**Pass**: TRUE if all hold.

---

## T-010-09: 409 returned on lock contention

**Type**: assertion

**Setup**: Pre-acquire the orchestrator advisory lock from a separate session and insert a `sync_runs` row with `status = 'running'`.

**Action**: `POST /sync/run` with valid JWT.

**Assertion**: Response status is 409 AND body contains `error = "run_in_progress"` AND `current_run_id` matches the inserted row.

**Pass**: TRUE if all hold.

---

## T-010-10: Cursor catch-up after missed run

**Type**: assertion

**Setup**: Pre-populate cursor to time `T0`. Spotify mock has 5 likes added between `T0` and `T0 + 1h`, then 7 more between `T0 + 13h` and `T0 + 14h` (simulating one missed run).

**Action**: Run the orchestrator once.

**Assertion**: After the run, `tracks` contains 12 new rows AND `sync_state.spotify_cursor` advanced to the latest `added_at`.

**Pass**: TRUE if both hold.

---

## T-010-11: Manual run produces same row shape as scheduled

**Type**: assertion

**Setup**: Run a scheduled invocation; capture the resulting `sync_runs` row column set. Then trigger a manual `POST /sync/run`; capture the new row.

**Action**: Compare the two rows.

**Assertion**: The set of non-null column names is identical between the two rows (allowing different values).

**Pass**: TRUE if column set matches.
