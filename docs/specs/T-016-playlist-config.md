# T-016: Playlist config registry tests

Covers F-016.

---

## T-016-01: `playlist_configs` table schema

**Type**: assertion

**Setup**: Apply `db/schema.sql` to a fresh Neon branch.

**Action**: `SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_name = 'playlist_configs' ORDER BY ordinal_position;`

**Assertion**: Columns are exactly `spotify_playlist_id` (text, NOT NULL), `spotify_name` (text, NOT NULL), `tidal_playlist_id` (text, NULL), `created_at` (timestamptz, NOT NULL), `last_synced_at` (timestamptz, NULL). The PK is `spotify_playlist_id`.

**Pass**: TRUE if columns match exactly.

---

## T-016-02: `__liked__` row seeded by schema migration

**Type**: assertion

**Setup**: Fresh Neon branch with `db/schema.sql` applied.

**Action**: `SELECT spotify_playlist_id, spotify_name FROM playlist_configs WHERE spotify_playlist_id = '__liked__';`

**Assertion**: Exactly one row returned with `spotify_name = 'Spotify Liked'`.

**Pass**: TRUE if both hold.

---

## T-016-03: `upsertPlaylistConfig` inserts a new row

**Type**: assertion

**Setup**: Empty `playlist_configs` table (or one with only `__liked__`).

**Action**: Call `upsertPlaylistConfig(sql, { spotify_playlist_id: 'abc123', spotify_name: 'Workout' })`.

**Assertion**: The table now contains a row with `spotify_playlist_id = 'abc123'`, `spotify_name = 'Workout'`, `tidal_playlist_id IS NULL`, `created_at IS NOT NULL`.

**Pass**: TRUE if all hold.

---

## T-016-04: `upsertPlaylistConfig` updates `spotify_name` only

**Type**: assertion

**Setup**: A row exists for `abc123` with `spotify_name = 'Old'`, `tidal_playlist_id = 'tidal-xyz'`, `created_at = '2026-01-01T00:00:00Z'`.

**Action**: Call `upsertPlaylistConfig(sql, { spotify_playlist_id: 'abc123', spotify_name: 'New' })`.

**Assertion**: Row now has `spotify_name = 'New'`, but `tidal_playlist_id = 'tidal-xyz'` and `created_at = '2026-01-01T00:00:00Z'` (unchanged).

**Pass**: TRUE if all hold.

---

## T-016-05: `setTidalPlaylistId` writes the Tidal ID

**Type**: assertion

**Setup**: A row exists for `abc123` with `tidal_playlist_id IS NULL`.

**Action**: Call `setTidalPlaylistId(sql, 'abc123', 'tidal-99')`.

**Assertion**: `getPlaylistConfig(sql, 'abc123').tidal_playlist_id === 'tidal-99'`.

**Pass**: TRUE.

---

## T-016-06: `markSynced` updates `last_synced_at`

**Type**: assertion

**Setup**: A row exists for `abc123` with `last_synced_at IS NULL`.

**Action**: Call `markSynced(sql, 'abc123', '2026-05-08T10:00:00Z')`.

**Assertion**: `getPlaylistConfig(sql, 'abc123').last_synced_at` equals `2026-05-08T10:00:00Z`.

**Pass**: TRUE.

---

## T-016-07: `listPlaylistConfigs` returns all rows

**Type**: assertion

**Setup**: Three rows present: `__liked__`, `abc123`, `def456`.

**Action**: Call `listPlaylistConfigs(sql)`.

**Assertion**: Returns an array of length 3 containing rows for all three IDs (order unspecified).

**Pass**: TRUE.

---

## T-016-08: `fetchSpotifyPlaylistName` returns the name

**Type**: assertion

**Setup**: Mock `spotifyFetch` to return `Response` with status 200 and body `{"name":"Workout"}` for `https://api.spotify.com/v1/playlists/abc123?fields=name`.

**Action**: Call `fetchSpotifyPlaylistName(env, 'abc123')`.

**Assertion**: Return value === `'Workout'`. Exactly one `spotifyFetch` call with the expected URL.

**Pass**: TRUE.

---

## T-016-09: `fetchSpotifyPlaylistName` propagates 404

**Type**: assertion

**Setup**: Mock `spotifyFetch` to return status 404 for `abc123`.

**Action**: Call `fetchSpotifyPlaylistName(env, 'abc123')`.

**Assertion**: The call throws an error whose `.message` contains `'404'` AND/OR is an instance of a typed `PlaylistNotFoundError` (whichever the implementation chooses; T-016-09 just asserts the throw is observable to the caller).

**Pass**: TRUE if the call throws.

---

## T-016-10: `fetchSpotifyPlaylistName` falls back on empty `name`

**Type**: assertion

**Setup**: Mock `spotifyFetch` to return status 200 with body `{"name":""}` for `abc123`.

**Action**: Call `fetchSpotifyPlaylistName(env, 'abc123')`.

**Assertion**: Return value === `'Spotify Playlist abc123'`.

**Pass**: TRUE.

---

