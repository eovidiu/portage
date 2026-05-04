# F-012: Unmatched review queue

## Summary

Tracks that fail automated matching land in `unmatched` with `status = 'pending'`. The system exposes endpoints to list pending items, manually pair them with a Tidal track, or skip them permanently. A manual match is treated identically to an automated match in downstream features (F-008 will add it to the playlist on the next run).

## Linked tests

[T-012](../tests/T-012-unmatched-queue.md)

## Dependencies

- F-007 (writes to `unmatched`)
- F-001 (all endpoints require JWT)
- F-008 (the next sync run will write the manually-matched track to the playlist)

## Behavioural specification

### List pending unmatched

- **Given** there are pending rows in `unmatched`
- **When** the client calls `GET /unmatched?limit=50`
- **Then** the response includes pending rows joined with their `tracks` row, ordered by `last_attempt_at DESC`
- **And** for each row, returns the top 5 fuzzy candidates with their scores (re-fetched from Tidal at request time, not cached)

### Manual match

- **Given** a pending `unmatched` row for `spotify_id`
- **And** a target `tidal_id` chosen by the operator
- **When** the client calls `POST /unmatched/<spotify_id>/match` with body `{"tidal_id": "<tidal_id>"}`
- **Then** the system verifies the `tidal_id` resolves to a real Tidal track
- **And** inserts a row into `matches` with `method = 'manual'`, `confidence = 1.00`
- **And** updates `unmatched.status = 'matched'`
- **And** responds HTTP 200 with the new match row

### Manual match, invalid Tidal id

- **Given** a `tidal_id` that does not resolve
- **When** the client posts the match
- **Then** the response is HTTP 400 with `{"error": "tidal_track_not_found"}`
- **And** no rows are modified

### Skip

- **Given** a pending `unmatched` row
- **When** the client calls `POST /unmatched/<spotify_id>/skip`
- **Then** `unmatched.status = 'skipped'`
- **And** the row is excluded from future automated re-attempts
- **And** the response is HTTP 200 with the updated row

### Re-attempt on next run

- **Given** a pending row whose `last_attempt_at` is older than 7 days
- **When** the next sync run executes
- **Then** the matcher (F-007) re-evaluates this track in addition to new tracks
- **And** if a match is found, the `unmatched.status` is set to `matched`

## Detailed requirements

| ID | Requirement |
|---|---|
| F-012-R1 | `GET /unmatched` MUST require JWT. |
| F-012-R2 | `GET /unmatched?limit=<n>` MUST cap `limit` at 100; default 20. |
| F-012-R3 | The response for each unmatched row MUST include the original Spotify track metadata and the current top 5 Tidal candidates with scores from F-007's algorithm. |
| F-012-R4 | The candidate fetch MUST timeout at 10 seconds total across all rows in the response; on timeout, candidates field MUST be `[]` and a partial response returned with HTTP 200. |
| F-012-R5 | `POST /unmatched/:spotify_id/match` MUST validate the body schema; missing or non-string `tidal_id` MUST return HTTP 400. |
| F-012-R6 | The system MUST verify the `tidal_id` exists by calling Tidal's track-by-id endpoint; a 404 from Tidal MUST yield HTTP 400 to the caller. |
| F-012-R7 | A successful manual match MUST insert into `matches` with `method = 'manual'`, `confidence = 1.00`, and `sync_run_id = NULL`. |
| F-012-R8 | The unmatched row's `status` transition MUST be atomic with the matches insert (single transaction). |
| F-012-R9 | `POST /unmatched/:spotify_id/skip` MUST be idempotent; calling it on an already-skipped row MUST return HTTP 200 with no further changes. |
| F-012-R10 | `unmatched` rows with `status = 'skipped'` MUST never be re-evaluated by F-007 again. |
| F-012-R11 | Pending rows older than 7 days MUST be re-evaluated on the next sync run. |

## API contract

### `GET /unmatched?limit=20`

```
HTTP/1.1 200 OK
Content-Type: application/json

{
  "items": [
    {
      "spotify_id": "3n3Ppam7vgaVa1iaRUc9Lp",
      "spotify_artist": "Mr. Mister",
      "spotify_title": "Kyrie",
      "spotify_album": "Welcome to the Real World",
      "isrc": "USRC18551064",
      "reason": "fuzzy_below_threshold",
      "attempts": 2,
      "last_attempt_at": "2026-04-25T07:23:42.118Z",
      "candidates": [
        { "tidal_id": "12345", "title": "Kyrie", "artist": "Mr. Mister", "album": "Welcome to the Real World", "duration_ms": 263000, "score": 0.83 }
      ]
    }
  ]
}
```

### `POST /unmatched/:spotify_id/match`

Request:
```
{ "tidal_id": "12345" }
```

Response on success:
```
HTTP/1.1 200 OK
Content-Type: application/json

{ "spotify_id": "3n3Ppam7vgaVa1iaRUc9Lp", "tidal_id": "12345", "method": "manual", "confidence": 1.00, "matched_at": "2026-04-25T08:00:00Z" }
```

### `POST /unmatched/:spotify_id/skip`

Response:
```
HTTP/1.1 200 OK
Content-Type: application/json

{ "spotify_id": "3n3Ppam7vgaVa1iaRUc9Lp", "status": "skipped" }
```

## Data effects

- Inserts a `matches` row on manual match
- Updates `unmatched.status` to `matched` or `skipped`

## Failure modes

| Mode | Cause | Recovery |
|---|---|---|
| Race between auto-match and manual match | Operator clicks while sync runs | F-012-R8's transaction prevents inconsistency |
| Tidal track-by-id 5xx | Tidal infra | Return HTTP 503; operator retries |
| Operator picks a different-genre Tidal track | Operator error | Manually skip; pick again or live with it |

## Acceptance criteria

- All tests in T-012 pass
- A pending row, after manual match, appears in the Tidal playlist on the next sync
- Skipping a pending row prevents it from ever being processed by F-007 again
- Listing unmatched returns within 10 seconds even with 50 pending rows

## Amendment 2026-05-04: skip semantics are manual-only

Clarification (no behaviour change): `unmatched.status = 'skipped'` is set
ONLY via `POST /unmatched/:spotify_id/skip` (F-012-R9). There is **no
automatic age-based eviction** — pending rows older than N days are NOT
auto-promoted to skipped. The only automatic behaviour for stale pending
rows is F-007's 7-day cooldown re-evaluation (F-012-R11): they are
re-attempted, with success transitioning to matched and failure leaving
status='pending' with attempts incremented.

This is by design. Operator/iOS-driven curation owns the skip decision; the
system does not silently abandon tracks that the user might want manually
matched. Operationally this means:

- The `unmatched`-pending queue grows monotonically until manually serviced.
- The wrangler.toml comment historically referencing "skipped-unmatched" as
  a drain criterion was misleading and was removed in PR #5; the actual
  drain criterion is `truly_unprocessed = 0` via LEFT JOIN (every track is
  in either `matches` or `unmatched`, regardless of unmatched status).
- T-012-11 / T-012-12 cover the route-level skip behaviour. DB-layer SQL
  emission for `markSkipped` is unit-tested in tests/db/unmatched.test.ts.
