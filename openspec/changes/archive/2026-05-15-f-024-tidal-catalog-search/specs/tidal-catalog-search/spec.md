## ADDED Requirements

### Requirement: Endpoint shape and authenticated access

The Worker SHALL expose `GET /unmatched/:spotify_id/search` that accepts an authenticated, well-formed query and returns a flat list of Tidal track candidates suitable for direct UI rendering. The route SHALL be mounted on the existing `/unmatched` Hono router so it inherits the Cloudflare Access JWT middleware (F-019) applied at the router level.

The response body for a 200 SHALL be `application/json` with this shape:

```
{
  "query": "string",
  "candidates": [
    {
      "tidal_id": "string",
      "title": "string",
      "artists": ["string"],
      "album": "string|null",
      "duration_ms": <integer>,
      "isrc": "string|null"
    }
  ],
  "fetched_at": "<ISO-8601 timestamp>"
}
```

The response SHALL NOT include a `confidence` field — confidence is fuzzy-only (F-007) and has no meaning for user-driven queries. The `candidates` array MAY be empty when Tidal returns no matches; an empty result is not an error.

#### Scenario: Authenticated request returns candidate list

- **WHEN** a request authenticated by Cloudflare Access calls `GET /unmatched/<known-spotify-id>/search?q=Metallica+One` and Tidal returns at least one track
- **THEN** the response status is 200, the body matches the schema above, `candidates` is non-empty, every candidate has a non-empty `tidal_id` and `title`, and no candidate includes a `confidence` field

#### Scenario: Anonymous request is rejected before reaching the handler

- **WHEN** a request without a valid Cloudflare Access JWT calls `GET /unmatched/<any-id>/search?q=anything`
- **THEN** the router-level CF Access middleware rejects with 401 and the F-024 handler does not execute (no Tidal upstream call is made)

#### Scenario: Empty upstream result returns 200 with empty candidates

- **WHEN** a request authenticates successfully and `q` matches no tracks at Tidal
- **THEN** the response status is 200 and the body has `candidates: []` with the original `query` echoed back

---

### Requirement: Query and limit validation

The handler SHALL validate `q` and `limit` before any upstream call. `q` MUST be present, a string of length 1–200 (inclusive) after trimming, and MUST NOT contain any character matching `/[\x00-\x1F]/`. `limit` MUST be an integer in the inclusive range 1–25, defaulting to 10 when absent. Invalid input SHALL produce a 400 response with body `{ "error": "<code>", "message": "<human-readable detail>" }` and SHALL NOT issue any Tidal request.

#### Scenario: Missing q returns 400

- **WHEN** the request omits the `q` query parameter
- **THEN** the response status is 400 with `error: "invalid_query"` and no Tidal upstream call is recorded

#### Scenario: q exceeding 200 characters returns 400

- **WHEN** `q` is 201 characters long
- **THEN** the response status is 400 with `error: "invalid_query"` and no Tidal upstream call is recorded

#### Scenario: q containing a control character returns 400

- **WHEN** `q` contains a `\x07` (BEL) character
- **THEN** the response status is 400 with `error: "invalid_query"` and no Tidal upstream call is recorded

#### Scenario: limit above 25 returns 400

- **WHEN** `limit=26`
- **THEN** the response status is 400 with `error: "invalid_limit"` and no Tidal upstream call is recorded

#### Scenario: limit absent defaults to 10

- **WHEN** the request omits `limit` and Tidal returns 30 candidates
- **THEN** the response `candidates` array has length 10

---

### Requirement: Tidal proxy mapping

The handler SHALL call Tidal's catalog search at `https://openapi.tidal.com/v2/searchResults/{encodeURIComponent(q)}?include=tracks,tracks.artists,tracks.albums` via the existing `tidalFetch` wrapper (which auto-injects `countryCode` from `env.TIDAL_COUNTRY_CODE`, applies the `application/vnd.api+json` Accept header, and handles 401 with cache invalidation + token refresh + single retry). The handler SHALL parse the JSON:API response body, walk `data.relationships.tracks.data[]` for track refs, resolve each ref against `included[]`, and map each resolved track into the flat candidate shape defined in R1. The handler SHALL slice the resulting array to at most `limit` items. The handler SHALL NOT pass `page[cursor]` to upstream in v1 — only the first upstream page is consumed.

Mapping rules per candidate:
- `tidal_id` = `data.id` of the track resource
- `title` = `attributes.title` (string)
- `artists` = ordered array of `attributes.name` from each artist resource referenced by `relationships.artists.data[]` and resolved via `included[]`; empty array if no artists are resolvable
- `album` = `attributes.title` of the first album resolved via `relationships.albums.data[0]`; `null` if no album resolvable
- `duration_ms` = `parseIsoDurationMs(attributes.duration)`; 0 if duration is missing or unparseable
- `isrc` = `attributes.isrc` (string) or `null` if absent

#### Scenario: JSON:API response maps to flat candidates

- **WHEN** Tidal returns a `SearchResults_Single_Resource_Data_Document` with three track refs in `data.relationships.tracks.data` and full track/artist/album resources in `included`
- **THEN** the response `candidates` array has length 3, ordered as Tidal returned them, with every candidate's `artists` non-empty and `album` populated

#### Scenario: Track with missing album in included still returns candidate

- **WHEN** Tidal returns a track ref whose `relationships.albums.data[0]` cannot be resolved in `included[]`
- **THEN** the candidate is still returned with `album: null` (the missing album does not cause the candidate to be dropped)

#### Scenario: Upstream returns track with unparseable duration

- **WHEN** a track's `attributes.duration` is an empty string or malformed ISO-8601
- **THEN** the candidate is returned with `duration_ms: 0` (the track is not dropped)

