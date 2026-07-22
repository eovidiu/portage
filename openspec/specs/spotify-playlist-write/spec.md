# spotify-playlist-write Specification

## Purpose
Create Spotify playlists and append tracks for the tidal_to_spotify copy direction, with the OAuth scope set centralized in scopes.ts. Created by archiving change playlist-copy.
## Requirements

### Requirement: Centralized Spotify scope set
Spotify OAuth scopes SHALL be defined once in `src/providers/spotify/scopes.ts` as
`user-library-read playlist-read-private playlist-modify-private` and referenced by
the authorize-URL builder (replacing the hardcoded literal). The `scope` field from
token exchange and refresh responses SHALL be persisted to
`provider_tokens.scopes`.

#### Scenario: Authorize URL carries the full scope set
- **WHEN** the operator starts the Spotify OAuth flow
- **THEN** the authorize URL requests all three scopes from the central constant

#### Scenario: Granted scopes persisted on exchange
- **WHEN** the OAuth callback exchanges a code for tokens
- **THEN** the response's `scope` string is stored on the spotify
  `provider_tokens` row

### Requirement: Create playlist
The Worker SHALL create Spotify playlists via `POST /v1/me/playlists` with
`{ name, public: false }`, returning the new playlist id. The legacy
`/users/{user_id}/playlists` form SHALL NOT be used.

#### Scenario: Private playlist created
- **WHEN** a copy job's first write tick targets a new Spotify playlist
- **THEN** the playlist is created private via `POST /v1/me/playlists` and its id is
  persisted on the job

### Requirement: Add items in capped batches
The Worker SHALL add tracks via `POST /v1/playlists/{id}/items` with
`spotify:track:` URIs, at most 100 per request (the copy engine uses ≤50), and SHALL
treat a 429 by honoring `Retry-After` once before surfacing the failure (matching
the Tidal writer's retry-once pattern). The deprecated `/tracks` path SHALL NOT be
used.

#### Scenario: Batch appended
- **WHEN** a write tick sends a batch of matched URIs
- **THEN** the request uses the `/items` path and the response's `snapshot_id`
  confirms the append

#### Scenario: Rate-limited batch retried once
- **WHEN** the add-items call returns 429 with `Retry-After`
- **THEN** the Worker waits and retries once; a second 429 fails the batch without
  failing the job
