# T-013: Captures API tests

Covers F-013.

---

## T-013-01: POST /captures requires JWT

**Type**: assertion

**Setup**: Worker deployed.

**Action**: `POST /captures` with no `Authorization` header and a valid body.

**Assertion**: Response status is 401.

**Pass**: TRUE if 401.

---

## T-013-02: Valid capture creates row

**Type**: assertion

**Setup**: Track row exists for `spotify_id = '3n3Ppam7vgaVa1iaRUc9Lp'`.

**Action**: `POST /captures` with body `{"spotify_id": "3n3Ppam7vgaVa1iaRUc9Lp", "source": "siri"}` and valid JWT.

**Assertion**: Response status is 201 AND a `captures` row exists with that spotify_id, `source = 'siri'`, and a generated `capture_id`.

**Pass**: TRUE if both hold.

---

## T-013-03: Missing spotify_id returns 400

**Type**: assertion

**Setup**: Worker deployed.

**Action**: `POST /captures` with body `{"source": "manual"}`.

**Assertion**: Response status is 400 AND body equals `{"error": "missing_spotify_id"}`.

**Pass**: TRUE if both hold.

---

## T-013-04: Malformed spotify_id returns 400

**Type**: assertion

**Setup**: Worker deployed.

**Action**: `POST /captures` with body `{"spotify_id": "not-a-real-id", "source": "manual"}`.

**Assertion**: Response status is 400.

**Pass**: TRUE if 400.

---

## T-013-05: Invalid source returns 400

**Type**: assertion

**Setup**: Worker deployed; valid spotify_id format.

**Action**: `POST /captures` with body `{"spotify_id": "3n3Ppam7vgaVa1iaRUc9Lp", "source": "telepathy"}`.

**Assertion**: Response status is 400.

**Pass**: TRUE if 400.

---

## T-013-06: Out-of-range latitude returns 400

**Type**: assertion

**Setup**: Worker deployed.

**Action**: `POST /captures` with body `{"spotify_id": "3n3Ppam7vgaVa1iaRUc9Lp", "source": "manual", "location_lat": 91.0, "location_lng": 0.0}`.

**Assertion**: Response status is 400.

**Pass**: TRUE if 400.

---

## T-013-07: Out-of-range longitude returns 400

**Type**: assertion

**Setup**: Worker deployed.

**Action**: `POST /captures` with `"location_lng": 200.0` and otherwise valid body.

**Assertion**: Response status is 400.

**Pass**: TRUE if 400.

---

## T-013-08: context_note over 500 chars returns 400

**Type**: assertion

**Setup**: Worker deployed.

**Action**: `POST /captures` with `context_note` of 501 characters.

**Assertion**: Response status is 400.

**Pass**: TRUE if 400.

---

## T-013-09: Unknown spotify_id triggers Spotify fetch

**Type**: assertion

**Setup**: `tracks` table empty. Mock Spotify GET track endpoint to return a valid track for `spotify_id = '3n3Ppam7vgaVa1iaRUc9Lp'`.

**Action**: `POST /captures` with that spotify_id.

**Assertion**: After the call, a `tracks` row exists for that spotify_id AND a `captures` row exists.

**Pass**: TRUE if both hold.

---

## T-013-10: Spotify fetch failure returns appropriate error

**Type**: assertion

**Setup**: `tracks` table empty. Mock Spotify GET track to return 404.

**Action**: `POST /captures` with the unknown spotify_id.

**Assertion**: Response status is 400 AND body contains `error = 'spotify_track_not_found'`.

**Pass**: TRUE if both hold.

---

## T-013-11: Capture does not trigger sync run

**Type**: metric

**Setup**: Instrument the orchestrator entry function to count invocations.

**Action**: `POST /captures` with valid body.

**Measurement**: Number of orchestrator invocations during the request.

**Pass**: metric value MUST equal 0.

---

## T-013-12: Duplicate within 60 s returns 200 with same id

**Type**: assertion

**Setup**: `POST /captures` with body B; record returned `capture_id = C1`.

**Action**: Within 30 s, `POST /captures` with the same body B again.

**Assertion**: Second response status is 200 (not 201) AND second response body's `capture_id` equals `C1`.

**Pass**: TRUE if both hold.

---

## T-013-13: Orphan tracks processed by next sync run

**Type**: assertion

**Setup**: Insert a `tracks` row for `X` with no entry in `matches` or `unmatched` (created via `POST /captures`). Configure F-006 mock to return a valid match.

**Action**: Run the orchestrator.

**Assertion**: After the run, a `matches` row exists for `X`.

**Pass**: TRUE if exists.

---

## T-013-14: GET /captures returns match_status correctly

**Type**: assertion

**Setup**: Insert 3 captures: one with a corresponding `matches` row, one with a pending `unmatched` row, one with neither.

**Action**: `GET /captures?limit=50` with valid JWT.

**Assertion**: The three returned items have `match_status` values `"matched"`, `"unmatched"`, `"pending"` respectively.

**Pass**: TRUE if all three correct.

---

## T-013-15: captured_at defaults to now() if omitted

**Type**: metric

**Setup**: Capture `T0 = now()` before the call.

**Action**: `POST /captures` with body that omits `captured_at`.

**Measurement**: `(captured_at - T0)` in seconds (read from the persisted row).

**Pass**: metric value MUST be in [0, 5] seconds.
