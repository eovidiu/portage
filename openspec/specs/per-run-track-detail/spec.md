# per-run-track-detail Specification

## Purpose
Promoted from archived change per-run-track-detail (2026-05-17).

## Requirements

### Requirement: Per-run track manifest endpoint

The Worker SHALL expose `GET /sync/runs/:run_id/tracks` returning every track touched by the run identified by `:run_id`. Each response row carries the Spotify track metadata, a status discriminator (`"matched"` or `"unmatched"`), and the fields appropriate to that status. The endpoint requires authentication.

Response body shape:

```json
{
  "total": <integer>,
  "items": [
    {
      "spotify_id": "<string>",
      "title": "<string>",
      "artist": "<string>",
      "album": "<string | null>",
      "isrc": "<string | null>",
      "status": "matched",
      "tidal_id": "<string>",
      "method": "isrc" | "fuzzy" | "manual",
      "confidence": <number | null>
    },
    {
      "spotify_id": "<string>",
      "title": "<string>",
      "artist": "<string>",
      "album": "<string | null>",
      "isrc": "<string | null>",
      "status": "unmatched",
      "reason": "<string>"
    }
  ]
}
```

The endpoint SHALL accept the following query parameters:

- `limit` (default `50`, hard maximum `200`)
- `offset` (default `0`)
- `status` (one of `matched`, `unmatched`, or `all` — defaults to `all`)
- `method` (one of `isrc`, `fuzzy`, `manual` — only meaningful for matched rows; ignored when `status=unmatched`)

#### Scenario: Run with only matched tracks
- **WHEN** an authenticated request reaches `GET /sync/runs/<run-id>/tracks` and every track touched by the run landed in `matches` with that `sync_run_id`
- **THEN** the response is `200 OK` with every row carrying `status: "matched"` and a non-null `tidal_id`, `method`, and `confidence`

#### Scenario: Run with mixed matched + unmatched
- **WHEN** an authenticated request reaches `GET /sync/runs/<run-id>/tracks` for a run where some tracks matched and others landed in `unmatched`
- **THEN** the response includes both row types, distinguished by the `status` field. Matched rows carry `tidal_id` / `method` / `confidence`; unmatched rows carry `reason`. Neither row type carries the other's fields.

#### Scenario: Status filter narrows the response
- **WHEN** an authenticated request reaches `GET /sync/runs/<run-id>/tracks?status=unmatched`
- **THEN** the response contains only rows with `status: "unmatched"` and `total` reflects the count of unmatched rows for this run

#### Scenario: Method filter narrows matched rows
- **WHEN** an authenticated request reaches `GET /sync/runs/<run-id>/tracks?status=matched&method=fuzzy`
- **THEN** the response contains only matched rows whose `method` is `"fuzzy"`; `total` reflects that filtered count

#### Scenario: Pagination
- **WHEN** an authenticated request reaches `GET /sync/runs/<run-id>/tracks?limit=20&offset=20`
- **THEN** the response contains at most 20 rows starting from the 21st row of the (filter-honored) result set; `total` reflects the full filter-honored count, not the page size

#### Scenario: Limit ceiling
- **WHEN** an authenticated request reaches `GET /sync/runs/<run-id>/tracks?limit=500`
- **THEN** the Worker clamps `limit` to `200` and returns at most 200 rows

#### Scenario: Unknown run id
- **WHEN** an authenticated request reaches `GET /sync/runs/<nonexistent-uuid>/tracks`
- **THEN** the response is `404 Not Found` with body `{ "error": "run_not_found" }`

#### Scenario: Run with zero tracks
- **WHEN** an authenticated request reaches `GET /sync/runs/<run-id>/tracks` for a run that legitimately processed zero tracks (e.g. a run that aborted before any match work)
- **THEN** the response is `200 OK` with `{ "total": 0, "items": [] }` — this is distinct from a 404 on an unknown run

#### Scenario: Unauthenticated request
- **WHEN** an unauthenticated request reaches `GET /sync/runs/<run-id>/tracks`
- **THEN** the response is `401 Unauthorized` and no row data is returned

### Requirement: unmatched.sync_run_id column

The `unmatched` table SHALL carry a `sync_run_id UUID` column referencing `sync_runs(run_id)`. Existing rows MAY be `NULL` (predating this schema add). New rows written by the orchestrator SHALL carry the current `runId`.

#### Scenario: New unmatched row carries the run id
- **WHEN** the orchestrator writes an unmatched row during a run with id `<run-id>`
- **THEN** the row's `sync_run_id` column equals `<run-id>`

#### Scenario: Schema add backfills existing rows to NULL
- **WHEN** the `ALTER TABLE unmatched ADD COLUMN sync_run_id UUID` migration is applied
- **THEN** every pre-existing row's `sync_run_id` is `NULL`; no row is modified other than gaining the new column

### Requirement: Orchestrator writes sync_run_id on unmatched

The orchestrator SHALL pass the current run's `runId` to the unmatched write helper so the resulting row carries `sync_run_id`. Per-row errors (a single track failing to write) SHALL NOT prevent other tracks in the same run from being recorded with their `sync_run_id`.

#### Scenario: A track lands in unmatched mid-run
- **WHEN** the orchestrator's match path determines a track is unmatched during run `<run-id>` and writes the row
- **THEN** the resulting `unmatched` row's `sync_run_id` equals `<run-id>` alongside its `reason`, `attempts`, and `last_attempt_at`

## Additional Requirements (pick-from-fuzzy-candidates, 2026-05-17)

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
