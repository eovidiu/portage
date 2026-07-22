# spotify-catalog-search Specification

## Purpose
ISRC-first lookup and fuzzy text search of the Spotify catalog for the tidal_to_spotify copy direction, with rate-limit-aware retries. Created by archiving change playlist-copy.
## Requirements

### Requirement: ISRC lookup
The Worker SHALL look up Spotify tracks by ISRC via
`GET /v1/search?q=isrc:<code>&type=track&limit=10`, uppercasing the ISRC, and SHALL
accept a candidate only when the artist agrees (same normalization rules as the
Tidal ISRC matcher) and duration is within ±2000 ms of the source track.

#### Scenario: ISRC hit with agreeing artist
- **WHEN** the search returns a track whose artist agrees and duration is in
  tolerance
- **THEN** the candidate is accepted with confidence 0.95 and method `isrc`

#### Scenario: ISRC hit with wrong artist rejected
- **WHEN** the only ISRC result's artist does not agree
- **THEN** the lookup returns no match and the track falls through to fuzzy search

### Requirement: Fuzzy text search
The Worker SHALL search Spotify by a text query built from title and artist
(`limit=10`, the documented maximum for `/v1/search`), map results to the shared
candidate shape, and rank them with the existing `score.ts` weights (title .40 /
artist .30 / duration .20 / album .10). The 0.80 acceptance threshold applies; the
top 3 candidates SHALL be surfaced when no candidate reaches it.

#### Scenario: Fuzzy match above threshold
- **WHEN** the best-ranked candidate scores ≥ 0.80
- **THEN** it is accepted with method `fuzzy` and the achieved confidence

#### Scenario: Candidates preserved on rejection
- **WHEN** no candidate reaches 0.80
- **THEN** the top 3 candidates (id, title, artist, album, score) are returned for
  persistence

### Requirement: Rate-limit handling
Search calls SHALL treat 429 responses by honoring `Retry-After` once; a repeated
429 SHALL leave the affected track `pending` for a later tick rather than failing
the job.

#### Scenario: Search rate-limited twice
- **WHEN** both the call and its retry return 429
- **THEN** the track stays `pending` and the tick ends without job failure
