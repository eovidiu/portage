# T-005: Liked Songs fetch tests

Covers F-005.

---

## T-005-01: Cold start fetches all tracks

**Type**: assertion

**Setup**: Truncate `tracks` and `sync_state`. Mock Spotify `/v1/me/tracks` to return 73 saved tracks across pages of 50.

**Action**: Run the fetch module.

**Assertion**: `tracks` row count equals 73.

**Pass**: TRUE if count == 73.

---

## T-005-02: Cold start advances cursor

**Type**: assertion

**Setup**: Same as T-005-01. The most recent `added_at` in the mock is `2026-04-25T07:00:00Z`.

**Action**: Run the fetch module.

**Assertion**: `sync_state` row for `key = 'spotify_cursor'` exists with `value = '2026-04-25T07:00:00Z'`.

**Pass**: TRUE if exact match.

---

## T-005-03: Incremental fetch returns only new tracks

**Type**: assertion

**Setup**: Pre-populate `tracks` with 50 rows. Set cursor to the highest `added_at` among them. Mock Spotify to return 50 known plus 5 new tracks ordered `added_at DESC`.

**Action**: Run the fetch module.

**Assertion**: `tracks` row count equals 55.

**Pass**: TRUE if count == 55.

---

## T-005-04: Incremental fetch stops paginating early

**Type**: metric

**Setup**: Same as T-005-03 but spread the 50 known tracks across 10 pages (the new tracks are on page 1). Instrument the mock to count pagination requests.

**Action**: Run the fetch.

**Measurement**: Total pagination requests issued.

**Pass**: metric value MUST equal 1.

---

## T-005-05: Repeated runs produce no duplicates

**Type**: assertion

**Setup**: Pre-populate `tracks` with 100 rows; cursor set correctly.

**Action**: Run the fetch module twice in succession with no new tracks in the mock.

**Assertion**: `tracks` row count remains 100 after both runs.

**Pass**: TRUE if count == 100.

---

## T-005-06: Cursor unchanged on partial failure

**Type**: assertion

**Setup**: Mock Spotify to return page 1 successfully then return HTTP 500 on page 2. Cursor before run is `T0`.

**Action**: Run the fetch module; expect failure.

**Assertion**: `sync_state.spotify_cursor` after the run still equals `T0`.

**Pass**: TRUE if value unchanged.

---

## T-005-07: Local tracks are skipped

**Type**: assertion

**Setup**: Mock Spotify to return 5 saved items where `track.is_local === true` and 3 with `is_local === false`.

**Action**: Run the fetch.

**Assertion**: `tracks` row count equals 3.

**Pass**: TRUE if count == 3.

---

## T-005-08: Non-track items are skipped

**Type**: assertion

**Setup**: Mock Spotify to return 2 items with `track.type === 'episode'` mixed with 4 normal tracks.

**Action**: Run the fetch.

**Assertion**: `tracks` row count equals 4.

**Pass**: TRUE if count == 4.

---

## T-005-09: ISRC is captured when present

**Type**: assertion

**Setup**: Mock returns one track with `external_ids.isrc = 'GBUM71029604'`.

**Action**: Run the fetch.

**Assertion**: The `tracks` row for that spotify_id has `isrc = 'GBUM71029604'`.

**Pass**: TRUE if equal.

---

## T-005-10: Missing ISRC stored as NULL

**Type**: assertion

**Setup**: Mock returns one track with no `external_ids`.

**Action**: Run the fetch.

**Assertion**: The `tracks` row has `isrc IS NULL`.

**Pass**: TRUE if NULL.

---

## T-005-11: Spotify 429 honours Retry-After

**Type**: metric

**Setup**: Mock Spotify to return HTTP 429 with `Retry-After: 2` on the first page, then 200 with data on retry. Capture timestamps.

**Action**: Run the fetch.

**Measurement**: Wall time between the 429 response and the retry request, in seconds.

**Pass**: metric value MUST be ≥ 2.0 AND ≤ 3.0.

---

## T-005-12: Second 429 fails the run

**Type**: assertion

**Setup**: Mock Spotify to return HTTP 429 twice in a row.

**Action**: Run the fetch.

**Assertion**: The run terminates with a failure status; `sync_state.spotify_cursor` is unchanged.

**Pass**: TRUE if both hold.

---

## T-005-13: spotify_added_at uses envelope value

**Type**: assertion

**Setup**: Mock returns a saved item where the envelope `added_at = '2026-04-25T10:00:00Z'` and the inner `track.album.release_date = '1985-01-01'`.

**Action**: Run the fetch.

**Assertion**: The `tracks` row for that spotify_id has `spotify_added_at = '2026-04-25T10:00:00Z'`.

**Pass**: TRUE if equal.

---

## T-005-14: One log line per page

**Type**: metric

**Setup**: Mock returns 3 pages totalling 120 tracks. Capture log output.

**Action**: Run the fetch.

**Measurement**: Number of log lines with `event == 'fetch_page'`.

**Pass**: metric value MUST equal 3.
