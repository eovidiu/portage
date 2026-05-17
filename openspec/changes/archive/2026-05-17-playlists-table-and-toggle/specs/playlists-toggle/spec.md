## ADDED Requirements

### Requirement: Toggle playlist sync on or off

The Worker SHALL expose `PATCH /api/playlists/:spotify_playlist_id` accepting a JSON body `{ "enabled": boolean }`. The endpoint updates the `enabled` column on the addressed `playlist_configs` row and returns the updated row. The endpoint requires authentication.

#### Scenario: Disable an enabled playlist
- **WHEN** an authenticated request sends `PATCH /api/playlists/37i9dQZF1DXcBWIGoYBM5M` with body `{ "enabled": false }` and the row currently has `enabled = true`
- **THEN** the response is `200 OK` with the row body containing `enabled: false`, and the database reflects the new value

#### Scenario: Re-enable a disabled playlist
- **WHEN** an authenticated request sends `PATCH /api/playlists/37i9dQZF1DXcBWIGoYBM5M` with body `{ "enabled": true }` and the row currently has `enabled = false`
- **THEN** the response is `200 OK` with the row body containing `enabled: true`, and the database reflects the new value

#### Scenario: Idempotent toggle (same value)
- **WHEN** an authenticated request sends `PATCH /api/playlists/37i9dQZF1DXcBWIGoYBM5M` with `{ "enabled": true }` and the row already has `enabled = true`
- **THEN** the response is `200 OK` with the unchanged row body and the database is not written

#### Scenario: Unknown playlist id
- **WHEN** an authenticated request sends `PATCH /api/playlists/nonexistent22charabcdef` with `{ "enabled": false }` and no such row exists
- **THEN** the response is `404 Not Found` with body `{ "error": "playlist_not_found" }`

#### Scenario: Malformed body
- **WHEN** an authenticated request sends `PATCH /api/playlists/:id` with a body missing `enabled`, with `enabled` not a boolean, or with extra unknown fields
- **THEN** the response is `400 Bad Request` with body `{ "error": "invalid_request_body" }` and no row is written

#### Scenario: Unauthenticated request
- **WHEN** an unauthenticated request sends `PATCH /api/playlists/:id`
- **THEN** the response is `401 Unauthorized` and no row is written

### Requirement: Liked Songs row cannot be disabled

The Worker SHALL refuse to set `enabled = false` on the row whose `spotify_playlist_id` is `__liked__`. Re-enabling the row (a no-op when already enabled) SHALL be accepted as idempotent.

#### Scenario: Attempt to disable __liked__
- **WHEN** an authenticated request sends `PATCH /api/playlists/__liked__` with body `{ "enabled": false }`
- **THEN** the response is `409 Conflict` with body `{ "error": "liked_cannot_be_disabled" }` and the row remains `enabled = true`

#### Scenario: Idempotent enable on __liked__
- **WHEN** an authenticated request sends `PATCH /api/playlists/__liked__` with body `{ "enabled": true }`
- **THEN** the response is `200 OK` with the unchanged row body

### Requirement: Orchestrator skips disabled playlists

The Worker's sync orchestrator SHALL apply a `WHERE enabled = TRUE` filter at the SQL level when iterating `playlist_configs`. Disabled rows SHALL NOT contribute to the sync run, but their existing `playlist_membership` data SHALL be preserved unchanged.

#### Scenario: One playlist disabled, others active
- **WHEN** the orchestrator runs with one non-liked row marked `enabled = false` and all other rows `enabled = true`
- **THEN** the disabled row is skipped (no Tidal write, no `playlist_membership` change), the run completes normally for the remaining rows, and the disabled row's `last_synced_at` is not updated

#### Scenario: Re-enable resumes from next run
- **WHEN** a disabled row is re-enabled via `PATCH /api/playlists/:id` and the next scheduled orchestrator run begins
- **THEN** the row participates in the run exactly as if it had never been disabled, and its `last_synced_at` updates on success

### Requirement: Orchestrator records last sync timestamp

The Worker's sync orchestrator SHALL update `playlist_configs.last_synced_at` to the current timestamp for each row whose per-playlist sync completes successfully within a run. Rows skipped due to `enabled = false` or that error during the run SHALL NOT have their `last_synced_at` updated.

#### Scenario: Successful per-playlist sync writes timestamp
- **WHEN** the orchestrator finishes processing a `enabled = true` row without per-playlist errors
- **THEN** the row's `last_synced_at` is set to the current UTC timestamp (ISO-8601)

#### Scenario: Per-playlist error preserves prior timestamp
- **WHEN** the orchestrator encounters an error processing a single row mid-run (e.g. Tidal 502 on that playlist's write)
- **THEN** the row's `last_synced_at` is left at its previous value, the run continues with other rows, and the failure is reflected in the run-level error history
