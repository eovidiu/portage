## ADDED Requirements

### Requirement: Playlists configuration page

The SPA SHALL render a `/playlists` route showing one card per row returned
by `GET /api/playlists`, plus an "Add Spotify playlist" form. Each card
displays the `display_name`, `spotify_playlist_id`, and (when populated)
the `tidal_playlist_id`.

#### Scenario: Liked-only registry
- **WHEN** `/api/playlists` returns one row with
  `spotify_playlist_id: "__liked__"`
- **THEN** the page renders a single card labelled "Liked Songs" and the
  add-playlist form below

#### Scenario: Liked plus extras
- **WHEN** `/api/playlists` returns the `__liked__` row plus N additional
  rows
- **THEN** the page renders N+1 cards, with `__liked__` always first

### Requirement: Add playlist form validation

The add-playlist form SHALL validate the Spotify playlist id client-side
against `^[A-Za-z0-9]{22}$` before issuing `POST /api/playlists`. The form
SHALL refuse to submit when the value does not match, displaying an inline
validation message.

#### Scenario: Valid id submitted
- **WHEN** the operator enters `37i9dQZF1DXcBWIGoYBM5M` and clicks "Add"
- **THEN** the SPA POSTs the value to `/api/playlists` and on 201 a new
  card appears in the list

#### Scenario: Malformed id
- **WHEN** the operator enters `abc` and clicks "Add"
- **THEN** the form displays "Spotify playlist id must be 22 alphanumeric
  characters" and does NOT issue the POST

#### Scenario: Server rejects unknown id
- **WHEN** the SPA POSTs a 22-character id that Spotify cannot resolve and
  the Worker responds 404 `{ "error": "spotify_playlist_not_found" }`
- **THEN** the form displays "Spotify could not find this playlist" and
  the list is not modified

### Requirement: Phase gated on F-016b

The `/playlists` route SHALL not be linked from the SPA's navigation, and
SHALL render a banner "Multi-playlist sync is not yet active" when `GET
/api/playlists` returns rows other than `__liked__` but the orchestrator
has never written to those rows (detected by `playlist_membership` being
empty for the row's `spotify_playlist_id`). The route may be revealed in
the navigation only after F-016b ships and orchestrator wiring is verified.

#### Scenario: F-016b not yet shipped
- **WHEN** an operator navigates directly to `/playlists` and the
  orchestrator has never run multi-playlist sync
- **THEN** the page renders the gating banner alongside the cards
