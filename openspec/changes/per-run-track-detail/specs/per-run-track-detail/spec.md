## ADDED Requirements

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
