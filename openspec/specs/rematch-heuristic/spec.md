# rematch-heuristic Specification

## Purpose
TBD - created by archiving change f-025-rematch-heuristic. Update Purpose after archive.
## Requirements
### Requirement: Heuristic query builder

The Worker SHALL export a pure helper `buildRematchQuery(artist, title)` that
returns either a non-empty string formed as `firstTwoArtistWords + " " +
firstTitleWord` or `null` when the input is degenerate.

The helper SHALL:

1. Strip ASCII control characters (`\x00-\x1F` and `\x7F`) from both inputs.
2. Apply the existing `normaliseTitle` to the title before tokenising
   (removing remaster/year/feat. parentheticals).
3. Apply a light lower-case + diacritic-preserving + punctuation-stripping
   normalisation to the artist before tokenising (matching the existing
   `normalise` step inside `src/match/artist.ts`).
4. Split on whitespace, drop empty tokens.
5. Take the first two artist tokens (or one if only one exists) and the
   first title token.
6. Join with a single space.

The helper SHALL return `null` (not throw, not return an empty string) when:

- The artist tokenises to zero non-empty tokens, OR
- The title tokenises to zero non-empty tokens.

#### Scenario: Two-word artist + multi-word title

- **WHEN** `buildRematchQuery("Pink Floyd", "Comfortably Numb - Remaster")` is called
- **THEN** the result is `"pink floyd comfortably"`

#### Scenario: Single-word artist + multi-word title

- **WHEN** `buildRematchQuery("Beyoncé", "Single Ladies (Put a Ring on It)")` is called
- **THEN** the result is `"beyoncé single"`

#### Scenario: Artist with feat. suffix

- **WHEN** `buildRematchQuery("Drake feat. Lil Wayne", "HYFR")` is called
- **THEN** the result is `"drake feat hyfr"`

(NOTE: The artist normaliser drops the `feat.` *clause* only when it follows
the primary name with a separator; in raw `"Drake feat. Lil Wayne"` the
token `"feat"` survives because the normaliser leaves it as an unbounded
word. Tidal's relevance ranker copes with this fine; the heuristic is
optimised for the more common case of a multi-word primary artist.)

#### Scenario: Empty artist

- **WHEN** `buildRematchQuery("", "Halo")` is called
- **THEN** the result is `null`

#### Scenario: Empty title

- **WHEN** `buildRematchQuery("Beyoncé", "")` is called
- **THEN** the result is `null`

### Requirement: Sweep endpoint

The Worker SHALL expose `GET /unmatched/rematch?limit=N` that iterates pending
unmatched rows in `last_attempt_at DESC` order (same order as `GET /unmatched`)
up to `limit` rows, applies `buildRematchQuery` per row, calls
`searchTidalCandidates` per row that produced a valid query, and returns a
sweep payload describing each row.

The route SHALL be mounted on the existing `/unmatched` Hono router so it
inherits the CF Access JWT middleware (F-019).

The `limit` query parameter SHALL:

- Default to `10` when absent or empty.
- Reject (`400 invalid_limit`) any value outside `[1, 25]`.

The response body for a 200 SHALL be `application/json` with this shape:

```
{
  "items": [
    {
      "spotify_id": "string",
      "spotify_title": "string",
      "spotify_artist": "string",
      "query": "string | null",
      "candidates": [SearchResponseCandidate, ...],
      "error": "invalid_input" | "tidal_timeout" | "tidal_upstream" | "tidal_reauth_required" | null
    }
  ],
  "total_pending": <integer>,
  "fetched_at": "<ISO-8601>"
}
```

`total_pending` is the queue's total pending count (same as `GET /unmatched`'s
`total`), so the UI can show "ran rematch on N of M pending rows".

#### Scenario: Sweep with mixed success

