## ADDED Requirements

### Requirement: Orchestrator persists top-3 candidates on fuzzy rejection

When the fuzzy matcher writes an `unmatched` row with `reason: "fuzzy_below_threshold"`, it SHALL persist the top 3 ranked Tidal candidates (by score, descending) onto the row's `candidates` JSONB column. Each element SHALL carry `tidal_id`, `title`, `artist`, `album`, and `score`. Rows written for other reasons (`no_candidates`, manual `/unmatched/:id/skip`, schema-add backfill) SHALL leave `candidates` NULL.

#### Scenario: fuzzy_below_threshold persists the top 3 ranked
- **WHEN** the fuzzy matcher ranks five candidates for a track and the top score is below `ACCEPT_THRESHOLD`
- **THEN** the resulting `unmatched` row carries a `candidates` JSONB array of length 3, sorted by `score` descending, each element carrying `tidal_id`, `title`, `artist`, `album`, `score`

#### Scenario: no_candidates leaves candidates NULL
- **WHEN** the fuzzy matcher receives zero candidates for a track and writes an `unmatched` row with `reason: "no_candidates"`
- **THEN** the row's `candidates` column is `NULL`

#### Scenario: Re-processing overwrites candidates
- **WHEN** an `unmatched` row already exists for a track and the orchestrator re-runs the fuzzy matcher in a later run, producing a fresh ranked list
- **THEN** the row's `candidates` column is overwritten with the latest top 3; the prior list is not preserved

### Requirement: GET /sync/runs/:run_id/tracks surfaces candidates on unmatched rows

The endpoint SHALL include a `candidates` array on unmatched response rows when the underlying `unmatched.candidates` column is non-NULL. The field SHALL be omitted from the response row (not `null`) when the column is NULL. Matched rows SHALL NOT include a `candidates` field.

#### Scenario: Unmatched row with persisted candidates
- **WHEN** an authenticated request reaches `GET /sync/runs/:run_id/tracks` and a row in the result set has `reason: "fuzzy_below_threshold"` and a populated `candidates` JSONB
- **THEN** the response row carries a `candidates` array with the persisted elements verbatim

#### Scenario: Unmatched row without persisted candidates
- **WHEN** an authenticated request reaches `GET /sync/runs/:run_id/tracks` and a row's `unmatched.candidates` is NULL
- **THEN** the response row does NOT carry a `candidates` field (the key is absent, not `null`)

### Requirement: POST /unmatched/:spotify_id/match accepts sync_run_id

The endpoint SHALL accept an optional `sync_run_id` field in the JSON body alongside the existing required `tidal_id`. When present and validly formatted as a UUID, the Worker SHALL stamp it on the inserted `matches` row's `sync_run_id` column. When absent or invalid, the `matches` row's `sync_run_id` is left NULL (existing behavior).

#### Scenario: Manual match without sync_run_id (status quo)
- **WHEN** an authenticated request POSTs `/unmatched/<spotify_id>/match` with body `{ "tidal_id": "<id>" }`
- **THEN** the response is `200 OK` (or `201`), the `unmatched` row is removed, a `matches` row is inserted with `method: "manual"` and `sync_run_id: NULL`

#### Scenario: Manual match with sync_run_id from a run-detail page
- **WHEN** an authenticated request POSTs `/unmatched/<spotify_id>/match` with body `{ "tidal_id": "<id>", "sync_run_id": "<run-uuid>" }`
- **THEN** the inserted `matches` row carries `sync_run_id: <run-uuid>`; the subsequent `GET /sync/runs/<run-uuid>/tracks` shows the row with `status: "matched"`, `method: "manual"`, and the picked `tidal_id`

#### Scenario: Malformed sync_run_id is ignored, not rejected
- **WHEN** an authenticated request POSTs `/unmatched/<spotify_id>/match` with body `{ "tidal_id": "<id>", "sync_run_id": "not-a-uuid" }`
- **THEN** the manual match still succeeds with `sync_run_id: NULL` on the resulting row; the endpoint does NOT 400 on the malformed optional field
