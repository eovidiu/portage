# playlist-browse Specification

## Purpose
List the authenticated operator's own playlists on both providers as copy source/destination pickers. Created by archiving change playlist-copy.
## Requirements

### Requirement: List own playlists per provider
The Worker SHALL expose `GET /api/copy/playlists?provider=spotify|tidal` returning
the authenticated operator's own playlists as
`{ playlists: [{ id, name, track_count }], next_cursor }`. Spotify entries SHALL come
from `GET /v1/me/playlists` (limit 50); Tidal entries SHALL come from
`GET /v2/playlists?filter[owners.id]=me` using only the already-granted
`playlists.read` scope.

#### Scenario: Spotify playlists listed
- **WHEN** the operator requests `/api/copy/playlists?provider=spotify`
- **THEN** the response is 200 with each owned playlist's id, name, and track count,
  and `next_cursor` is non-null when Spotify reports more pages

#### Scenario: Tidal playlists listed
- **WHEN** the operator requests `/api/copy/playlists?provider=tidal`
- **THEN** the response is 200 with playlists mapped from the JSON:API `data[]`
  attributes, and `next_cursor` carries `links.meta.nextCursor` when present

#### Scenario: Invalid provider rejected
- **WHEN** the `provider` query param is missing or not `spotify`/`tidal`
- **THEN** the response is 422 with a validation error body

### Requirement: Pagination pass-through
The endpoint SHALL accept an opaque `cursor` query param and pass it to the
underlying provider (Spotify `offset`, Tidal `page[cursor]`), returning the next
page without server-side state.

#### Scenario: Second page fetched
- **WHEN** the operator repeats the request with the `next_cursor` from a prior
  response
- **THEN** the response contains the subsequent page of playlists

### Requirement: Missing Spotify scope surfaces re-auth
When the stored Spotify grant lacks `playlist-read-private`, the endpoint SHALL
return `409 { error: "spotify_reauth_required" }` for `provider=spotify` instead of
proxying a failing upstream call.

#### Scenario: Stale grant detected
- **WHEN** `provider_tokens.scopes` for spotify does not include
  `playlist-read-private`
- **THEN** `/api/copy/playlists?provider=spotify` returns 409 with
  `spotify_reauth_required`