#### Scenario: Tidal returns more candidates than limit

- **WHEN** Tidal's first page contains 15 track refs and the request specified `limit=5`
- **THEN** the response `candidates` array has exactly 5 items, ordered as Tidal returned them

---

### Requirement: Rate limiting per principal

The handler SHALL enforce a token-bucket rate limit of 10 requests per 60 seconds keyed on the `cf-access-authenticated-user-email` header. When a principal exhausts their bucket, the handler SHALL respond 429 with body `{ "error": "rate_limited", "message": "..." }` and a `Retry-After` header indicating seconds until the next token. The handler SHALL NOT issue any Tidal upstream call when the bucket is empty.

The rate limit is per-isolate in v1 (state lives in module-scope memory and persists for the warm isolate lifetime). Upgrading to KV or Durable Objects is a non-breaking future change.

#### Scenario: 11th request within 60 seconds is rate-limited

- **WHEN** the same authenticated principal issues 11 successful requests within 60 seconds in a single warm isolate
- **THEN** the 11th response status is 429 with `error: "rate_limited"` and a `Retry-After` header whose integer value is between 1 and 60 inclusive, and no Tidal upstream call is made for the 11th request

#### Scenario: Different principals do not share buckets

- **WHEN** principal A has consumed its bucket and principal B issues its first request
- **THEN** principal B's request proceeds normally with status 200 (or whatever the upstream returns)

---

### Requirement: Error taxonomy

The handler SHALL surface a documented set of error responses, each with body `{ "error": "<code>", "message": "<human-readable detail>" }`. The codes are:

| HTTP | error code | Meaning |
|---|---|---|
| 400 | `invalid_query` | `q` failed validation (length, control chars, missing) |
| 400 | `invalid_limit` | `limit` failed validation (range, non-integer) |
| 401 | (handled upstream by CF Access middleware) | no valid CF Access JWT |
| 404 | `unknown_spotify_id` | `:spotify_id` does not exist in the `tracks` table |
| 429 | `rate_limited` | token bucket exhausted for this principal |
| 502 | `tidal_reauth_required` | `tidalFetch` threw `TidalReauthRequired` (refresh token invalid) |
| 502 | `tidal_upstream_error` | Tidal returned non-2xx after the single 429+Retry-After retry, or returned malformed JSON:API |
| 504 | `tidal_timeout` | Tidal upstream did not respond within 3 seconds (including the retry attempt window) |

#### Scenario: Unknown spotify_id returns 404 without calling Tidal

- **WHEN** the request authenticates and validates successfully but `:spotify_id` does not exist in `tracks`
- **THEN** the response status is 404 with `error: "unknown_spotify_id"` and no Tidal upstream call is made

#### Scenario: Tidal 502 after single retry exhausted surfaces as 502

- **WHEN** Tidal returns 503 on first call and 503 again on the post-`Retry-After` retry
- **THEN** the response status is 502 with `error: "tidal_upstream_error"`

#### Scenario: TidalReauthRequired surfaces as 502 with tidal_reauth_required

- **WHEN** `tidalFetch` throws `TidalReauthRequired` because the refresh token is invalid
- **THEN** the response status is 502 with `error: "tidal_reauth_required"` and a `message` that does not echo any token material

#### Scenario: Tidal upstream timeout surfaces as 504

- **WHEN** Tidal does not respond within 3 seconds across both the initial call and any 429 retry window
- **THEN** the response status is 504 with `error: "tidal_timeout"`

#### Scenario: Malformed upstream JSON surfaces as 502

- **WHEN** Tidal returns HTTP 200 but the body is not parseable as JSON:API
- **THEN** the response status is 502 with `error: "tidal_upstream_error"`

---

### Requirement: Security and observability

The handler SHALL enforce the following security and observability invariants:

- The Tidal bearer token SHALL be loaded only through the existing `tidalFetch` wrapper. The token SHALL NOT appear in the response body, response headers, log lines, or any error message returned to the caller.
- Cloudflare Access JWT verification is delegated to the F-019 router-level middleware. The handler SHALL NOT itself parse or trust any caller-supplied authentication header.
- For each request, the handler SHALL emit exactly one structured log line with `event: "manual_search"` and the following fields: `spotify_id` (string), `q_len` (integer), `result_count` (integer or null on error), `tidal_status` (integer or null), `duration_ms` (integer wall-clock).
- The structured log line SHALL NOT include the raw value of `q`, the CF Access email, any token material, or any response body content.
- The Tidal upstream call SHALL have a hard timeout of 3 seconds (covering at most one initial call plus one `Retry-After` retry). On timeout, the handler returns 504 per R5.

#### Scenario: Successful search emits one structured log without raw q

- **WHEN** a successful request completes with 5 candidates
- **THEN** exactly one log line is emitted with `event: "manual_search"`, `q_len` equal to the trimmed query length, `result_count: 5`, a numeric `tidal_status: 200`, and a numeric `duration_ms`, and the log line does NOT contain the raw query string or the CF Access email

#### Scenario: Tidal error response does not leak token in error body

- **WHEN** Tidal returns 401 and `tidalFetch` cannot refresh (TidalReauthRequired path)
- **THEN** the 502 response body's `message` field does NOT contain any substring matching a JWT-shaped pattern (`eyJ...`) and does NOT contain the configured Tidal client id

#### Scenario: 3-second upstream timeout enforced

- **WHEN** the Tidal upstream call is artificially delayed past 3 seconds in a test
- **THEN** the response status is 504 within 3.5 seconds of the request start (allowing 500ms scheduling slack)
