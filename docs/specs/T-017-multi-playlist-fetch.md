# T-017: Multi-playlist Spotify fetch + membership tests

Covers F-017.

---

## T-017-01: `playlist_membership` table schema

**Type**: assertion

**Setup**: Apply `db/schema.sql` to a fresh Neon branch.

**Action**: `SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_name = 'playlist_membership' ORDER BY ordinal_position;`

**Assertion**: Columns are exactly `spotify_playlist_id` (text, NOT NULL), `spotify_track_id` (text, NOT NULL), `added_at` (timestamptz, NOT NULL), `synced_at` (timestamptz, NULL). Composite PK is `(spotify_playlist_id, spotify_track_id)`.

**Pass**: TRUE if columns match exactly.

---

## T-017-02: `idx_membership_unsynced` partial index exists

**Type**: assertion

**Setup**: Fresh Neon branch with `db/schema.sql` applied.

**Action**: `SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'playlist_membership' AND indexname = 'idx_membership_unsynced';`

**Assertion**: Exactly one row. `indexdef` contains `WHERE (synced_at IS NULL)`.

**Pass**: TRUE.

---

## T-017-03: `keyForPlaylist` helper format

**Type**: assertion

**Setup**: Tests in `tests/db/sync_state.test.ts` (extended).

**Action**: Call `keyForPlaylist('cursor', 'abc123')`, `keyForPlaylist('resume_url', 'abc123')`, `keyForPlaylist('sweep_max', 'abc123')`.

**Assertion**: Returns `'playlist:abc123:cursor'`, `'playlist:abc123:resume_url'`, `'playlist:abc123:sweep_max'` respectively.

**Pass**: TRUE.

---

## T-017-04: `keyForPlaylist` special-cases `__liked__`

**Type**: assertion

**Setup**: Same as T-017-03.

**Action**: Call `keyForPlaylist('cursor', '__liked__')`, `keyForPlaylist('resume_url', '__liked__')`, `keyForPlaylist('sweep_max', '__liked__')`.

**Assertion**: Returns `'spotify_cursor'`, `'spotify_resume_url'`, `'spotify_sweep_max'` (the legacy flat keys F-005 already uses).

**Pass**: TRUE for all three.

---

## T-017-05: `upsertMembership` inserts a new row

**Type**: assertion

**Setup**: Empty `playlist_membership` table.

**Action**: `upsertMembership(sql, { spotify_playlist_id: 'abc123', spotify_track_id: 'track-1', added_at: '2026-05-09T10:00:00Z' })`.

**Assertion**: Row exists with `synced_at = NULL`.

**Pass**: TRUE.

---

## T-017-06: `upsertMembership` is idempotent (DO NOTHING semantics)

**Type**: assertion

**Setup**: Row already exists for `('abc123', 'track-1', '2026-05-09T10:00:00Z', NULL)`.

**Action**: Call `upsertMembership(sql, { spotify_playlist_id: 'abc123', spotify_track_id: 'track-1', added_at: '2026-05-09T11:00:00Z' })` again.

**Assertion**: One row only. `added_at` is preserved at `'2026-05-09T10:00:00Z'` (the original value). `synced_at` is preserved at `NULL`.

**Pass**: TRUE.

---

## T-017-07: `markMembershipSynced` flips `synced_at` for given track IDs

**Type**: assertion

**Setup**: Three rows in `playlist_membership` for `abc123`: `track-a`, `track-b`, `track-c`, all with `synced_at = NULL`.

**Action**: `markMembershipSynced(sql, 'abc123', ['track-a', 'track-c'], '2026-05-09T12:00:00Z')`.

**Assertion**: `track-a` and `track-c` have `synced_at = '2026-05-09T12:00:00Z'`. `track-b` has `synced_at = NULL`.

**Pass**: TRUE.

---

## T-017-08: `selectUnsyncedMatchesForPlaylist` returns only unsynced + matched + not-invalid

**Type**: assertion

**Setup**: 
- `tracks` has rows `t1, t2, t3, t4`.
- `matches` has: `(t1, tidal-1, ...)`, `(t2, tidal-2, ..., tidal_id_invalid=true)`, `(t3, tidal-3, ...)`. `t4` has no match.
- `playlist_membership` for `abc123` has: `t1` (synced_at=NULL), `t2` (synced_at=NULL), `t3` (synced_at='2026-05-08T00:00:00Z'), `t4` (synced_at=NULL).

**Action**: `selectUnsyncedMatchesForPlaylist(sql, 'abc123')`.

**Assertion**: Returns exactly `[{ spotify_track_id: 't1', tidal_id: 'tidal-1' }]`.
- `t2` excluded: `tidal_id_invalid = true`.
- `t3` excluded: `synced_at` is set.
- `t4` excluded: not in `matches`.

**Pass**: TRUE.

---

## T-017-09: `fetchPlaylistTracks` cold start fetches and persists

**Type**: assertion

**Setup**: Mock `spotifyFetch` to return one page of 3 tracks for `abc123`. Mock cursor read to return cold start.

**Action**: `fetchPlaylistTracks(env, 'abc123', 1)`.

