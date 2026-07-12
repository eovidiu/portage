# fuzzy-matching Specification

## Purpose
Flexible fuzzy title/artist matching for tracks without a resolvable ISRC: token-set title ratio, widened qualifier strip-patterns, Unicode text parity, ISRC-prefix tiebreaker, and the 0.80 accept threshold. Created by archiving change flexible-fuzzy-matching (F-028). Legacy F-007 (docs/specs/F-007-*.md) defines the surrounding fuzzy pipeline; this spec governs the scoring algorithm itself.
## Requirements
### Requirement: Title scoring uses token-set ratio

The fuzzy matcher's title-similarity component SHALL compute its score as
the maximum of three Levenshtein-similarity ratios over the
intersection-vs-symmetric-difference decomposition of the two titles'
normalised token sets (commonly known as `token_set_ratio` per the
`rapidfuzz` / `fuzzywuzzy` definition), rather than the legacy
`token_sort_ratio`.

The motivation: when one side carries an extra qualifier the other does
not (e.g. `"Swallowed - 2014 Remastered"` vs `"Swallowed"`), the
token-set computation compares the intersection against the longer
string and against itself, yielding a score that reflects "the
intersection IS the title and the extra tokens are noise" rather than
mechanically punishing the asymmetry.

#### Scenario: Asymmetric qualifier suffix survives a high title score

- **WHEN** the matcher scores Spotify title `"Swallowed - 2014 Remastered"` against Tidal title `"Swallowed"`
- **THEN** the resulting `titleScore` is `>= 0.85` (vs `~0.55` under `token_sort_ratio`)

#### Scenario: Parenthetical subtitle on one side only

- **WHEN** the matcher scores Spotify title `"Ill Ray (The King)"` against Tidal title `"Ill Ray"`
- **THEN** the resulting `titleScore` is `>= 0.85`

#### Scenario: Both sides identical produces 1.0

- **WHEN** the matcher scores any two normalisation-identical title strings
- **THEN** the resulting `titleScore` is `1.0`

### Requirement: Title and artist normalisation share a smart-quote and dash mapping

`normaliseText` SHALL precede tokenisation for both title and artist
comparisons. It replaces the following Unicode characters with their
ASCII equivalents:

| Source | Replacement |
|---|---|
| U+2018 LEFT SINGLE QUOTATION MARK (`'`) | `'` (U+0027) |
| U+2019 RIGHT SINGLE QUOTATION MARK (`'`) | `'` (U+0027) |
| U+201C LEFT DOUBLE QUOTATION MARK (`"`) | `"` (U+0022) |
| U+201D RIGHT DOUBLE QUOTATION MARK (`"`) | `"` (U+0022) |
| U+2013 EN DASH (`–`) | `-` (U+002D) |
| U+2014 EM DASH (`—`) | `-` (U+002D) |

#### Scenario: Smart apostrophe matches ASCII apostrophe

- **WHEN** the matcher scores Spotify title `"It's Never Over"` (U+2019) against Tidal title `"It's Never Over"` (U+0027)
- **THEN** the resulting `titleScore` is `>= 0.95`

#### Scenario: En-dash separator matches ASCII hyphen separator

- **WHEN** the matcher scores artist `"Café Tacvba – Eres"` (U+2013) against `"Café Tacvba - Eres"` (U+002D) after normalisation
- **THEN** the normalised strings differ only in tokenisation-irrelevant whitespace, yielding a tokenisation-equal comparison

### Requirement: Strip-pattern set covers common qualifier suffixes

`normaliseTitle` SHALL strip the following qualifier suffixes when they
appear at the end of the title or in trailing position after ` - `,
case-insensitively, before tokenisation:

- `- Single Edit`, `- Single Version`
- `- Original`
- `- Live`, `- Live at <venue>`
- `- Bonus Track`
- `- Mono Mix`, `- Stereo Mix`
- `- Recorded at <venue>` (catches the entire trailing venue clause)
- `- <year> Remaster`, `- <year> Remastered`, `- <year> Remastered Version`
- `- Remastered <year>`
- Parenthetical `(Live)`, `(Live at <venue>)`

The existing patterns from F-007 (parenthetical year remasters, `feat.`
clauses, single/radio edit) remain in place.

#### Scenario: Trailing year-remaster suffix is stripped

- **WHEN** `normaliseTitle("Needles and Pins - 1999 Remaster")` is called
- **THEN** the result is `"Needles and Pins"`

#### Scenario: Trailing single-edit suffix is stripped

- **WHEN** `normaliseTitle("Curtains - Single Edit")` is called
- **THEN** the result is `"Curtains"`

#### Scenario: Parenthetical Live tag is stripped

- **WHEN** `normaliseTitle("Annihilation (Live)")` is called
- **THEN** the result is `"Annihilation"`

#### Scenario: Recorded-at suffix is stripped completely

- **WHEN** `normaliseTitle("Four Out Of Five - Recorded at Electric Lady Studios, New York")` is called
- **THEN** the result is `"Four Out Of Five"`

#### Scenario: Stripping that produces empty string falls back to trimmed original

