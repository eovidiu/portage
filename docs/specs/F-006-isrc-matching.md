# F-006: ISRC-based track matching

## Summary

For every `tracks` row that has an `isrc` and no entry in `matches` or `unmatched`, the system queries Tidal for a track with the same ISRC. If a result is found and the artist roughly matches the Spotify artist, the system records a match with method `isrc` and confidence `0.95`. ISRC matching is the first pass; misses fall through to F-007 (fuzzy matching).

## Linked tests

[T-006](../tests/T-006-isrc-matching.md)

## Dependencies

- F-003 (Tidal OAuth)
- F-005 (`tracks` populated)
- Postgres `matches` table

## Behavioural specification

### Match by ISRC, found and artist agrees

- **Given** a `tracks` row with `isrc = 'GBUM71029604'` and `artist = 'Adele'`
- **When** the matcher queries Tidal by ISRC
- **And** Tidal returns one or more candidates
- **And** the top candidate's `artists[0].name` is a token-match for `'Adele'` (case-insensitive, ignoring "feat." parts)
- **Then** the system writes a row to `matches` with `method = 'isrc'`, `confidence = 0.95`, `tidal_id = <candidate_id>`, `matched_at = now()`, `sync_run_id = <current run>`

### Match by ISRC, found but artist disagrees

- **Given** Tidal returns a candidate whose artist does not match
- **When** the matcher inspects the candidate
- **Then** the candidate is rejected
- **And** the track is passed to F-007 (fuzzy matching)
- **And** a debug log line records `isrc_artist_mismatch` with the spotify_id and the candidate Tidal ID

### Match by ISRC, multiple results

- **Given** Tidal returns more than one track for the ISRC
- **When** the matcher inspects results
- **Then** it picks the candidate whose `duration` is closest to the Spotify `duration_ms` (within 2000 ms tolerance)
- **And** if no candidate is within tolerance, falls through to F-007

### No ISRC on the Spotify track

- **Given** a `tracks` row with `isrc IS NULL`
- **When** the matcher runs
- **Then** the ISRC stage is skipped entirely
- **And** the track is passed directly to F-007

### Tidal returns no result

- **Given** an ISRC query that yields zero results
- **When** the matcher inspects the response
- **Then** the track is passed to F-007

## Detailed requirements

| ID | Requirement |
|---|---|
| F-006-R1 | The matcher MUST query Tidal's `tracks` endpoint filtered by ISRC. The exact endpoint and parameter shape MUST be sourced from the Tidal Open API reference and committed to a constants file. |
| F-006-R2 | The system MUST set `countryCode` per F-003-R8. |
| F-006-R3 | The match decision MUST require artist agreement using token-sort comparison after lowercasing and stripping `"feat."`, `"ft."`, `"featuring"`, and parenthetical content. |
| F-006-R4 | The artist agreement threshold MUST be `>= 0.85` token-sort ratio (range 0..1). |
| F-006-R5 | When multiple candidates are returned, the matcher MUST select by minimum `abs(candidate.duration_ms - track.duration_ms)`. |
| F-006-R6 | The duration tolerance MUST be 2000 ms; candidates outside this MUST be rejected. |
| F-006-R7 | A successful ISRC match MUST be written with `confidence = 0.95` and `method = 'isrc'`. |
| F-006-R8 | The matcher MUST NOT call Tidal more than once per `spotify_id` per run for the ISRC stage. |
| F-006-R9 | If Tidal returns HTTP 401, the matcher MUST trigger a token refresh and retry once. |
| F-006-R10 | If Tidal returns HTTP 429, the matcher MUST sleep for `Retry-After` and retry once; a second 429 MUST be recorded as a per-track error and the track passed to F-007. |
| F-006-R11 | All Tidal API responses MUST be parsed defensively; missing fields MUST NOT crash the matcher. |
| F-006-R12 | ISRC values MUST be normalised to uppercase before being passed to Tidal `/v2/tracks?filter[isrc]=...`. ISO 3901 mandates uppercase; Spotify sometimes returns lowercase legacy entries; Tidal returns HTTP 400 for those. |

## Algorithm: artist agreement

```
function artistAgrees(spotifyArtist: string, tidalArtist: string): boolean {
  const normalise = (s: string) =>
    s.toLowerCase()
     .replace(/\bfeat(\.|uring)?\b.*$/i, '')
     .replace(/\bft\.?\b.*$/i, '')
     .replace(/\([^)]*\)/g, '')
     .replace(/[^\p{L}\p{N}\s]/gu, '')
     .trim();
  const a = normalise(spotifyArtist);
  const b = normalise(tidalArtist);
  return tokenSortRatio(a, b) >= 0.85;
}
```

`tokenSortRatio` is the standard rapidfuzz definition: split on whitespace, sort tokens, then Levenshtein-based similarity ratio.

## Database schema

```sql
CREATE TABLE matches (
  spotify_id TEXT PRIMARY KEY REFERENCES tracks(spotify_id),
  tidal_id TEXT NOT NULL,
  method TEXT NOT NULL CHECK (method IN ('isrc', 'fuzzy', 'manual')),
  confidence NUMERIC(3,2) NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  matched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  sync_run_id UUID
);

CREATE INDEX idx_matches_tidal ON matches(tidal_id);
```

## Data effects

- Inserts a single row into `matches` per matched track
- No effect on `tracks` or `unmatched` from this feature alone

## Failure modes

| Mode | Cause | Recovery |
|---|---|---|
| Tidal returns 5xx | Tidal infra | Per-track error; track is retried on next run |
| ISRC mismatch on artist | Catalog inconsistency, regional release | Fall through to F-007 |
| ISRC absent on Spotify track | Spotify metadata gap | Skip ISRC stage; F-007 handles it |

## Acceptance criteria

- All tests in T-006 pass
- For a curated test set of 20 mainstream tracks with known ISRCs, the system matches at least 18 via the ISRC path
- A track with a deliberately corrupted ISRC (random 12 chars) does not produce a false match
- A track whose Tidal candidate's artist disagrees does not produce a match through this feature
