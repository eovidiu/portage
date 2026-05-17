## ADDED Requirements

### Requirement: Runs history page

The SPA SHALL render a `/runs` route showing a paginated list of sync runs
sourced from `GET /sync/runs?limit=&offset=&status=&error_code=`. Each row
displays the run's status, `error_code` (if any), started_at, finished_at,
items synced, and a link to a detail view.

#### Scenario: Default page load
- **WHEN** the operator navigates to `/runs` without query params
- **THEN** the SPA fetches `/sync/runs?limit=20&offset=0` and renders the
  20 most recent runs

#### Scenario: Filter by failed status
- **WHEN** the operator selects "failed" from the status filter
- **THEN** the SPA fetches `/sync/runs?limit=20&offset=0&status=failed`
  and the URL updates to `/runs?status=failed`

#### Scenario: Filter by error_code
- **WHEN** the operator selects "spotify_reauth_required" from the
  error_code filter
- **THEN** the SPA fetches
  `/sync/runs?limit=20&offset=0&error_code=spotify_reauth_required` and
  renders only matching rows

### Requirement: Unmatched queue page

The SPA SHALL render an `/unmatched` route showing the pending unmatched
tracks sourced from `GET /unmatched?limit=&offset=`. Each row displays the
Spotify track metadata (artist, title, album), the score (when available
from F-007), and action controls.

#### Scenario: Empty queue
- **WHEN** `/unmatched` returns an empty array
- **THEN** the page displays an empty-state message "No unmatched tracks"

#### Scenario: Queue with rows
- **WHEN** `/unmatched` returns N rows
- **THEN** the page renders N rows, each with manual-match and skip
  controls

### Requirement: Manual match action

Each unmatched row SHALL provide a manual match control accepting a Tidal
track id. On submit, the SPA POSTs to
`/unmatched/:spotify_id/match` with body `{ "tidal_id": "..." }`. The UI
applies an optimistic update (the row disappears) and rolls back on a
non-2xx response, displaying the error message in a toast.

#### Scenario: Successful manual match
- **WHEN** the operator pastes a Tidal id and clicks "Match"
- **THEN** the row disappears from the queue immediately (optimistic
  update); on 200 the change is committed; on 400 the row reappears with a
  toast showing the server's error message

#### Scenario: Invalid Tidal id format (client-side)
- **WHEN** the operator submits a Tidal id that does not match the expected
  format
- **THEN** the SPA displays a validation error and does NOT issue the POST

### Requirement: Skip action

Each unmatched row SHALL provide a "Skip" control that POSTs to
`/unmatched/:spotify_id/skip` (idempotent on the Worker side). The UI
applies an optimistic update and rolls back on a non-2xx response.

#### Scenario: Skip a row
- **WHEN** the operator clicks "Skip" on a row
- **THEN** the row disappears immediately; on 200 the change is committed;
  on a non-2xx response the row reappears with an error toast

### Requirement: Candidates fallback (F-012 R3/R4)

The UI SHALL render the manual-match input as the primary action when an
unmatched row has `candidates: []` (the current state until F-012 M1
ships), without showing a candidates list, and SHALL display an inline
note "Automatic candidates not yet available — paste a Tidal id".

#### Scenario: Empty candidates array
- **WHEN** an unmatched row is returned with `candidates: []`
- **THEN** the row renders the manual-match input prominently and shows
  the inline note
