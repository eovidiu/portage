# T-011: Sync logging and metrics tests

Covers F-011.

---

## T-011-01: Completion log line is valid JSON

**Type**: assertion

**Setup**: Run a successful orchestration; capture log output.

**Action**: Find the line with `event == 'sync_run_completed'`; attempt JSON.parse.

**Assertion**: Parse succeeds AND result is a single JSON object on a single line.

**Pass**: TRUE if both hold.

---

## T-011-02: Completion log fields complete

**Type**: assertion

**Setup**: Same as T-011-01.

**Action**: Inspect the parsed log object.

**Assertion**: It contains all of: `run_id`, `status`, `tracks_seen`, `matched_isrc`, `matched_fuzzy`, `unmatched`, `errors`, `duration_ms`.

**Pass**: TRUE if all keys present.

---

## T-011-03: error_code field present on non-success

**Type**: assertion

**Setup**: Force a `failed` run via Spotify reauth-required.

**Action**: Capture log and parse the completion line.

**Assertion**: The parsed object contains `error_code = 'spotify_reauth_required'`.

**Pass**: TRUE if equal.

---

## T-011-04: No secrets in completion log

**Type**: assertion

**Setup**: Configure all secrets and tokens with canary substrings (`SECRET_CANARY`, `TOKEN_CANARY`). Capture log output across a full run.

**Action**: Inspect every emitted log line.

**Assertion**: No log line contains either canary substring.

**Pass**: TRUE if no matches found.

---

## T-011-05: GET /sync/status returns latest run

**Type**: assertion

**Setup**: Insert two `sync_runs` rows; the second has `started_at` later than the first.

**Action**: `GET /sync/status` with valid JWT.

**Assertion**: Response `run_id` equals the second row's id.

**Pass**: TRUE if equal.

---

## T-011-06: GET /sync/status returns no_runs_yet on empty table

**Type**: assertion

**Setup**: Truncate `sync_runs`.

**Action**: `GET /sync/status` with valid JWT.

**Assertion**: Response status is 200 AND body equals `{"status": "no_runs_yet"}`.

**Pass**: TRUE if both hold.

---

## T-011-07: lag_hours computed correctly

**Type**: metric

**Setup**: Insert one succeeded run with `finished_at = now() - interval '5 hours 24 minutes'`.

**Action**: `GET /sync/status`; parse `lag_hours`.

**Measurement**: Returned `lag_hours` value.

**Pass**: metric value MUST be in [5.3, 5.5] (rounded to 1 decimal).

---

## T-011-08: GET /sync/runs respects limit

**Type**: metric

**Setup**: Insert 50 `sync_runs` rows.

**Action**: `GET /sync/runs?limit=10` with valid JWT.

**Measurement**: Number of items in `runs` array of the response.

**Pass**: metric value MUST equal 10.

---

## T-011-09: GET /sync/runs caps limit at 100

**Type**: metric

**Setup**: Insert 200 `sync_runs` rows.

**Action**: `GET /sync/runs?limit=500`.

**Measurement**: Number of items returned.

**Pass**: metric value MUST equal 100.

---

## T-011-10: GET /stats?period=week returns correct totals

**Type**: assertion

**Setup**: Insert 10 succeeded, 2 partial, 1 failed runs all within the last 7 days; add 5 more runs older than 7 days.

**Action**: `GET /stats?period=week`.

**Assertion**: Response has `runs_total = 13`, `runs_succeeded = 10`, `runs_partial = 2`, `runs_failed = 1`.

**Pass**: TRUE if all four equal.

---

## T-011-11: GET /stats with invalid period returns 400

**Type**: assertion

**Setup**: Worker deployed.

**Action**: `GET /stats?period=fortnight` with valid JWT.

**Assertion**: Response status is 400.

**Pass**: TRUE if 400.

---

## T-011-12: match_rate format

**Type**: assertion

**Setup**: Insert runs totalling 100 tracks processed and 87 matched.

**Action**: `GET /stats?period=week`; inspect `match_rate`.

**Assertion**: Returned value equals 0.87 (4 significant digits, decimal in [0, 1]).

**Pass**: TRUE if equal.

---

## T-011-13: Read endpoint p95 latency

**Type**: metric

**Setup**: Pre-populate `sync_runs` with 1000 rows. Local `wrangler dev`.

**Action**: Issue 200 sequential `GET /sync/status` requests; record server-side response time.

**Measurement**: p95 of recorded times, in milliseconds.

**Pass**: metric value MUST be < 200 ms.

---

## T-011-14: unmatched_pending counts only pending

**Type**: assertion

**Setup**: Insert 5 `unmatched` rows: 3 with `status = 'pending'`, 1 `matched`, 1 `skipped`.

**Action**: `GET /stats?period=week`.

**Assertion**: `unmatched_pending` equals 3.

**Pass**: TRUE if equal.