**Assertion**: `spotifyFetch` called with URL `https://api.spotify.com/v1/playlists/abc123/tracks?limit=50`. The transaction includes 3 `tracks` upserts + 3 `playlist_membership` upserts + 3 `sync_state` writes (the per-playlist cursor keys). Result has `pagesProcessed: 1`, `tracksInserted: 3`.

**Pass**: TRUE.

---

## T-017-10: `fetchPlaylistTracks` cursor cutoff stops pagination early

**Type**: assertion

**Setup**: Mock cursor at `'2026-05-08T12:00:00Z'`. Mock first page returning items with `added_at` newer than cursor + items with `added_at` older.

**Action**: `fetchPlaylistTracks(env, 'abc123', 5)`.

**Assertion**: Only items with `added_at > cursor - 60s` are persisted. Pagination halts before processing additional pages once the cutoff is hit.

**Pass**: TRUE.

---

## T-017-11: `fetchPlaylistTracks` cursor and membership atomicity (extended I-005)

**Type**: assertion

**Setup**: Mock `db.transaction` to capture all queries passed in the sync-callback array form. Mock one page of 2 tracks.

**Action**: `fetchPlaylistTracks(env, 'abc123', 1)`.

**Assertion**: The `db.transaction` callback returns an array containing: 2 `tracks` upserts + 2 `playlist_membership` upserts + 3 `sync_state` writes (cursor, resume_url, sweep_max). All in one array — one atomic transaction.

**Pass**: TRUE.

---

## T-017-12: `fetchPlaylistTracks` voluntary mid-sweep stop persists resume_url

**Type**: assertion

**Setup**: Mock cursor at cold start. Mock first page returning 50 items, all newer than cursor, with `next` URL pointing to the second page.

**Action**: `fetchPlaylistTracks(env, 'abc123', 1)`.

**Assertion**: 
- After the call: `playlist:abc123:cursor` is unchanged (still cold start).
- `playlist:abc123:resume_url` is set to the captured `next` URL.
- `playlist:abc123:sweep_max` is set to the run's max `added_at`.
- Result has `morePagesPending: true`.

**Pass**: TRUE.

---

## T-017-13: `fetchPlaylistTracks` resumes from `resume_url` if set

**Type**: assertion

**Setup**: Mock `playlist:abc123:resume_url` set to `'https://api.spotify.com/v1/playlists/abc123/tracks?offset=50&limit=50'`. Mock `spotifyFetch` to return that exact URL's page.

**Action**: `fetchPlaylistTracks(env, 'abc123', 1)`.

**Assertion**: `spotifyFetch` called with the resume URL, NOT with the default `?limit=50` URL.

**Pass**: TRUE.

---

## T-017-14: `fetchPlaylistTracks` skips items with `track === null`

**Type**: assertion

**Setup**: Mock first page with 4 items: 2 valid tracks, 1 with `track: null`, 1 with `track.is_local: true`.

**Action**: `fetchPlaylistTracks(env, 'abc123', 1)`.

**Assertion**: Only 2 `tracks` upserts and 2 `playlist_membership` upserts. The skipped count in the result is 2.

**Pass**: TRUE.

---

## T-017-15: `fetchPlaylistTracks` honours Retry-After on 429

**Type**: assertion

**Setup**: Mock `spotifyFetch` to return 429 with `Retry-After: 1` first, then 200 with a normal page on retry. Use `vi.useFakeTimers()`.

**Action**: `fetchPlaylistTracks(env, 'abc123', 1)`.

**Assertion**: Pause of at least 1000ms between the first 429 and the retry. Retry succeeds with 200. Tracks persisted from the retry response.

**Pass**: TRUE.

---

## T-017-16: `fetchPlaylistTracks` aborts on second 429

**Type**: assertion

**Setup**: Mock `spotifyFetch` to return 429 twice (first call + retry).

**Action**: `fetchPlaylistTracks(env, 'abc123', 1)`.

**Assertion**: The function throws an Error whose message contains "429" or "rate limit".

**Pass**: TRUE.

---

## T-017-17: `fetchPlaylistTracks` URL has Verified marker

**Type**: assertion

**Setup**: Read `src/providers/spotify/playlists.ts` source.

**Action**: Search for `https://api.spotify.com/v1/playlists/{`-matching URL constant.

**Assertion**: The line above the URL constant declaration starts with `// Verified:` and references the Spotify developer-docs URL.

**Pass**: TRUE.

---

## T-017-18: Liked Songs membership write happens in orchestrator (no F-005 changes)

**Type**: assertion

**Setup**: Read `src/providers/spotify/liked.ts` source.

**Action**: Check that `fetchLikedSongs` body has NOT been modified to write `playlist_membership`.

**Assertion**: No reference to `playlist_membership` or `upsertMembership` in `liked.ts`. The membership write for `__liked__` is the orchestrator's responsibility (F-016b).

**Pass**: TRUE.

---

## T-017-19: One log line per page with `event = "fetch_page"` and `playlist_id`

**Type**: assertion

**Setup**: Mock 3 pages of items. Spy on `console.log`.

**Action**: `fetchPlaylistTracks(env, 'abc123', 3)`.

**Assertion**: Exactly 3 `console.log` calls with JSON containing `event: "fetch_page"` and `playlist_id: "abc123"`.

**Pass**: TRUE.
