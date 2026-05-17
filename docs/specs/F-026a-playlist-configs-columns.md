# F-026a: `playlist_configs.enabled` column + GET projection

## Summary

Adds an `enabled BOOLEAN NOT NULL DEFAULT TRUE` column to `playlist_configs`
so the operator can pause sync for an individual playlist without removing
the row (preserving its `playlist_membership` history for a future
re-enable). The `GET /api/playlists` handler projects the new field
verbatim; it returns ALL rows including disabled ones so the SPA can see
and re-enable them. The orchestrator's `WHERE enabled = TRUE` filter is a
separate concern owned by F-026b.

`last_synced_at` is **not** added by F-026a — it was shipped earlier by
F-016/F-018 and is already projected.

`is_liked` is **not** added to the wire shape — the SPA derives it
client-side from `spotify_playlist_id === "__liked__"`, matching the
existing API contract.

## Linked tests

[T-026a](T-026a-playlist-configs-columns.md)

## Dependencies

- F-016 (playlist_configs table; row shape; read helpers)
- F-021 (GET /api/playlists handler)

## Behavioural specification

### `playlist_configs.enabled` column exists

- **Given** the production Neon `playlist_configs` table
- **When** the column inventory is queried via `information_schema.columns`
- **Then** an `enabled` column is present with type `boolean`, `NOT NULL`,
  default `TRUE`

### Existing rows take `enabled = TRUE` by default

- **Given** the schema migration `ALTER TABLE playlist_configs ADD COLUMN
  enabled BOOLEAN NOT NULL DEFAULT TRUE` is applied
- **When** the column is read on rows that existed before the migration
- **Then** every existing row carries `enabled = TRUE` (the DEFAULT
  populated them; no separate UPDATE backfill is needed)

### Read helpers project the new column

- **Given** the in-memory `PlaylistConfigRow` type
- **When** `listPlaylistConfigs` or `getPlaylistConfig` returns a row
- **Then** the row carries `enabled: boolean`

### GET /api/playlists returns `enabled` on every row

- **Given** an authenticated request reaches `GET /api/playlists`
- **When** the registry contains a row with `enabled = false` and another
  with `enabled = true`
- **Then** both rows appear in the response body with their respective
  `enabled` values; the GET handler does NOT filter disabled rows

### POST /api/playlists synthetic row reflects the default

- **Given** a successful `POST /api/playlists` insert
- **When** the handler returns the synthetic row representing the new
  insert
- **Then** the returned row carries `enabled: true`
