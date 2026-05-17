# playlists-list Specification

## Purpose
TBD - promoted from archived change portage-ui-foundation (2026-05-16). Update Purpose after promotion.
## Requirements
### Requirement: List configured playlists

The Worker SHALL expose `GET /api/playlists` returning all rows from the
`playlist_configs` table (seeded by F-016) as a JSON array. Each row
contains `spotify_playlist_id`, `display_name`, `tidal_playlist_id`,
`is_liked`, and `created_at`. The endpoint requires authentication.

#### Scenario: Liked-only registry
- **WHEN** the registry contains only the seeded `__liked__` row and an
  authenticated request reaches `GET /api/playlists`
- **THEN** the response is `200 OK` with body containing exactly one row
  whose `spotify_playlist_id` is `__liked__` and `is_liked` is `true`

#### Scenario: Liked plus extras
- **WHEN** the registry contains `__liked__` plus N extra Spotify playlists
- **THEN** the response is `200 OK` with body containing N+1 rows, sorted
  with the `__liked__` row first

#### Scenario: Unauthenticated request
- **WHEN** an unauthenticated request reaches `GET /api/playlists`
- **THEN** the response is `401 Unauthorized` and no rows are returned
