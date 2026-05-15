## Why

After F-007 (auto fuzzy match) and F-024 (manual catalog search) run, the
`unmatched` queue still accumulates rows whose Spotify metadata trips up
Tidal's full-title search — long featured-artist suffixes, parenthetical
versions, foreign-language disambiguation, etc. The operator's hand-tuned
trick on those rows is to search Tidal with a deliberately short query:
the first two words of the artist plus the first word of the song. That
heuristic recovers a non-trivial slice of the queue, but today it requires
re-typing per row in the manual picker. Surfacing it as a first-class
"rematch" sweep across the queue turns a tedious manual ritual into a
single button-click and lets the operator triage what the looser query
actually retrieves.

## What Changes

- **NEW** route `GET /unmatched/rematch?limit=N` on the Worker — iterates pending
  unmatched rows (FIFO by `last_attempt_at` desc, capped at `limit`, default
  10, max 25 to stay well under the 50-subrequest budget), runs the rematch
  heuristic against Tidal catalog search per row, and returns the candidate
  list per row. **Read-only**: no rows are auto-matched, no DB writes occur.
- **NEW** route `GET /unmatched/:spotify_id/rematch` on the Worker — single-row
  variant that returns the heuristic's candidate list for one queued row.
  Useful from per-row UI affordances and for retrying after a transient
  Tidal failure.
- **NEW** helper `buildRematchQuery(artist, title)` in `src/match/rematch.ts`
  — pure function shared by both routes. Strips control chars, lower-cases,
  applies the existing artist normaliser, takes the first two artist words
  and the first title word (post `normaliseTitle`), joins with a single space.
- Reuses `searchTidalCandidates` (F-024) and `mapCandidateToResponseShape` so
  the response contract matches the manual search response.
- Registers feature `F025` in `.harness/features.json` with `depends_on: ["F024"]`.

Non-goals: no DB writes, no auto-match on high score, no schema changes, no
caching, no fanout beyond the 25-row cap, no new rate-limit bucket (the
existing CF Access edge + F-024's per-principal bucket cover abuse, and the
sweep itself is a single principal action). The sister UI work happens in
the `portage-ui` repo and is tracked by a separate OpenSpec change there.

## Capabilities

### New Capabilities

- `rematch-heuristic`: server-side bulk + single-row Tidal search that uses
  a short, hand-tuned query ("first two artist words + first title word")
  to surface candidates for unmatched rows that full-title search missed.
  Owns the heuristic, the sweep iteration, response shape, and the partial-
  failure taxonomy. Does NOT own write paths — selection still goes through
  `POST /unmatched/:spotify_id/match`.

### Modified Capabilities

<!-- None. F-012 (unmatched queue) and F-024 (manual catalog search) are
referenced as peers but their requirements are not changing — the new
endpoints are additive. -->

## Impact

- **Affected code (Worker)**: `src/routes/unmatched.ts` (two new handlers),
  new `src/match/rematch.ts` (heuristic + sweep), reuse of
  `src/match/tidal-search.ts` and `src/routes/search-mapper.ts` unchanged.
- **APIs**: two new public routes (both `GET`); the existing `/match` and
  `/skip` are reused for selection (no new write path).
- **Dependencies**: none added. The sweep stays within the 50-subrequest
  Workers free-tier budget because `limit` is capped at 25.
- **Cross-repo**: a sibling OpenSpec change `rematch-panel` in `portage-ui`
  consumes both endpoints. Both specs bind to the same response contract;
  cross-repo drift is the primary risk.
- **Operational**: each sweep emits one structured log line per row
  (`event: "rematch_row"`) plus one summary line (`event: "rematch_sweep"`)
  so an operator can audit what the heuristic retrieved without enabling
  debug logging.
- **Security**: CF Access (F-019) gates both routes; Tidal bearer token never
  leaves the Worker; the existing F-024 rate-limit bucket continues to apply
  to the per-row variant.
