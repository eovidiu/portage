# T-012: Unmatched queue tests

Covers F-012.

---

## T-012-01: GET /unmatched requires JWT

**Type**: assertion

**Setup**: Worker deployed.

**Action**: `GET /unmatched` with no `Authorization` header.

**Assertion**: Response status is 401.

**Pass**: TRUE if 401.

---

## T-012-02: GET /unmatched returns pending rows

**Type**: assertion

**Setup**: Insert 3 `unmatched` rows with `status = 'pending'` and 2 with `status = 'matched'`.

**Action**: `GET /unmatched?limit=20` with valid JWT.

**Assertion**: Response `items` array has length 3 AND all items have a corresponding pending row.

**Pass**: TRUE if both hold.

---

## T-012-03: GET /unmatched orders by last_attempt_at DESC

**Type**: assertion

**Setup**: Insert 3 pending rows with distinct `last_attempt_at` timestamps `T1 < T2 < T3`.

**Action**: `GET /unmatched`.

**Assertion**: The returned items are ordered with the row corresponding to `T3` first.

**Pass**: TRUE if order is descending by last_attempt_at.

---

## T-012-04: Each item includes top 5 candidates

**Type**: metric

**Setup**: Insert 1 pending row. Mock Tidal search to return at least 5 candidates.

**Action**: `GET /unmatched?limit=20`.

**Measurement**: Length of the `candidates` array on the single returned item.

**Pass**: metric value MUST be ≤ 5 AND ≥ 1.

---

## T-012-05: Limit cap enforced at 100

**Type**: metric

**Setup**: Insert 150 pending rows.

**Action**: `GET /unmatched?limit=500`.

**Measurement**: Length of `items` array.

**Pass**: metric value MUST equal 100.

---

## T-012-06: Candidate fetch timeout returns partial response

**Type**: assertion

**Setup**: Insert 5 pending rows. Mock Tidal search to introduce 5 s latency per call.

**Action**: `GET /unmatched`.

**Assertion**: Response status is 200 AND at least one item has `candidates = []` AND total response time is `<= 11 s`.

**Pass**: TRUE if all hold.

---

## T-012-07: Manual match writes matches row

**Type**: assertion

**Setup**: Insert 1 pending row for spotify_id `X`. Mock Tidal track-by-id endpoint to return 200 for `tidal_id = "TX"`.

**Action**: `POST /unmatched/X/match` with body `{"tidal_id": "TX"}` and valid JWT.

**Assertion**: A `matches` row exists with `spotify_id = 'X'`, `tidal_id = 'TX'`, `method = 'manual'`, `confidence = 1.00`, `sync_run_id IS NULL` AND the `unmatched` row has `status = 'matched'`.

**Pass**: TRUE if all hold.

---

## T-012-08: Manual match validates Tidal id existence

**Type**: assertion

**Setup**: Insert pending row. Mock Tidal track-by-id to return 404 for `tidal_id = "NOPE"`.

**Action**: `POST /unmatched/X/match` with body `{"tidal_id": "NOPE"}`.

**Assertion**: Response status is 400 AND body contains `error = 'tidal_track_not_found'` AND no `matches` row was inserted AND the `unmatched.status` remains `pending`.

**Pass**: TRUE if all hold.

---

## T-012-09: Match validates request body schema

**Type**: assertion

**Setup**: Insert pending row.

**Action**: `POST /unmatched/X/match` with body `{}`.

**Assertion**: Response status is 400.

**Pass**: TRUE if 400.

---

## T-012-10: Match transition is atomic

**Type**: assertion

**Setup**: Insert pending row. Force the `matches` insert to throw after the `unmatched` update has been written in the same transaction (use a savepoint and a forced error).

**Action**: `POST /unmatched/X/match`.

**Assertion**: After the failed call, no `matches` row exists for `X` AND the `unmatched.status` for `X` is still `pending`.

**Pass**: TRUE if both hold.

---

## T-012-11: Skip transitions to skipped

**Type**: assertion

**Setup**: Insert pending row for spotify_id `X`.

**Action**: `POST /unmatched/X/skip` with valid JWT.

**Assertion**: Response status is 200 AND `unmatched.status` for `X` equals `'skipped'`.

**Pass**: TRUE if both hold.

---

## T-012-12: Skip is idempotent

**Type**: assertion

**Setup**: Insert row with `status = 'skipped'`.

**Action**: `POST /unmatched/X/skip` again.

**Assertion**: Response status is 200 AND no row mutations occurred (compare row's `last_attempt_at` before/after).

**Pass**: TRUE if both hold.

---

## T-012-13: Skipped rows excluded from re-evaluation

**Type**: metric

**Setup**: Insert 5 `unmatched` rows: 3 pending older than 7 days, 2 skipped older than 7 days. Instrument F-007 to count invocations on these spotify_ids during a sync run.

**Action**: Run the orchestrator.

**Measurement**: Number of fuzzy-match invocations on the 2 skipped rows.

**Pass**: metric value MUST equal 0.

---

## T-012-14: Aged pending rows re-evaluated

**Type**: metric

**Setup**: Insert 4 pending rows with `last_attempt_at = now() - interval '8 days'`.

**Action**: Run the orchestrator. Instrument F-007 invocations on those spotify_ids.

**Measurement**: Number of fuzzy-match invocations on the 4 aged pending rows.

**Pass**: metric value MUST equal 4.
