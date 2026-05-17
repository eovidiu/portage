# playlists-add Specification

## Purpose
TBD - promoted from archived change portage-ui-foundation (2026-05-16). Update Purpose after promotion.
## Requirements
### Requirement: Add a Spotify playlist to the registry

The Worker SHALL expose `POST /api/playlists` accepting a JSON body
`{ spotify_playlist_id: string }`. The endpoint validates the id format,
calls `fetchSpotifyPlaylistName` (F-016) to populate `display_name`, and
inserts the row via the F-016 DB helpers. The endpoint requires
authentication.

#### Scenario: Valid new playlist id
- **WHEN** an authenticated request POSTs `{ "spotify_playlist_id":
  "37i9dQZF1DXcBWIGoYBM5M" }` (22 characters, alphanumeric)
- **THEN** the response is `201 Created` with body containing the inserted
  row including a non-null `display_name` fetched from Spotify

#### Scenario: Malformed playlist id
- **WHEN** an authenticated request POSTs `{ "spotify_playlist_id":
  "abc" }` or any value not matching `^[A-Za-z0-9]{22}$`
- **THEN** the response is `400 Bad Request` with body
  `{ "error": "invalid_playlist_id" }` and no row is written

#### Scenario: Duplicate playlist id (idempotent)
- **WHEN** an authenticated request POSTs an id that already exists in
  `playlist_configs`
- **THEN** the response is `200 OK` with the existing row, no duplicate row
  is created

#### Scenario: Spotify rejects the playlist id
- **WHEN** `fetchSpotifyPlaylistName` returns `null` (Spotify 404 — playlist
  does not exist or is not visible to the operator's token)
- **THEN** the response is `404 Not Found` with body
  `{ "error": "spotify_playlist_not_found" }` and no row is written

#### Scenario: Unauthenticated request
- **WHEN** an unauthenticated request POSTs to `/api/playlists`
- **THEN** the response is `401 Unauthorized` and no row is written