- **WHEN** a CF Access-authenticated client calls `GET /unmatched/rematch?limit=3` and the queue contains three pending rows whose rematch queries succeed, produce zero candidates, and fail with a Tidal 502 respectively
- **THEN** the response status is 200, `items` has length 3, the first item has `candidates.length > 0` and `error: null`, the second has `candidates: []` and `error: null`, the third has `candidates: []` and `error: "tidal_upstream"`, and `total_pending` reflects the true queue size

#### Scenario: Sweep degenerate input is reported, not skipped

- **WHEN** a pending row has empty `spotify_artist` and the sweep visits it
- **THEN** the corresponding item has `query: null`, `candidates: []`, `error: "invalid_input"`, and the sweep continues to the next row

#### Scenario: Sweep limit clamping

- **WHEN** a client calls `GET /unmatched/rematch?limit=100`
- **THEN** the response status is 400 with `error: "invalid_limit"`

#### Scenario: Anonymous request is rejected before reaching the handler

- **WHEN** a request without a valid CF Access JWT calls `GET /unmatched/rematch`
- **THEN** the router-level middleware rejects with 401 and the sweep handler does not execute

### Requirement: Single-row variant

The Worker SHALL expose `GET /unmatched/:spotify_id/rematch` that returns the
heuristic's candidate list for a single pending row, sharing the response
shape with F-024's `GET /unmatched/:spotify_id/search` so the UI can render
the result with its existing candidate component.

The route SHALL:

- Return `404 unknown_spotify_id` when `:spotify_id` is not present in `tracks`.
- Return `400 invalid_input` when the row exists but `buildRematchQuery`
  returns `null` for its `(artist, title)` pair.
- Return `200` with the F-024 response shape (`{ query, candidates, fetched_at }`)
  on the happy path.
- Take a token from the F-024 per-principal rate-limit bucket on every call,
  emitting `429 rate_limited` with `Retry-After` when the bucket is empty.

#### Scenario: Single-row happy path

- **WHEN** a CF Access-authenticated client calls `GET /unmatched/<known-spotify-id>/rematch` for a row whose artist + title produces a valid query and Tidal returns at least one track
- **THEN** the response status is 200, the body matches the F-024 `SearchResponseBody` schema, `query` equals `buildRematchQuery(artist, title)`, and `candidates` is non-empty

#### Scenario: Unknown spotify_id

- **WHEN** a client calls `GET /unmatched/spotify:bogus/rematch`
- **THEN** the response status is 404 with `error: "unknown_spotify_id"`

#### Scenario: Degenerate metadata

- **WHEN** a known pending row has empty `artist` and a client calls `GET /unmatched/<that-id>/rematch`
- **THEN** the response status is 400 with `error: "invalid_input"`

### Requirement: Read-only contract

Both rematch routes SHALL be read-only. Neither route SHALL insert into
`matches`, update `unmatched.status`, mutate `unmatched.attempts`, nor write
any other DB row. Selection — committing one of the surfaced candidates as
the chosen match — SHALL continue to go through `POST /unmatched/:spotify_id/match`.

#### Scenario: Sweep does not mutate unmatched rows

- **WHEN** a sweep request completes (regardless of whether candidates were found)
- **THEN** every visited row's `unmatched.attempts` and `unmatched.last_attempt_at` are unchanged, and no new `matches` row is inserted

### Requirement: Structured logging

The Worker SHALL emit one structured JSON log line per sweep with
`event: "rematch_sweep"` carrying `limit`, `rows_visited`, counts per
error category, and `duration_ms`. The Worker SHALL emit one structured
JSON log line per row inside the sweep with `event: "rematch_row"` carrying
`spotify_id`, `q_len`, `result_count`, `tidal_status`, `error` (or `null`),
and `duration_ms`. Neither log line SHALL carry the raw query string, the
authenticated principal email, or any token material.

#### Scenario: Single-row variant log emission

- **WHEN** a single-row `GET /unmatched/:spotify_id/rematch` call completes
- **THEN** the Worker emits exactly one `event: "rematch_row"` log line with the fields above

