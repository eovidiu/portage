## Context

F-007 fuzzy matching shipped 2026-04-27 with this scoring formula
(`src/match/score.ts`):

```
score = 0.40 × titleScore  (tokenSortRatio of normalised titles)
      + 0.30 × artistScore (tokenSortRatio of raw artist strings)
      + 0.20 × durationScore (linear, ±5 s cap)
      + 0.10 × albumScore  (binary: 1.0 if token_sort ≥ 0.9 else 0.0)

accept if score ≥ 0.85
```

`tokenSortRatio` works by splitting both strings on whitespace, sorting the
tokens alphabetically, joining, and applying Levenshtein similarity. This
**punishes any case where one side carries a token the other doesn't** —
exactly the situation we see in 24 of 28 currently-pending unmatched rows.

### Evidence: pending unmatched rows that fuzzy rejected (2026-05-22 sample)

| Spotify title | Likely Tidal title | Why it fails |
|---|---|---|
| `Swallowed - 2014 Remastered` | `Swallowed` | Trailing remaster qualifier survives `normaliseTitle` (regex only matches `(2014 Remaster)` not `- 2014 Remastered`) |
| `Curtains - Single Edit` | `Curtains` | `- Single Edit` not in `STRIP_PATTERNS` |
| `Ill Ray (The King)` | `Ill Ray (The King)` *or* `Ill Ray` | Parenthetical subtitle |
| `It's Never Over (Hey Orpheus)` | `It's Never Over` | Parenthetical subtitle + smart-quote `'` (U+2019) |
| `Rox In The Box - Live` | `Rox In The Box` | `- Live` not stripped |
| `Hate - Original` | `Hate` | `- Original` not stripped |
| `Annihilation (Live)` | `Annihilation` | `(Live)` not stripped |
| `Needles and Pins - 1999 Remaster` | `Needles and Pins` | Trailing `- 1999 Remaster` not stripped (regex requires parens) |
| `Four Out Of Five - Recorded at Electric Lady Studios, New York` | `Four Out Of Five` | Long venue suffix |
| `Stranger Things` (Kyle Dixon & Michael Stein) | many candidates | Short generic title + instrumental → low title score across all candidates |
| `Răsărit perfect` (Olivia Addams) | likely same | Diacritics + Romanian; current normalisation preserves diacritics (correct) but the artist comparison runs raw |

### Evidence: manual matches Ovidiu hand-recorded (last 14 days)

The 30 manual matches show the same shape with a longer tail:
`Bang a Gong (Get It On)`, `Fly Me To The Moon (In Other Words)`,
`Quando Quando Quando (Cuando Cuando Cuando) - Versión Bilingue`,
`Buona Sera - Remastered 1991`, `"Heroes" - 2017 Remaster` (embedded quotes),
`Moon River(Vocal Audrey Hepburn)` (no space before paren).

The proposal's "fix the matcher, don't make the operator click harder" is
the right framing: the operator's manual-match path is what tells us what
the matcher should already be doing.

## Goals / Non-Goals

**Goals**

- Auto-match the 24 currently-pending `fuzzy_below_threshold` rows on the
  next cron after deploy (within reason — some may still be genuine
  mismatches that the operator should hand-pick).
- Reduce the manual-match rate over the next 14-day window vs the
  current baseline (~30 per 14d).
- Keep the change **algorithmic-only** — no DB schema, no API contract,
  no UI changes, no new dependencies.
- Preserve the existing `confidence` semantics in `matches.confidence`
  (a real-valued score in `[0, 1]` interpreted as "matcher's certainty").

**Non-Goals**

- ML-based or embedding-based matching. Overkill for a queue of ~30
  pending rows on a single-tenant deploy.
- Lowering the threshold without first improving the scorer. A blanket
  threshold drop would auto-accept genuine false matches and shift work
  from the matcher to the operator's un-match flow.
- Hand-curated overrides (a "manual match never fails" lookup table).
  The `manual` method on the `matches` table already serves this role
  for one-off cases; we want to fix the general scorer.
- Reranking by Tidal popularity / play count. Tidal's API exposes
  `popularity` but mixing it into a relevance score changes the
  taxonomy from "this matcher is about identity" to "this matcher is
  about audience preference" — different problem.
- Multi-Tidal-region search. Single-tenant operator is in RO; expanding
  `countryCode` per request multiplies subrequest cost without solving
  the title-similarity class.

## Decisions

### D1: Title comparison switches from `tokenSortRatio` to a hybrid `tokenSetRatio`

**What**: introduce a new primitive `tokenSetRatio(a, b)` alongside the
existing `tokenSortRatio`. The new function computes:

```
let setA = unique tokens of normalise(a)
let setB = unique tokens of normalise(b)
let intersection = setA ∩ setB (sorted, joined)
let diff_a       = setA - setB (sorted, joined)
let diff_b       = setB - setA (sorted, joined)

ratio_1 = levenshteinSimilarity(intersection, intersection + " " + diff_a)
ratio_2 = levenshteinSimilarity(intersection, intersection + " " + diff_b)
ratio_3 = levenshteinSimilarity(intersection + " " + diff_a,
                                intersection + " " + diff_b)

return max(ratio_1, ratio_2, ratio_3)
```

