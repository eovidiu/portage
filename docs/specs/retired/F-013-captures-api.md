# F-013: Captures API (iOS-ready)

## Summary

A capture is an explicit "save for sync" event from a future client (iOS app, Shortcut, share sheet). It carries a Spotify track id and optional context (location, source, note). Captures feed into the same matching pipeline as Liked Songs, but with richer metadata. This feature implements the API surface; the iOS app that consumes it is out of scope.

## Linked tests

[T-013](../tests/T-013-captures-api.md)

## Dependencies

- F-001 (auth)
- F-009 (orchestrator picks up captures during the next run)

## Behavioural specification

### Create a capture

- **Given** a valid JWT
- **And** a body `{ "spotify_id": "<id>", "captured_at": "<iso8601>", "location_lat": <num>, "location_lng": <num>, "source": "siri" | "share_sheet" | "shortcut" | "manual", "context_note": "<string>" }`
- **When** the client calls `POST /captures`
- **Then** the system validates the body
- **And** if `tracks.spotify_id` does not exist, fetches the track from Spotify, persists it, and proceeds
- **And** inserts a `captures` row
- **And** if no `matches` row or `unmatched` row exists for `spotify_id`, queues it for processing on the next sync run by leaving it in `tracks` (the orchestrator will pick it up via a "process orphan tracks" step)
- **And** responds HTTP 201 with the new row

### List captures

- **Given** a valid JWT
- **When** the client calls `GET /captures?limit=50`
- **Then** the response is recent captures with their match status (matched / unmatched / pending), ordered by `captured_at DESC`

### Idempotent capture

- **Given** a duplicate `POST /captures` with the same `spotify_id` within 60 seconds
- **When** the system processes it
- **Then** the original capture is returned (no duplicate row inserted)

### Required fields

- **Given** a body missing `spotify_id`
- **When** the client posts
- **Then** the response is HTTP 400 with `{"error": "missing_spotify_id"}`

## Detailed requirements

| ID | Requirement |
|---|---|
| F-013-R1 | All endpoints in this feature MUST require JWT (F-001). |
| F-013-R2 | The `spotify_id` MUST match the regex `^[A-Za-z0-9]{22}$`; mismatches MUST return HTTP 400. |
| F-013-R3 | `captured_at`, if provided, MUST be a valid ISO 8601 timestamp; otherwise the server MUST default it to `now()`. |
| F-013-R4 | `location_lat` MUST be in [-90, 90] when provided; `location_lng` MUST be in [-180, 180]. |
| F-013-R5 | `source` MUST be one of `siri`, `share_sheet`, `shortcut`, `manual`. |
| F-013-R6 | `context_note` MUST be at most 500 characters. |
| F-013-R7 | If the referenced track is not in `tracks`, the system MUST fetch it from Spotify and persist it before inserting the capture. |
| F-013-R8 | A capture MUST NOT immediately trigger a sync run; the next scheduled run will process orphan tracks. |
| F-013-R9 | The orchestrator (F-009) MUST be extended to process tracks that have no entry in `matches` or `unmatched` (orphans), in addition to tracks newly fetched in F-005. |
| F-013-R10 | Idempotency: two `POST /captures` with the same `spotify_id` within 60 seconds MUST result in a single `captures` row; the response MUST be HTTP 200 (not 201) on the duplicate. |
| F-013-R11 | The `captures` table MUST persist forever (per architecture §7); no automatic deletion. |

## Database schema

```sql
CREATE TABLE captures (
  capture_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  spotify_id TEXT NOT NULL REFERENCES tracks(spotify_id),
  captured_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  location_lat NUMERIC(9, 6),
  location_lng NUMERIC(9, 6),
  source TEXT NOT NULL CHECK (source IN ('siri', 'share_sheet', 'shortcut', 'manual')),
  context_note TEXT
);

CREATE INDEX idx_captures_spotify_id ON captures(spotify_id);
CREATE INDEX idx_captures_captured_at ON captures(captured_at DESC);
```

## API contract

### `POST /captures`

Request:
```
{
  "spotify_id": "3n3Ppam7vgaVa1iaRUc9Lp",
  "captured_at": "2026-04-25T14:32:00Z",
  "location_lat": 44.4268,
  "location_lng": 26.1025,
  "source": "siri",
  "context_note": "saw cover in coffee shop"
}
```

Response:
```
HTTP/1.1 201 Created
Content-Type: application/json

{
  "capture_id": "9c2b...",
  "spotify_id": "3n3Ppam7vgaVa1iaRUc9Lp",
  "captured_at": "2026-04-25T14:32:00Z",
  "location_lat": 44.4268,
  "location_lng": 26.1025,
  "source": "siri",
  "context_note": "saw cover in coffee shop",
  "match_status": "pending"
}
```

### `GET /captures?limit=50`

```
HTTP/1.1 200 OK
Content-Type: application/json

{
  "items": [
    {
      "capture_id": "9c2b...",
      "spotify_id": "...",
      "captured_at": "...",
      "source": "siri",
      "match_status": "matched" | "unmatched" | "pending",
      "tidal_id": "12345"
    }
  ]
}
```

## Data effects

- Inserts into `captures`
- May insert into `tracks` for orphan track creation

## Failure modes

| Mode | Cause | Recovery |
|---|---|---|
| Spotify track not found on fetch | Bad `spotify_id` from client | HTTP 400 `spotify_track_not_found` |
| Spotify token unauthorised on fetch | OAuth state | HTTP 503; operator must reauth |
| Validation failure | Bad client input | HTTP 400 with field name |

## Acceptance criteria

- All tests in T-013 pass
- A capture for an unknown Spotify track id results in the track being fetched and persisted, the capture being created, and the track being matched on the next sync run
- A duplicate capture within 60 seconds returns HTTP 200 with the same `capture_id`
- A capture with invalid coordinates returns HTTP 400