## T-016-11: Seeder seeds `__liked__` if absent

**Type**: assertion

**Setup**: `playlist_configs` is empty. `env.SPOTIFY_EXTRA_PLAYLIST_IDS` undefined.

**Action**: Call `seedPlaylistConfigs(env)`.

**Assertion**: After the call, exactly one row exists with `spotify_playlist_id = '__liked__'`. No `spotifyFetch` was called.

**Pass**: TRUE.

---

## T-016-12: Seeder upserts extras from env var

**Type**: assertion

**Setup**: Empty `playlist_configs`. `env.SPOTIFY_EXTRA_PLAYLIST_IDS = 'abc123,def456'`. Mock `spotifyFetch` to return `{name:"Workout"}` for `abc123` and `{name:"Roadtrip"}` for `def456`.

**Action**: Call `seedPlaylistConfigs(env)`.

**Assertion**: Three rows exist: `__liked__`, `abc123` (Workout), `def456` (Roadtrip). Exactly two `spotifyFetch` calls (one per extra).

**Pass**: TRUE.

---

## T-016-13: Seeder trims whitespace and skips empty entries

**Type**: assertion

**Setup**: Empty `playlist_configs`. `env.SPOTIFY_EXTRA_PLAYLIST_IDS = ' abc123 ,, def456 ,'`. Mock `spotifyFetch` to return names for `abc123` and `def456`.

**Action**: Call `seedPlaylistConfigs(env)`.

**Assertion**: Rows `__liked__`, `abc123`, `def456` (no empty-id row). `spotifyFetch` called exactly twice with the trimmed IDs.

**Pass**: TRUE.

---

## T-016-14: Seeder continues past a single fetch failure

**Type**: assertion

**Setup**: Empty `playlist_configs`. `env.SPOTIFY_EXTRA_PLAYLIST_IDS = 'badid,goodid'`. Mock `spotifyFetch` to return 404 for `badid` and `{name:"Good"}` for `goodid`.

**Action**: Call `seedPlaylistConfigs(env)`.

**Assertion**: After the call, rows `__liked__` and `goodid` exist; no row for `badid`. A structured log line was emitted with `event: "playlist_name_fetch_failed"` and `spotify_playlist_id: "badid"`.

**Pass**: TRUE.

---

## T-016-15: Seeder is idempotent on repeated invocations

**Type**: assertion

**Setup**: `env.SPOTIFY_EXTRA_PLAYLIST_IDS = 'abc123'`. Mock `spotifyFetch` to return `{name:"Workout"}`.

**Action**: Call `seedPlaylistConfigs(env)` twice in succession.

**Assertion**: After both calls, exactly two rows exist (`__liked__` + `abc123`). The second call may issue a name-fetch call (refresh semantics) but MUST NOT duplicate rows.

**Pass**: TRUE.

---

## T-016-16: Seeder refreshes a renamed extra without touching `tidal_playlist_id`

**Type**: assertion

**Setup**: `playlist_configs` has `abc123` with `spotify_name = 'Old'`, `tidal_playlist_id = 'tidal-xyz'`, `created_at = '2026-01-01T00:00:00Z'`. `env.SPOTIFY_EXTRA_PLAYLIST_IDS = 'abc123'`. Mock `spotifyFetch` to return `{name:"New"}`.

**Action**: Call `seedPlaylistConfigs(env)`.

**Assertion**: After the call, `abc123` row has `spotify_name = 'New'`, but `tidal_playlist_id = 'tidal-xyz'` and `created_at = '2026-01-01T00:00:00Z'` are unchanged.

**Pass**: TRUE.

---

## T-016-17: Empty env var produces no Spotify subrequests

**Type**: metric

**Setup**: Spy on `spotifyFetch`. `env.SPOTIFY_EXTRA_PLAYLIST_IDS = ''` (empty string), and a separate run with `undefined`.

**Action**: Call `seedPlaylistConfigs(env)` for each variant.

**Measurement**: Number of `spotifyFetch` invocations across both calls.

**Pass**: metric value MUST equal 0.

---

## T-016-18: `Verified:` marker on the Spotify URL constant

**Type**: assertion

**Setup**: Read `src/providers/spotify/playlists.ts` source.

**Action**: Search for the line containing `'https://api.spotify.com/v1/playlists/'`.

**Assertion**: The line above the URL constant declaration starts with a `// Verified:` comment that includes a date and a reference to a Spotify developer documentation URL.

**Pass**: TRUE.

---

## T-016-19: `MAX_PLAYLISTS_PER_RUN` falls back to 3 on bad input

**Type**: assertion

**Setup**: Tests of the helper that reads `env.MAX_PLAYLISTS_PER_RUN`.

**Action**: Call the reader with `undefined`, `""`, `"abc"`, `"-5"`, `"0"`, `"3"`, `"7"`.

**Assertion**: Returns 3 for the first five inputs; returns 3 for `"3"`; returns 7 for `"7"`. (Same fallback semantics as `LIKED_PAGES_PER_RUN`.)

**Pass**: TRUE for all cases.