This is the standard `fuzz.token_set_ratio` from `rapidfuzz` /
`fuzzywuzzy`. The crucial property: when one side has extra tokens (a
qualifier suffix the other doesn't carry), `ratio_1` or `ratio_2`
compares the intersection against the longer string — which still
scores high because the intersection is the same on both sides.

**Why over alternatives**:
- *Keep `tokenSortRatio`, only expand `STRIP_PATTERNS`*: brittle. Every
  new qualifier requires a code change. The set ratio handles novel
  qualifiers out of the box.
- *Jaccard token-set similarity* (`|A ∩ B| / |A ∪ B|`): too coarse — it
  treats `"Swallowed"` and `"Swallow"` as 0% similar because the tokens
  differ. Levenshtein-on-token-set keeps character-level robustness.
- *Trigram cosine similarity*: more complex, similar real-world
  recall, but doesn't compose well with the existing Levenshtein-based
  helpers we'd still need for artist/album.

### D2: Use `tokenSetRatio` for title, keep `tokenSortRatio` for album

**What**: title scoring switches to set ratio. Album scoring keeps the
existing token-sort ≥ 0.9 binary gate.

**Why**: title misses are almost always the qualifier-asymmetry case
(remaster, live, edit). Album misses are almost always the
catalog-edition case (`Razorblade Suitcase` vs `Razorblade Suitcase
(2014 Remastered)`), which token-sort handles fine once the strip set
is widened (D3). Mixing primitives unnecessarily would obscure where a
regression came from later.

### D3: Widen `STRIP_PATTERNS` in `src/match/title.ts`

**What**: add these patterns (case-insensitive, anchored to ` - ` or
parenthetical):

| Pattern | Matches |
|---|---|
| `\s+-\s+single\s+edit` | `- Single Edit` |
| `\s+-\s+original` | `- Original` |
| `\s+-\s+live(?:\s+at\s+[^-]*)?` | `- Live`, `- Live at ...` |
| `\s+-\s+bonus\s+track` | `- Bonus Track` |
| `\s+-\s+(mono|stereo)\s+mix` | `- Mono Mix`, `- Stereo Mix` |
| `\s+-\s+recorded\s+at\s+.*$` | `- Recorded at Electric Lady Studios, New York` |
| `\s+-\s+\d{4}\s+remaster(?:ed)?(\s+version)?` | `- 1999 Remaster`, `- 2014 Remastered`, `- 2014 Remastered Version` |
| `\s+-\s+remastered\s+\d{4}` | `- Remastered 2012`, `- Remastered 1991` |
| `\(\s*live(?:\s+at\s+[^)]*)?\s*\)` | `(Live)`, `(Live at ...)` |

The first existing block also gets a `\s*$` anchor where missing, to
avoid eating mid-string content if the pattern ever appears in the
middle of a title.

**Why over alternatives**:
- *Match qualifier suffixes algorithmically* (e.g., "everything after
  the last ` - `"): too aggressive. Titles like `"Crosby, Stills, Nash
  - Suite: Judy Blue Eyes"` would get truncated incorrectly.
- *Use a curated whitelist of "stop qualifiers"* per Spotify metadata
  conventions: that whitelist is essentially the table above. May as
  well bake it into the regex.

### D4: Smart-quote normalisation in `normaliseText` (shared by title + artist)

**What**: a new shared helper `normaliseText(s)` that:

1. Replaces smart quotes (U+2018, U+2019, U+201C, U+201D, U+2032, U+2033)
   with their ASCII equivalents (`'` and `"`).
2. Replaces en/em dashes (U+2013, U+2014) with `-`.
3. Calls `normaliseTitle` for the title path (which now subsumes the
   strip patterns).
4. For the artist path: lowercase + strip `\bfeat(uring|\.)\b.*$` +
   strip parentheticals + strip non-letter/digit/whitespace runes
   (matches the existing `normalise` in `src/match/artist.ts` line 40-48
   but extracted as a shared step before token comparison).

**Why**: `It's Never Over (Hey Orpheus)` from Arcade Fire's metadata
uses U+2019, while Tidal returns U+0027. Without normalisation,
`tokenSetRatio` sees these as distinct tokens. The U+2013 en-dash case
showed up in 2 of 30 manual matches (separators in Romanian metadata).

### D5: ISRC-prefix tiebreaker boost of +0.05

**What**: when both Spotify and Tidal candidate carry a non-null ISRC,
and the first 7 characters match (`CC-NNN-YY` country + registrant +
year), add `0.05` to the total score before applying the threshold. The
boost stacks on top of the four weighted components but does not
short-circuit them.

**Why this specific shape**:
- The first 7 chars of an ISRC are issued together to a registrant in
  a year; later digits identify a specific recording. Reissues of the
  same recording under a new catalog often share the prefix but differ
  in the trailing 5 digits.
- `+0.05` is calibrated so it can push a `0.78` near-miss to `0.83` —
  enough to clear the new 0.80 threshold (D6) when the ISRC says
  "these are the same recording" but the title qualifier disagrees.
  It is NOT enough to push a `0.60` clear miss into accept territory.
- We deliberately do not let ISRC-prefix match auto-accept. F-006
  already handles full ISRC equality as the fast path before fuzzy
  runs; ISRC-prefix is a softer signal that complements scoring rather
  than replacing it.

**Alternative considered**: full ISRC equality boost of +0.10. Rejected
because F-006 (`matchByIsrc`) already handles exact ISRC matches before
fuzzy ever runs — by the time we're in the fuzzy path, the ISRCs are
known different. Prefix-only is the meaningful signal here.

### D6: Lower `ACCEPT_THRESHOLD` from 0.85 to 0.80

**What**: change the constant in `src/match/fuzzy.ts`.

**Why**: D1–D5 together raise the score floor for true matches more
than they raise it for false ones, but the margin is small. The
threshold drop from 0.85 → 0.80 (~6% relative) absorbs the residual
gap. We chose `0.80` rather than `0.75` because:

- Empirically (eyeballing the 24 fuzzy-rejected rows), the post-D1
  rerank puts most of them in the 0.78–0.84 band. A 0.80 threshold
  catches the obvious "rejected by 0.85 by a hair" group without
  reaching into 0.70-territory mismatches.
- The threshold is operationally reversible — easy to bump back up if
  false positives spike in week one.

### D7: Observability for the change

**What**: extend the `event: "fuzzy_decision"` log line emitted by
`fuzzy.ts` to include two new fields:

```json
{
  "event": "fuzzy_decision",
  "spotify_id": "...",
  "top_candidate_id": "...",
  "top_score": 0.83,
  "second_best_score": 0.71,
  "decision": "accepted",
  "title_score_method": "token_set",   // NEW — locked to "token_set" post-change
  "isrc_prefix_boost": 0.05             // NEW — 0.0 if no boost, else 0.05
}
```

**Why**: post-deploy, the operator (or future Ovidiu) needs to be able
to query `wrangler tail` for "which rows benefited from the ISRC boost"
vs "which would have matched anyway under the new scorer alone". Without
those fields we'd be debugging blind.

## Risks / Trade-offs

- **R1: False positives spike on permissive scoring.** Possible — the
  combination of token-set + widened strip + lower threshold is
  individually conservative but together moves the operating point.
  Mitigation: the manual-match path (just fixed yesterday in PR
  portage-ui#16) now works cleanly, so any false positive is a
  30-second un-match round trip. Plus the `fuzzy_decision` log lets us
  audit decisions in the first week post-deploy.
- **R2: Token-set ratio is slower than token-sort ratio** by ~3× (it
  computes Levenshtein over 3 string pairs instead of 1). At our
  budget (default 2 fuzzy candidates × 5 Tidal candidates = 10 score
  calls per cron post-MATCH_BATCH clamp), this is ~30 extra Levenshtein
  computations on short strings (<50 chars) per cron — well under 1ms
  total. Mitigation: not needed; documented for context.
- **R3: Smart-quote normalisation may collide with legitimate uses of
  quote variants in CJK or other scripts.** Single-tenant operator's
  library is mostly EN/RO/ES/FR. Mitigation: only U+2018/2019/201C/201D
  (smart quotes) and U+2013/2014 (dashes) are remapped — the
  long-tail Unicode punctuation set is unchanged. If CJK becomes
  important, revisit then.
- **R4: ISRC-prefix boost double-counts** when the ISRC prefix encodes
  the same information already captured by artist + album scores
  (same country/year often means same release). Mitigation: the +0.05
  is calibrated to be smaller than any one component weight; even when
  redundant it can't tip a clear mismatch into accept.

## Migration Plan

1. Land the algorithm change as one PR. Tests cover the new patterns +
   the regression cases from the manual-match corpus.
2. Deploy via `wrangler deploy`. No DB migration, no env-var changes.
3. **First-cron observation**: tail `wrangler tail` during the 19:23 UTC
   cron the day of deploy. Expect 5–15 of the 24 pending
   `fuzzy_below_threshold` rows to auto-match. Anything that auto-matches
   wrongly is visible via the new log fields and reversible via the
   un-match flow.
4. **One-week soak**: count `event: "fuzzy_decision"` outcomes by day.
   If `accepted` rate stays > 60% and `rejected_below_threshold` rate
   keeps trending down, declare success.
5. **Rollback**: revert the PR if false-positive rate exceeds 10% of
   accepted rows in the first 48 hours. Pure code revert, no data
   migration needed (the wrong matches stay as `manual`-method rows
   that the operator un-matches by hand).

## Open Questions

None. All decisions have data-grounded rationale (D1, D3 mappings come
straight from the 24 currently-pending sample). The threshold value
(D6) is intentionally an op-tuning knob — if 0.80 proves wrong in
practice, change one constant.
