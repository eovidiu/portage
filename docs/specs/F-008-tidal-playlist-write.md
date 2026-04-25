# F-008: Tidal playlist write

## Summary

After matching, the system writes newly-matched Tidal track IDs into a designated Tidal playlist. The playlist is created on first sync if it does not exist; its ID is stored in `sync_state`. The system de-duplicates against the playlist's current contents to avoid re-adding tracks. Adds are batched per Tidal's API constraints.

## Linked tests

[T-008](../tests/T-008-tidal-playlist-write.md)

## Dependencies

- F-003 (Tidal OAuth)
- F-006 / F-007 (matches must exist before write)

## Behavioural specification

### Ensure playlist exists, first run

- **Given** `sync_state.tidal_playlist_id` is unset
- **When** the writer module starts
- **Then** the system creates a Tidal playlist named per configuration (default: `Spotify Liked`)
- **And** persists the returned playlist id to `sync_state.tidal_playlist_id`

### Ensure playlist exists, subsequent runs

- **Given** `sync_state.tidal_playlist_id` is set
- **When** the writer module starts
- **Then** the system fetches the playlist by id
- **And** if the playlist no longer exists or is inaccessible, the system creates a new one and updates `sync_state.tidal_playlist_id`
- **And** logs a `playlist_recreated` event with the previous and new ids

### Append new matches

- **Given** matches with `matched_at > last_playlist_write_at`
- **When** the writer module runs
- **Then** the system fetches the current playlist track ids (paginated)
- **And** filters new matches to exclude any `tidal_id` already in the playlist
- **And** appends remaining `tidal_id`s in chronological order of `matched_at` (oldest first)

### Idempotency on partial failure

- **Given** a write batch fails partway through
- **When** the writer retries on the next run
- **Then** the de-duplication ensures no track is added twice
- **And** previously-added tracks from the failed run are preserved

### Track removed from Tidal catalog

- **Given** a `matches.tidal_id` that no longer exists in Tidal
- **When** the system attempts to add it to the playlist
- **And** Tidal returns an error indicating the track is invalid
- **Then** the system marks the match row with `tidal_id_invalid = true` (column added by this feature)
- **And** moves the corresponding `spotify_id` back to `unmatched` with `reason = 'tidal_track_removed'`
- **And** continues with remaining tracks in the batch

## Detailed requirements

| ID | Requirement |
|---|---|
| F-008-R1 | The playlist title MUST be configurable via `TIDAL_PLAYLIST_TITLE` env var, defaulting to `"Spotify Liked"`. |
| F-008-R2 | The playlist description MUST be `"Synced from Spotify by spotify-roon-sync. Do not edit manually."`. |
| F-008-R3 | The playlist MUST be created with privacy set to private. |
| F-008-R4 | The system MUST batch additions per Tidal's API limit; the batch size MUST be sourced from the Tidal Open API reference at implementation time and committed to a constants file. The default batch size MUST NOT exceed 100. |
| F-008-R5 | The system MUST de-duplicate against the playlist's current contents before adding. |
| F-008-R6 | The order of additions in a single run MUST be ascending by `matched_at`. |
| F-008-R7 | If the playlist write API returns HTTP 401, the system MUST refresh the Tidal token (F-003) and retry once. |
| F-008-R8 | If the playlist write API returns HTTP 429, the system MUST honour `Retry-After` and retry once; a second 429 MUST end the batch and record `errors += <remaining>` in the run summary. |
| F-008-R9 | The system MUST NOT remove tracks from the playlist as part of normal sync. Removal is out of scope for v1. |
| F-008-R10 | After a successful write run, `sync_state.last_playlist_write_at` MUST be set to `now()`. |
| F-008-R11 | If `sync_state.tidal_playlist_id` exists but the playlist is gone, the system MUST recreate. The previous playlist MUST NOT be referenced again. |

## Database schema additions

```sql
ALTER TABLE matches ADD COLUMN tidal_id_invalid BOOLEAN NOT NULL DEFAULT false;

-- sync_state keys used by this feature:
-- 'tidal_playlist_id'
-- 'last_playlist_write_at'
```

## Data effects

- Creates or updates `sync_state.tidal_playlist_id`
- Updates `sync_state.last_playlist_write_at` on success
- May flip `matches.tidal_id_invalid` and re-queue to `unmatched`

## Failure modes

| Mode | Cause | Recovery |
|---|---|---|
| Playlist created twice | Concurrent runs (should not occur due to F-009 lock, but defensive) | Manually merge in Tidal; update `sync_state` to point at the survivor |
| Playlist hits Tidal's max track limit | User has thousands of likes | Configure a second playlist; out of scope for v1, document and surface the error |
| Tidal returns 5xx on every request | Tidal outage | Abort write phase; matches remain pending playlist write; retry next run |

## Acceptance criteria

- All tests in T-008 pass
- A first run creates a playlist and adds all matched tracks
- A second run with no new matches makes zero playlist writes
- A run after a track is unmatched then matched manually adds the track to the playlist exactly once
- A run that fails partway and is re-run does not duplicate any track in the playlist
