# T-008: Tidal playlist write tests

Covers F-008.

---

## T-008-01: Playlist created on first run

**Type**: assertion

**Setup**: `sync_state.tidal_playlist_id` unset. Mock Tidal create-playlist endpoint to return `{id: "PLAYLIST_X"}`.

**Action**: Run the writer.

**Assertion**: After the run, `sync_state` contains `key = 'tidal_playlist_id'` with `value = 'PLAYLIST_X'`.

**Pass**: TRUE if equal.

---

## T-008-02: Playlist created with correct title

**Type**: assertion

**Setup**: `TIDAL_PLAYLIST_TITLE = 'Spotify Liked'`. Spy on the create-playlist request body.

**Action**: Run the writer on a fresh state.

**Assertion**: The request body contains a `title` field equal to `"Spotify Liked"`.

**Pass**: TRUE if equal.

---

## T-008-03: Playlist created as private

**Type**: assertion

**Setup**: Spy on create-playlist request body.

**Action**: Run the writer on a fresh state.

**Assertion**: The `attributes.accessType` field in the request body equals `"UNLISTED"` (per F-008-R3 amendment; Tidal Open API v2's accessType enum is `[PUBLIC, UNLISTED]` only — no `PRIVATE` value).

**Pass**: TRUE if equal.

---

## T-008-04: Existing playlist reused

**Type**: metric

**Setup**: `sync_state.tidal_playlist_id = 'PLAYLIST_X'`. Mock Tidal get-playlist endpoint to return 200 with the playlist intact. Instrument create-playlist call count.

**Action**: Run the writer.

**Measurement**: Number of create-playlist calls observed.

**Pass**: metric value MUST equal 0.

---

## T-008-05: Missing playlist triggers recreate

**Type**: assertion

**Setup**: `sync_state.tidal_playlist_id = 'OLD'`. Mock get-playlist to return 404. Mock create to return `{id: "NEW"}`.

**Action**: Run the writer.

**Assertion**: After the run, `sync_state.tidal_playlist_id = 'NEW'` AND a log line with `event = 'playlist_recreated'` includes both `'OLD'` and `'NEW'`.

**Pass**: TRUE if both hold.

---

## T-008-06: New matches appended

**Type**: assertion

**Setup**: 5 `matches` rows with `matched_at` after `sync_state.last_playlist_write_at`. Existing playlist has 0 tracks. Spy on the add-tracks request body.

**Action**: Run the writer.

**Assertion**: Exactly the 5 `tidal_id` values are sent in the add-tracks request, in ascending `matched_at` order.

**Pass**: TRUE if both order and set match.

---

## T-008-07: Already-present tracks not re-added

**Type**: assertion

**Setup**: Existing playlist contains tidal ids `['T1', 'T2']`. New matches have `tidal_id` in `['T1', 'T3', 'T4']`. Spy on add-tracks payload.

**Action**: Run the writer.

**Assertion**: The add-tracks payload contains only `['T3', 'T4']`.

**Pass**: TRUE if exact match.

---

## T-008-08: No matches yields zero writes

**Type**: metric

**Setup**: All `matches` rows have `matched_at <= sync_state.last_playlist_write_at`. Instrument add-tracks call count.

**Action**: Run the writer.

**Measurement**: Number of add-tracks calls observed.

**Pass**: metric value MUST equal 0.

---

## T-008-09: Batch size respects configured limit

**Type**: metric

**Setup**: `BATCH_SIZE = 50`. 120 new matches. Capture per-batch payload sizes.

**Action**: Run the writer.

**Measurement**: Maximum number of track ids sent in any single add-tracks request.

**Pass**: metric value MUST be ≤ 50.

---

## T-008-10: Idempotent on partial failure

**Type**: assertion

**Setup**: 10 new matches. Mock add-tracks to succeed for batch 1 (5 tracks) and return HTTP 500 for batch 2 (5 tracks). After failure, reset the mock to succeed; then re-run the writer.

**Action**: Run the writer twice as described.

**Assertion**: After both runs, the playlist contains exactly the 10 tracks, no duplicates, in the expected `matched_at` order.

**Pass**: TRUE if all hold.

---

## T-008-11: 401 triggers refresh and retry

**Type**: metric

**Setup**: 1 new match. Mock add-tracks returns 401 once, then 200. Instrument target endpoint.

**Action**: Run the writer.

**Measurement**: Number of add-tracks calls observed (refresh excluded).

**Pass**: metric value MUST equal 2.

---

## T-008-12: Invalid Tidal id flagged and re-queued

**Type**: assertion

**Setup**: 1 new match where the `tidal_id` no longer exists. Mock add-tracks returns an "invalid track" error specifically for that id.

**Action**: Run the writer.

**Assertion**: `matches.tidal_id_invalid = true` for that row AND an `unmatched` row exists for the corresponding spotify_id with `reason = 'tidal_track_removed'` and `status = 'pending'`.

**Pass**: TRUE if all hold.

---

## T-008-13: last_playlist_write_at advanced after success

**Type**: assertion

**Setup**: Capture `T0 = now()` before the run. Run a successful writer pass.

**Action**: Read `sync_state.last_playlist_write_at`.

**Assertion**: The stored timestamp is `>= T0`.

**Pass**: TRUE if comparison holds.

---

## T-008-14: No removals during normal sync

**Type**: metric

**Setup**: Existing playlist contains tracks not in `matches`. Instrument any remove-from-playlist calls.

**Action**: Run the writer.

**Measurement**: Number of remove-from-playlist calls.

**Pass**: metric value MUST equal 0.
