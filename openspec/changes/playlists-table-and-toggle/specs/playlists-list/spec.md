## MODIFIED Requirements

### Requirement: List configured playlists

The Worker SHALL expose `GET /api/playlists` returning all rows from the `playlist_configs` table (seeded by F-016) as a JSON array. Each row contains `spotify_playlist_id`, `spotify_name`, `tidal_playlist_id`, `enabled`, `last_synced_at`, and `created_at`. The endpoint requires authentication. The handler returns ALL rows including disabled ones so the operator can see and re-enable them; the orchestrator's `enabled = true` filter is enforced separately at the iteration query.

The `enabled` field is a boolean indicating whether the orchestrator currently syncs this playlist. The `last_synced_at` field is an ISO-8601 UTC timestamp recording the most recent successful per-playlist sync, or `null` if the orchestrator has not yet completed a sync for this row. (The `is_liked` discriminator is derived client-side from `spotify_playlist_id === "__liked__"` — it is not a separate field on the wire, matching the existing API contract that F-016/F-017/F-018 shipped against.)

#### Scenario: Liked-only registry
- **WHEN** the registry contains only the seeded `__liked__` row and an authenticated request reaches `GET /api/playlists`
- **THEN** the response is `200 OK` with body containing exactly one row whose `spotify_playlist_id` is `__liked__` and `enabled` is `true`

#### Scenario: Liked plus extras
- **WHEN** the registry contains `__liked__` plus N extra Spotify playlists
- **THEN** the response is `200 OK` with body containing N+1 rows, sorted with the `__liked__` row first, each row carrying its current `enabled` and `last_synced_at` values

#### Scenario: Includes enabled and last_synced_at fields
- **WHEN** an authenticated request reaches `GET /api/playlists` and the registry contains a row with `enabled = false` and another with `enabled = true` whose `last_synced_at` was populated by a prior orchestrator run
- **THEN** the response body reflects both fields verbatim on the respective rows: the disabled row carries `enabled: false`, and the synced row carries an ISO-8601 `last_synced_at` value

#### Scenario: Unsynced rows carry null last_synced_at
- **WHEN** an authenticated request reaches `GET /api/playlists` and a row has never been processed by the orchestrator
- **THEN** the row in the response carries `last_synced_at: null`

#### Scenario: Disabled rows still appear in GET response
- **WHEN** an authenticated request reaches `GET /api/playlists` and the registry contains a row with `enabled = false`
- **THEN** the response includes that row with `enabled: false`; the GET handler does not apply the orchestrator's enabled filter

#### Scenario: Unauthenticated request
- **WHEN** an unauthenticated request reaches `GET /api/playlists`
- **THEN** the response is `401 Unauthorized` and no rows are returned
