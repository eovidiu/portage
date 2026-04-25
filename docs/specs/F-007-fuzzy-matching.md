# F-007: Fuzzy track matching fallback

## Summary

Tracks not resolved by F-006 fall through to fuzzy matching. The system queries Tidal by `artist + title`, scores up to the top 5 results across title similarity, artist match, duration delta, and album bonus, and accepts the highest-scoring candidate if its score is at least `0.85`. Below `0.85`, the track is queued in `unmatched` for manual review (F-012).

## Linked tests

[T-007](../tests/T-007-fuzzy-matching.md)

## Dependencies

- F-006 (the only path that triggers F-007 is an ISRC miss)
- F-003 (Tidal OAuth)

## Behavioural specification

### Fuzzy match accepted

- **Given** a track passed from F-006
- **When** the matcher queries Tidal with `q = "<artist> <title>"`
- **And** scores the top 5 candidates
- **And** the highest score is `>= 0.85`
- **Then** the system writes a row to `matches` with `method = 'fuzzy'`, `confidence = <score rounded to 0.01>`, `tidal_id = <candidate_id>`

### Fuzzy match below threshold

- **Given** the highest score is `< 0.85`
- **When** the matcher inspects the score
- **Then** the system inserts or updates an `unmatched` row for `spotify_id` with `reason = 'fuzzy_below_threshold'`, `attempts = attempts + 1`, `last_attempt_at = now()`, `status = 'pending'`

### Fuzzy match, no candidates returned

- **Given** Tidal returns zero results for the search
- **When** the matcher inspects the empty result
- **Then** the system inserts or updates `unmatched` with `reason = 'no_candidates'`

## Detailed requirements

| ID | Requirement |
|---|---|
| F-007-R1 | The query string MUST be the concatenation `<artist> <title>` after normalisation. |
| F-007-R2 | Title normalisation before scoring MUST strip the patterns: `(Remastered <year>)`, `(Remaster)`, `(<year> Remaster)`, `(feat. ...)`, `(featuring ...)`, `(ft. ...)`, ` - Single Version`, ` - Radio Edit`, ` - Remastered`, ` - Mono`, ` - Stereo`, trailing year-in-parens. Patterns MUST be applied case-insensitively. |
| F-007-R3 | The matcher MUST request at most the top 5 candidates from Tidal. |
| F-007-R4 | Scoring weights MUST be: title 0.40, artist 0.30, duration 0.20, album 0.10. |
| F-007-R5 | Title score MUST be the token-sort ratio between normalised Spotify title and normalised Tidal title. |
| F-007-R6 | Artist score MUST be the token-sort ratio between Spotify artist and Tidal `artists[0].name`. |
| F-007-R7 | Duration score MUST be `1 - min(abs(td.duration_ms - sp.duration_ms), 5000) / 5000`. Beyond 5000 ms delta, score is 0. |
| F-007-R8 | Album score MUST be: 1.0 if normalised Spotify album token-sort-ratio against Tidal album is `>= 0.9`, else 0.0. |
| F-007-R9 | Final score MUST be the weighted sum of the four component scores, in [0, 1]. |
| F-007-R10 | The acceptance threshold MUST be `>= 0.85`. |
| F-007-R11 | If two candidates tie on score (within 0.001), the matcher MUST prefer the candidate with smaller duration delta. |
| F-007-R12 | The matcher MUST NOT make more than one search call per spotify_id per run. |
| F-007-R13 | The matcher MUST log per-decision: `spotify_id`, top candidate id, top score, second-best score (if any), decision (`accepted` / `rejected_below_threshold` / `no_candidates`). |

## Algorithm: scoring

```
function scoreCandidate(sp: SpotifyTrack, td: TidalCandidate): number {
  const titleScore = tokenSortRatio(normaliseTitle(sp.title), normaliseTitle(td.title));
  const artistScore = tokenSortRatio(sp.artist, td.artists[0].name);
  const durationDelta = Math.abs((td.duration_ms ?? 0) - sp.duration_ms);
  const durationScore = 1 - Math.min(durationDelta, 5000) / 5000;
  const albumScore = tokenSortRatio(normaliseAlbum(sp.album), normaliseAlbum(td.album?.title ?? '')) >= 0.9 ? 1.0 : 0.0;
  return 0.40 * titleScore + 0.30 * artistScore + 0.20 * durationScore + 0.10 * albumScore;
}
```

## Database schema

```sql
CREATE TABLE unmatched (
  spotify_id TEXT PRIMARY KEY REFERENCES tracks(spotify_id),
  reason TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 1,
  last_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'matched', 'skipped'))
);

CREATE INDEX idx_unmatched_status ON unmatched(status) WHERE status = 'pending';
```

The upsert pattern:

```sql
INSERT INTO unmatched (spotify_id, reason, attempts, last_attempt_at)
VALUES ($1, $2, 1, now())
ON CONFLICT (spotify_id) DO UPDATE
SET attempts = unmatched.attempts + 1,
    last_attempt_at = now(),
    reason = EXCLUDED.reason
WHERE unmatched.status = 'pending';
```

## Data effects

- Inserts a row into `matches` (when accepted)
- Inserts or updates a row in `unmatched` (when rejected or empty)

## Failure modes

| Mode | Cause | Recovery |
|---|---|---|
| Tidal search 5xx | Tidal infra | Per-track error; retry next run |
| Tidal search 401 | Token refresh failed earlier | Same as F-006-R9 |
| Both candidates have identical low score | Catalog ambiguity | Track lands in `unmatched`; manual override via F-012 |
| Title normalisation produces empty string | Edge case (title was entirely a remaster suffix) | Use original title; score will reflect reality |

## Acceptance criteria

- All tests in T-007 pass
- For a curated set of 20 tracks with known Spotify and Tidal IDs and intentionally varied metadata (remasters, featurings, remixes), the matcher achieves at least 80% precision at threshold 0.85
- A clearly-different track does not produce a false match (e.g., "Yesterday" by The Beatles vs "Yesterday" by Atmosphere)
- The same input produces the same score on every run (deterministic)
