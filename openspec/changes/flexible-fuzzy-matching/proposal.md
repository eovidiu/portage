## Why

F-007 fuzzy matching rejects too many obvious matches. As of 2026-05-22, 24 of
28 currently-pending unmatched rows are `fuzzy_below_threshold` (86%), and the
30 manual matches Ovidiu recorded over the last 14 days exhibit a small,
recurring set of failure patterns the operator has been hand-fixing rather
than the matcher learning to handle. The current scorer (title 0.40 +
artist 0.30 + duration 0.20 + album 0.10 with threshold 0.85) uses
`tokenSortRatio` for title comparison, which mechanically punishes any case
where the Spotify title carries an extra qualifier the Tidal release omits:
`"Swallowed - 2014 Remastered"` vs `"Swallowed"`, `"Curtains - Single Edit"`
vs `"Curtains"`, `"It's Never Over (Hey Orpheus)"` vs `"It's Never Over"`,
and so on. The fix is to swap the comparison primitive for one that is
robust to qualifier-asymmetry, widen the strip set for known qualifier
suffixes, and add a small ISRC-prefix tiebreaker — none of which require
new infrastructure.

## What Changes

- **MODIFIED**: title comparison switches from `tokenSortRatio` (which
  punishes extra tokens on either side) to a hybrid `tokenSetRatio` that
  scores the intersection-vs-union of normalised title tokens. This is the
  single biggest unlock for the "Spotify has a qualifier suffix Tidal
  doesn't" miss class.
- **MODIFIED**: `STRIP_PATTERNS` in `src/match/title.ts` widens to also
  strip `- Single Edit`, `- Single Version`, `- Original`, `- Live`,
  `- Bonus Track`, `- Mono Mix`, `- Stereo Mix`, `- Recorded at <venue>`,
  `- <year> Remastered`, `- Remastered <year>`, and a generic catch-all
  for trailing `- <Adjective> Edit/Mix/Version`.
- **MODIFIED**: text normalisation also strips smart quotes
  (`'`/`'`/`"`/`"`) and converts them to ASCII apostrophes/quotes before
  tokenising, so `It's` (U+2019) matches `It's` (U+0027) cleanly.
- **MODIFIED**: artist comparison applies the same lowercase + strip
  normalisation that the title path uses (currently artist comparison runs
  `tokenSortRatio` on raw input).
- **NEW**: ISRC-prefix tiebreaker. When the Spotify ISRC and Tidal
  candidate ISRC share the first 7 characters (country + registrant + year),
  the total score gets a +0.05 boost. Rationale: same ISRC prefix is strong
  evidence of the same recording reissued under a different catalog entry,
  which is exactly the "remaster differs by year suffix" class.
- **MODIFIED**: `ACCEPT_THRESHOLD` lowers from `0.85` to `0.80` after the
  scoring changes above. The new scorer is more permissive on the right
  rows while staying conservative on the wrong ones; the test-curated
  pairs from the manual-match corpus should auto-accept post-fix without
  the threshold drop, but the small headroom reduction prevents
  near-misses from re-entering the queue.
- The scoring change is **not** breaking for downstream consumers — the
  output shape (`ScoreBreakdown`, `FuzzyMatchResult`) stays identical.
  Database, route, and UI contracts are unchanged.

## Capabilities

### New Capabilities

<!-- None. This is an algorithm refinement, not a new capability. -->

### Modified Capabilities

- `fuzzy-matching`: scoring algorithm + normalisation + threshold are
  changing. The capability itself (auto-match Spotify→Tidal tracks via a
  weighted score) is unchanged; the internal scoring rules tighten on
  diacritic/quote handling and loosen on qualifier-suffix asymmetry.

(Note: `fuzzy-matching` does not currently exist as a top-level capability
spec under `openspec/specs/`. F-007 was authored under the legacy
`docs/specs/F-007-fuzzy-matching.md` pattern. This change introduces the
capability spec under OpenSpec as `MODIFIED Requirements` against the
existing fuzzy-matching contract.)

## Impact

- **Affected code (Worker)**: `src/match/title.ts` (widen STRIP_PATTERNS +
  add smart-quote normalisation), `src/match/score.ts` (switch title from
  token-sort to token-set ratio, add ISRC-prefix boost), `src/match/artist.ts`
  (extract shared `normaliseText` helper, apply to artist), `src/match/fuzzy.ts`
  (lower `ACCEPT_THRESHOLD` from 0.85 to 0.80).
- **APIs**: no public API changes. `POST /unmatched/:spotify_id/match` and
  `GET /unmatched`, the rematch endpoints, the captures shape — all stay
  identical.
- **Dependencies**: none added. Token-set ratio is a 30-line addition to
  `artist.ts` using the existing Levenshtein primitive.
- **Cross-repo**: no portage-ui changes. The UI consumes the same
  `confidence` float on matched rows; it doesn't care which sub-formula
  produced it.
- **Operational**: expected outcome is the existing 24 `fuzzy_below_threshold`
  rows getting auto-matched on the next cron, plus a meaningful drop in
  manual-match rate over the next 14-day window. Worst case: a handful of
  false positives that the operator surfaces via the rematch panel and
  requeues. We accept that risk because the manual-match path now works
  cleanly (post-yesterday's `441913578` regex fix), so any false positive
  is a 30-second un-match round trip rather than data loss.
- **Security**: none. Title strings already flow through the matcher; no
  new data classes.
- **Observability**: the existing `event: "fuzzy_decision"` structured log
  line gains two fields (`title_score_method: "token_set" | "token_sort"`
  and `isrc_prefix_boost: 0.0 | 0.05`) so post-deploy operator can audit
  which rows benefited from each change. No new log lines, no new metrics
  surface.