- **WHEN** `normaliseTitle("- Live")` is called (an input that is entirely a strip pattern)
- **THEN** the result is `"- Live"` (the original, trimmed) rather than the empty string

### Requirement: Artist comparison runs the same normalisation as title

`scoreCandidate` SHALL apply `normaliseText` (D4 in design.md) to both
the Spotify artist string and the Tidal candidate's `primaryArtist`
before computing the artist score. The artist score itself continues to
use `tokenSortRatio` (artist asymmetry is rare in practice — the issue is
purely Unicode/case normalisation).

#### Scenario: Mixed-case + smart-quote artist matches plain artist

- **WHEN** the matcher scores Spotify artist `"D'Angelo"` (U+2019) against Tidal artist `"D'angelo"` (U+0027)
- **THEN** the resulting `artistScore` is `>= 0.95`

### Requirement: ISRC-prefix tiebreaker boost

`scoreCandidate` SHALL add a `0.05` boost to the total score when:

1. Both the Spotify track and the Tidal candidate carry a non-null `isrc`, AND
2. The first 7 characters of the two ISRCs are equal
   (the country-code + registrant + year prefix per ISO 3901).

The boost SHALL NOT short-circuit the weighted scoring; it stacks on top
of the four weighted components. The result of `scoreCandidate` is
allowed to exceed `1.0` after this boost (callers continue to clamp via
the threshold gate).

#### Scenario: Same ISRC prefix nudges a near-miss into accept range

- **WHEN** the weighted base score is `0.77` and both ISRCs share the first 7 characters
- **THEN** the total score is `0.82`

#### Scenario: Different ISRC prefix produces no boost

- **WHEN** Spotify ISRC is `"USAT29900471"` and Tidal ISRC is `"USJT11600370"` (different country+registrant)
- **THEN** the total score equals the base weighted score with no `+0.05` added

#### Scenario: Missing ISRC on either side produces no boost

- **WHEN** either the Spotify track or the Tidal candidate has `isrc: null`
- **THEN** the total score equals the base weighted score with no `+0.05` added

### Requirement: Acceptance threshold lowers to 0.80

The auto-accept threshold for fuzzy matching SHALL be `0.80` (lowered
from `0.85`). A candidate's total score (post all weights + the ISRC
boost) must meet or exceed this threshold to result in an auto-recorded
`matches` row with `method = 'fuzzy'`.

The threshold is intentionally a single tunable constant in
`src/match/fuzzy.ts` so that operator can revert it via PR if false
positives spike.

#### Scenario: Score at threshold is accepted

- **WHEN** the top candidate's total score is exactly `0.80`
- **THEN** the matcher records a `matches` row with `method = 'fuzzy'` and `confidence = 0.80`

#### Scenario: Score just below threshold is rejected

- **WHEN** the top candidate's total score is `0.79`
- **THEN** the matcher upserts an `unmatched` row with `reason = 'fuzzy_below_threshold'` and persists the top-3 candidates per F-027a

### Requirement: Fuzzy-decision log line carries algorithm provenance

The `event: "fuzzy_decision"` log line emitted by `matchByFuzzy` per visited track SHALL include two additional fields, `title_score_method` and `isrc_prefix_boost`, so operator can audit which scoring rules contributed to each decision.

`title_score_method` MUST be one of the literal strings `"token_set"` or `"token_sort"`. After this change ships, the value is locked to `"token_set"` for the title component; the field is added explicitly so a future scoring experiment can A/B without log-shape churn.

`isrc_prefix_boost` MUST be numeric, either `0.0` (no boost applied) or `0.05` (boost applied because both ISRCs were present and shared a 7-character prefix).

#### Scenario: Accepted match log line carries both new fields

- **WHEN** a track is auto-matched with `decision: "accepted"`
- **THEN** the corresponding `fuzzy_decision` log line includes both `title_score_method` and `isrc_prefix_boost` keys with values of the documented shape

#### Scenario: Rejected match log line also carries both new fields

- **WHEN** a track is rejected with `decision: "rejected_below_threshold"`
- **THEN** the corresponding `fuzzy_decision` log line still includes both `title_score_method` and `isrc_prefix_boost` keys (the log shape is uniform across decisions)

### Requirement: Backward-compatible output shape

The exported `ScoreBreakdown` type and the `FuzzyMatchResult` shape returned by `matchByFuzzy` SHALL remain unchanged at the field level. Downstream callers (the orchestrator, `routes/sync/runs.ts`, the captures API, the UI) MUST continue to read these shapes without modification. The only allowed addition is the new `isrcPrefixBoost` field on `ScoreBreakdown` (additive, defaults to `0.0`) — every existing field keeps its name and type.

#### Scenario: ScoreBreakdown still exports total, titleScore, artistScore, durationScore, albumScore

- **WHEN** any caller imports `ScoreBreakdown` from `src/match/score.ts`
- **THEN** the type continues to expose exactly the five existing fields with their existing types

#### Scenario: FuzzyMatchResult still exports matched, unmatched, errors

- **WHEN** any caller awaits `matchByFuzzy`
- **THEN** the resolved value continues to have exactly the three existing top-level fields
