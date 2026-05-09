# T-018: Multi-playlist Tidal write tests

Covers F-018.

---

## T-018-01: writePlaylist(env, '__liked__', knownTidalId) writes unsynced matches

**Type**: assertion

**Setup**: Mock `selectUnsyncedMatchesForPlaylist` to return 3 rows: `(t1, td1), (t2, td2), (t3, td3)`. Mock `addTracksToPlaylist` to return `{ added: 3, errors: 0, invalidIds: [] }`. Mock `markMembershipSynced` and `setTidalPlaylistId`.

**Action**: `writePlaylist(env, '__liked__', 'tidal-known')`.

**Assertion**: `addTracksToPlaylist` called with playlist id `'tidal-known'` and tidal ids `['td1','td2','td3']`. `markMembershipSynced` called with `('__liked__', ['t1','t2','t3'], <ISO timestamp>)`. `createPlaylist` NOT called. `setTidalPlaylistId` NOT called. Result has `added: 3, errors: 0, invalidIds: []`.

**Pass**: TRUE.

---

## T-018-02: writePlaylist with empty unsynced matches short-circuits

**Type**: assertion

**Setup**: `selectUnsyncedMatchesForPlaylist` returns `[]`.

**Action**: `writePlaylist(env, '__liked__', 'tidal-known')`.

**Assertion**: `addTracksToPlaylist` NOT called. `markMembershipSynced` NOT called. Result has `added: 0`.

**Pass**: TRUE.

---

## T-018-03: writePlaylist auto-creates Tidal playlist when tidalPlaylistId is null

**Type**: assertion

**Setup**: Mock `getPlaylistConfig(sql, 'abc123')` to return `{ spotify_name: 'Workout', tidal_playlist_id: null, ... }`. Mock `createPlaylist(env, 'Workout')` to return `'tidal-new'`. Mock `setTidalPlaylistId`. `selectUnsyncedMatchesForPlaylist` returns `[]`.

**Action**: `writePlaylist(env, 'abc123', null)`.

**Assertion**: `createPlaylist` called with `(env, 'Workout')`. `setTidalPlaylistId` called with `(sql, 'abc123', 'tidal-new')`. A `playlist_created_for_config` log line emitted.

**Pass**: TRUE.

---

## T-018-04: writePlaylist looks up tidal_playlist_id from playlist_configs when caller passes null

**Type**: assertion

**Setup**: `getPlaylistConfig(sql, 'abc123')` returns `{ tidal_playlist_id: 'tidal-existing', spotify_name: 'Workout' }`. `selectUnsyncedMatchesForPlaylist` returns 1 row.

**Action**: `writePlaylist(env, 'abc123', null)`.

**Assertion**: `createPlaylist` NOT called. `addTracksToPlaylist` called with `'tidal-existing'`.

**Pass**: TRUE.

---

## T-018-05: writePlaylist marks synced only for non-invalid Tidal ids

**Type**: assertion

**Setup**: `selectUnsyncedMatchesForPlaylist` returns `[(t1, td1), (t2, td2-bad), (t3, td3)]`. `addTracksToPlaylist` returns `{ added: 2, errors: 1, invalidIds: ['td2-bad'] }`.

**Action**: `writePlaylist(env, '__liked__', 'tidal-known')`.

**Assertion**: `markMembershipSynced` called with `('__liked__', ['t1', 't3'], <ts>)` — `t2` (the spotify track for the invalid Tidal id) NOT included. `flagInvalidTidalId(sql, 'td2-bad')` called. `requeueForInvalidTidalId(sql, 't2')` called.

**Pass**: TRUE.

---

## T-018-06: writePlaylist does NOT touch sync_state.last_playlist_write_at

**Type**: assertion

**Setup**: Spy on `writeState`. `selectUnsyncedMatchesForPlaylist` returns 1 row. Successful write.

**Action**: `writePlaylist(env, '__liked__', 'tidal-known')`.

**Assertion**: No `writeState` call has key `'last_playlist_write_at'`. The legacy watermark stays untouched.

**Pass**: TRUE.

---

## T-018-07: writePlaylist recreates Tidal playlist when getPlaylist returns null

**Type**: assertion

**Setup**: `getPlaylistConfig(sql, '__liked__')` returns `{ tidal_playlist_id: 'tidal-stale', spotify_name: 'Spotify Liked' }`. `getPlaylist(env, 'tidal-stale')` returns null. `createPlaylist(env, 'Spotify Liked')` returns `'tidal-fresh'`. `selectUnsyncedMatchesForPlaylist` returns `[]`.

**Action**: `writePlaylist(env, '__liked__', null)` (caller passes null; lookup finds the stale id).

**Assertion**: `createPlaylist` called. `setTidalPlaylistId` called with `('__liked__', 'tidal-fresh')`. A `playlist_recreated` log line emitted with `previous_id: 'tidal-stale'`, `new_id: 'tidal-fresh'`.

**Pass**: TRUE.

---

## T-018-08: writePlaylist with all-invalid result does not mark anything synced

**Type**: assertion

**Setup**: `addTracksToPlaylist` returns `{ added: 0, errors: 0, invalidIds: ['td1', 'td2'] }`.

**Action**: `writePlaylist(env, '__liked__', 'tidal-known')`.

**Assertion**: `markMembershipSynced` NOT called (or called with empty array — both acceptable). Both invalid ids passed to `flagInvalidTidalId`.

**Pass**: TRUE.

---

## T-018-09: writePlaylist returns backward-compatible PlaylistWriteResult shape

**Type**: assertion

**Setup**: Successful write, 3 added, 0 errors, 0 invalidIds.

**Action**: `writePlaylist(env, '__liked__', 'tidal-known')`.

**Assertion**: Result keys are exactly `playlistId, added, skippedDuplicates, invalidIds, errors`. `playlistId === 'tidal-known'`. `skippedDuplicates === 0`.

**Pass**: TRUE.

---

## T-018-10: writePlaylist legacy single-argument call site works during transition

**Type**: assertion

**Setup**: `getPlaylistConfig(sql, '__liked__')` returns `{ tidal_playlist_id: 'tidal-known', spotify_name: 'Spotify Liked' }`. Successful write.

**Action**: `writePlaylist(env)` — call with no spotifyPlaylistId, no tidalPlaylistId (defaults to `('__liked__', null)`).

**Assertion**: Behaves identically to T-018-04 outcome (uses `tidal-known` from playlist_configs lookup, writes successfully, marks membership synced).

**Pass**: TRUE.

---

## T-018-11: emits playlist_write_completed log line with spotify_playlist_id

**Type**: assertion

**Setup**: Successful write, 3 added.

**Action**: `writePlaylist(env, 'abc123', 'tidal-known')`. Spy on `console.log`.

**Assertion**: One `console.log` call with JSON containing `event: "playlist_write_completed"`, `spotify_playlist_id: "abc123"`, `tidal_playlist_id: "tidal-known"`, `added: 3`.

**Pass**: TRUE.
