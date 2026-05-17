# T-026a: `playlist_configs.enabled` column + GET projection tests

Covers F-026a.

---

## T-026a-01: `playlist_configs.enabled` column exists

**Type**: assertion (against live Neon branch after migration applies)

**Setup**: `ALTER TABLE playlist_configs ADD COLUMN IF NOT EXISTS enabled BOOLEAN NOT NULL DEFAULT TRUE` applied to the target branch.

**Action**: `SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_name = 'playlist_configs' AND column_name = 'enabled';`

**Assertion**: Exactly one row returned. `data_type = boolean`, `is_nullable = NO`, `column_default = true`.

**Pass**: TRUE if all hold.

---

## T-026a-02: Existing rows take `enabled = TRUE`

**Type**: assertion

**Setup**: Pre-migration `playlist_configs` row (`__liked__`); apply the ALTER TABLE.

**Action**: `SELECT enabled FROM playlist_configs WHERE spotify_playlist_id = '__liked__';`

**Assertion**: `enabled = true` (populated by the DEFAULT).

**Pass**: TRUE if equal.

---

## T-026a-03: `PlaylistConfigRow` type carries `enabled`

**Type**: TypeScript compile-time gate (implicit via test-fixture usage)

**Setup**: Test fixtures `LIKED_ROW` and `EXTRA_ROW` in `tests/routes/playlists.test.ts` declare `enabled: true`.

**Action**: `tsc --noEmit`.

**Assertion**: Compilation succeeds (the `enabled` field is required by `PlaylistConfigRow`).

**Pass**: TRUE if tsc exits 0.

---

## T-026a-04: `listPlaylistConfigs` SELECT includes `enabled`

**Type**: assertion

**Setup**: Mock `NeonQueryFunction` that records the SQL string it receives.

**Action**: Call `listPlaylistConfigs(sql)`.

**Assertion**: The SQL string passed to `sql(...)` contains the literal `enabled` in the column list.

**Pass**: TRUE if contains.

---

## T-026a-05: `getPlaylistConfig` SELECT includes `enabled`

**Type**: assertion

**Setup**: Mock as above.

**Action**: Call `getPlaylistConfig(sql, 'any-id')`.

**Assertion**: The SQL string contains `enabled`.

**Pass**: TRUE if contains.

---

## T-026a-06: GET /api/playlists includes `enabled` on every row

**Type**: integration (route)

**Setup**: Mock `listPlaylistConfigs` to return `[LIKED_ROW (enabled: true), EXTRA_DISABLED_ROW (enabled: false)]`.

**Action**: `GET /api/playlists` with a valid Bearer JWT.

**Assertion**: Response is 200. Body has 2 rows. `body[0].enabled === true`. `body[1].enabled === false`.

**Pass**: TRUE if all hold.

---

## T-026a-07: GET /api/playlists does NOT hide disabled rows

**Type**: integration (route)

**Setup**: Mock `listPlaylistConfigs` to return three rows including one with `enabled: false`.

**Action**: `GET /api/playlists`.

**Assertion**: All three rows appear in the response (the GET handler must not filter on `enabled`).

**Pass**: TRUE if `body.length === 3`.

---

## T-026a-08: Unsynced rows still carry `last_synced_at: null`

**Type**: integration (route; regression coverage for the pre-existing column)

**Setup**: Mock `listPlaylistConfigs` to return a row with `last_synced_at: null`.

**Action**: `GET /api/playlists`.

**Assertion**: `body[0].last_synced_at === null`.

**Pass**: TRUE if null on the wire.

---

## T-026a-09: POST /api/playlists synthetic row reflects `enabled: true`

**Type**: integration (route)

**Setup**: Existing T-022-01 setup; mock `getPlaylistConfig` → null, `fetchSpotifyPlaylistName` → "Today's Top Hits", `upsertPlaylistConfig` → undefined.

**Action**: `POST /api/playlists` with body `{ spotify_playlist_id: VALID_PLAYLIST_ID }`.

**Assertion**: Response is 201. Body has `enabled: true`.

**Pass**: TRUE if synthetic row carries `enabled: true`.
