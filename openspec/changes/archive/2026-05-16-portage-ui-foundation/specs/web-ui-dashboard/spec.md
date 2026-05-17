## ADDED Requirements

### Requirement: Dashboard summarizes the latest sync run

The SPA SHALL render a `/dashboard` route showing the latest sync run's
status (`succeeded` / `partial` / `failed` / `running`), `error_code` when
failed, items synced count, and timestamp, sourced from `GET /sync/status`.

#### Scenario: Latest run succeeded
- **WHEN** `/sync/status` returns
  `{ "status": "succeeded", "items_synced": 12, "started_at": "..." }`
- **THEN** the page displays a green status badge labelled "succeeded", the
  count "12 items synced", and the relative timestamp

#### Scenario: Latest run failed with discriminated error_code
- **WHEN** `/sync/status` returns `{ "status": "failed", "error_code":
  "spotify_reauth_required", ... }`
- **THEN** the page displays a red status badge with the `error_code` label
  and a contextual call-to-action ("Reconnect Spotify") that links to
  `/connect`

### Requirement: Stats tiles

The dashboard SHALL render three tiles sourced from `GET /stats`: match
rate (formatted to 4 significant digits), runs in the last 7 days
(succeeded / partial / failed counts), and lag hours (1-decimal precision).

#### Scenario: Stats tiles render
- **WHEN** `/stats` returns
  `{ "match_rate": 0.9847, "runs_succeeded_7d": 12, "runs_partial_7d": 1,
  "runs_failed_7d": 0, "lag_hours": 5.4 }`
- **THEN** the tiles display "98.47%", "12 / 1 / 0", and "5.4h"

### Requirement: Manual sync trigger

The dashboard SHALL include a "Run sync now" button that issues `POST
/sync/run`. The button SHALL handle 200, 202, and 409 responses with
distinct toast notifications, and re-fetch `/sync/status` after the
response.

#### Scenario: Sync completes within 25 seconds (200)
- **WHEN** the button is clicked and `/sync/run` returns 200
- **THEN** a green toast displays "Sync complete" and the dashboard's
  status query refetches

#### Scenario: Sync still running at 25 seconds (202)
- **WHEN** the button is clicked and `/sync/run` returns 202 with body
  `{ "run_id": "..." }`
- **THEN** a blue toast displays "Sync running in background" and the
  dashboard begins polling `/sync/status` every 30 seconds until the
  status leaves `running`

#### Scenario: Lock contention (409)
- **WHEN** the button is clicked and `/sync/run` returns 409 with body
  `{ "error": "run_in_progress", "current_run_id": "..." }`
- **THEN** a yellow toast displays "Another run is already in progress"
  with the `current_run_id`

### Requirement: Polling while a run is in progress

The dashboard SHALL refetch `GET /sync/status` every 30 seconds while the
status is `running`, and stop polling once the status leaves `running`.

#### Scenario: Status transitions from running to succeeded
- **WHEN** `/sync/status` returns `running` for two polls and then
  `succeeded` on the third
- **THEN** the dashboard updates the badge after the third poll and stops
  the 30-second interval
