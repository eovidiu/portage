# F-005: Spotify Liked Songs incremental fetch

## Summary

The fetch module retrieves new Spotify Liked Songs since the last successful run, using the `spotify_added_at` cursor. It paginates through the Spotify API at 50 items per page, persists each track to the `tracks` table, and advances the cursor only after a page is fully persisted. The result of a fetch is a list of `tracks` rows that have not yet been matched.

## Linked tests

[T-005](../tests/T-005-liked-songs-fetch.md)

## Dependencies

- F-002 (Spotify OAuth and token refresh)
- F-004 (token decryption)
- Postgres `tracks` and `sync_state` tables

## Behavioural specification

### Initial fetch (cold start)

- **Given** `sync_state` has no `spotify_cursor` row
- **When** the fetch module runs for the first time
- **Then** the system reads `cursor = '1970-01-01T00:00:00Z'`
- **And** fetches all Liked Songs paginated 50 at a time, ordered by `added_at DESC` as Spotify returns them
- **And** persists every track to `tracks`
- **And** writes `sync_state.spotify_cursor = max(added_at)` after all pages succeed

### Incremental fetch (subsequent runs)

- **Given** `sync_state.spotify_cursor = T`
- **When** the fetch module runs
- **Then** it paginates Spotify Liked Songs from the most recent backwards
- **And** stops paginating as soon as it sees a track with `added_at <= T`
- **And** persists only tracks with `added_at > T`

### Persist a fetched track

- **Given** a Spotify track object from the API
- **When** the persist helper runs
- **Then** it normalises the track to `{ spotify_id, isrc, artist, title, album, duration_ms, spotify_added_at }`
- **And** upserts into `tracks` with `ON CONFLICT (spotify_id) DO NOTHING`
- **And** populates `first_seen_at = now()` only on insert

### Cursor advance

- **Given** all tracks fetched in a run have been persisted
- **When** the fetch module completes
- **Then** the new cursor `T' = max(spotify_added_at) over all fetched tracks` is written to `sync_state`
- **And** the cursor advance is in the same transaction as the last page's track inserts

### Skip non-track items

- **Given** a saved item whose `track.type !== 'track'` (e.g. `episode`, `local`)
- **When** the persist helper sees it
- **Then** the item is logged as `skipped_non_track` and not inserted

## Detailed requirements

| ID | Requirement |
|---|---|
| F-005-R1 | The system MUST use `GET /v1/me/tracks` with `limit=50` and `offset` pagination, OR follow the `next` URL returned by Spotify, whichever the implementer prefers; the choice MUST be documented in code. |
| F-005-R2 | The system MUST extract `track.external_ids.isrc` and store it; if absent, `isrc` MUST be NULL. |
| F-005-R3 | The system MUST persist `spotify_added_at` from the saved-item envelope, not from the track object. |
| F-005-R4 | The system MUST ignore items where `track.is_local === true` or `track.type !== 'track'`. |
| F-005-R5 | Pagination MUST stop early once a track with `added_at <= cursor` is encountered. |
| F-005-R6 | The cursor advance MUST happen only after every track in the run is persisted; partial runs MUST NOT advance the cursor. |
| F-005-R7 | The system MUST handle Spotify rate-limit responses (HTTP 429) by sleeping for the duration in `Retry-After` (seconds) and retrying once; a second 429 MUST fail the run. |
| F-005-R8 | The system MUST NOT re-fetch tracks already in `tracks`; the upsert is `DO NOTHING`. |
| F-005-R9 | The fetch module MUST emit one log line per page with `page_index`, `items_seen`, `items_persisted`, `items_skipped`. |
| F-005-R10 | The fetch module MUST be safe to run twice in succession without producing duplicate rows. |
| F-005-R11 | The fetch module MUST tolerate Spotify returning at most 1 minute of clock skew on `added_at` values. |

## Database schema

```sql
CREATE TABLE tracks (
  spotify_id TEXT PRIMARY KEY,
  isrc TEXT,                          -- NULL when Spotify omits external_ids (R2)
  artist TEXT NOT NULL,
  title TEXT NOT NULL,
  album TEXT,                         -- NULLABLE: Spotify omits album on unusual content
  duration_ms INTEGER,                -- NULLABLE: Spotify omits duration_ms on unusual content
  spotify_added_at TIMESTAMPTZ NOT NULL,
  first_seen_at TIMESTAMPTZ DEFAULT now()  -- NULLABLE: set by DB default on insert
);

CREATE INDEX idx_tracks_isrc ON tracks(isrc) WHERE isrc IS NOT NULL;
CREATE INDEX idx_tracks_added_at ON tracks(spotify_added_at DESC);

CREATE TABLE sync_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT now()  -- NULLABLE: set by DB default on write
);
```

The cursor is stored as `key = 'spotify_cursor', value = '<ISO8601 timestamp>'`.

## Data effects

- Inserts new rows into `tracks`
- Upserts `sync_state` row for `spotify_cursor`

## Failure modes

| Mode | Cause | Recovery |
|---|---|---|
| HTTP 401 from Spotify | Token expired and not refreshed | Refresh helper triggers; retry once |
| HTTP 429 from Spotify | Rate limit | Honour `Retry-After`; one retry |
| HTTP 5xx from Spotify | Spotify outage | Abort run, retry on next schedule |
| Network timeout | Transient | Abort run, retry on next schedule |
| `track.external_ids` absent | Spotify catalog edge case | Persist with `isrc = NULL`; matching falls back to fuzzy |

## Acceptance criteria

- All tests in T-005 pass
- A first run on an account with N Liked Songs produces N rows in `tracks` and `sync_state.spotify_cursor` advanced to the most recent `added_at`
- A second run immediately after produces zero new rows and does not change the cursor
- Liking a new track on Spotify, then running the fetch, results in exactly one new row in `tracks`
