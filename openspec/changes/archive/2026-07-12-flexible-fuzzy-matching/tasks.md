## 1. Shared text normalisation

- [x] 1.1 In `src/match/title.ts`, export a new `normaliseText(s: string): string` helper that maps smart quotes (U+2018, U+2019, U+201C, U+201D) to ASCII `'`/`"`, and en/em dashes (U+2013, U+2014) to `-`. Pure function, no project deps.
- [x] 1.2 Refactor the existing `normaliseTitle` to call `normaliseText` as its first step, before the existing strip-pattern loop runs.
- [x] 1.3 Widen `STRIP_PATTERNS` in `src/match/title.ts` to include the qualifier list in spec.md ("Strip-pattern set" requirement). One regex per row in the design.md table.
- [x] 1.4 Verify the empty-string fallback (`return s.length > 0 ? s : title.trim()`) still fires when a title is entirely a strip pattern.

## 2. Token-set ratio primitive

- [x] 2.1 In `src/match/artist.ts`, export a new `tokenSetRatio(a: string, b: string): number` alongside the existing `tokenSortRatio`. Implementation per design D1: compute the three Levenshtein-similarity ratios over `intersection`, `intersection + diff_a`, `intersection + diff_b` and return the max.
- [x] 2.2 Unit-test `tokenSetRatio` against the 5 scoring scenarios in spec.md:
  - asymmetric qualifier suffix (`"Swallowed - 2014 Remastered"` vs `"Swallowed"`)
  - parenthetical subtitle (`"Ill Ray (The King)"` vs `"Ill Ray"`)
  - smart apostrophe (`"It's Never Over"` U+2019 vs U+0027)
  - identical strings → 1.0
  - completely disjoint strings → low score (sanity check the formula isn't pathological)

## 3. Score formula update

- [x] 3.1 In `src/match/score.ts`, switch the title component from `tokenSortRatio(normaliseTitle(sp.title), normaliseTitle(td.title))` to `tokenSetRatio(normaliseTitle(sp.title), normaliseTitle(td.title))`. Keep the artist + album + duration components as-is.
- [x] 3.2 Apply `normaliseText` to the artist inputs before the existing `tokenSortRatio(sp.artist, td.primaryArtist)` call. Comment that artist asymmetry is rare; the change is purely Unicode parity.
- [x] 3.3 Add the ISRC-prefix tiebreaker: after computing the four weighted components into `total`, if both `sp.isrc` and `td.isrc` are non-null AND `sp.isrc.slice(0, 7) === td.isrc.slice(0, 7)`, add `0.05` to `total` and surface a new `isrcPrefixBoost: 0.05 | 0.0` field on `ScoreBreakdown` (additive — does NOT break existing consumers).
- [x] 3.4 Confirm `ScoreBreakdown` still exposes `total | titleScore | artistScore | durationScore | albumScore`. The new `isrcPrefixBoost` field is the only addition.

## 4. Threshold + log line

- [x] 4.1 In `src/match/fuzzy.ts`, change `ACCEPT_THRESHOLD` from `0.85` to `0.80`. Update the doc comment to reflect the new value and link to design.md D6.
- [x] 4.2 Extend the `event: "fuzzy_decision"` log call to include `title_score_method: "token_set"` (locked literal post-change) and `isrc_prefix_boost: <breakdown.isrcPrefixBoost>` (sourced from the new ScoreBreakdown field).

## 5. Tests

- [x] 5.1 `tests/match/title.test.ts`: extend the existing suite to cover every scenario in the "Strip-pattern set" requirement (5 new cases) + the smart-quote normalisation cases (2 cases).
- [x] 5.2 `tests/match/artist.test.ts`: add `tokenSetRatio` unit tests per task 2.2.
- [x] 5.3 `tests/match/score.test.ts`: add scenarios for the ISRC-prefix boost (same prefix → boost applied, different prefix → no boost, null on either side → no boost). Update any existing test that asserts `total` against the old `tokenSortRatio` title baseline.
- [x] 5.4 `tests/match/fuzzy.test.ts`: end-to-end regression set using the **24 currently-pending `fuzzy_below_threshold` rows** as fixtures. For each, assert the post-change scorer puts the right Tidal candidate above 0.80. Source the fixtures by snapshotting the rows + their persisted top-3 candidates from production (F-027a made this easy — the candidates are already in the unmatched table).
- [x] 5.5 Confirm the full Worker test suite remains 747+/747+ passing (whatever the post-change number is). Typecheck clean.

## 6. Ship + observe

- [x] 6.1 PR title `feat(F-028): flexible fuzzy matching algorithm`. Body lists the 24 currently-pending rows that should auto-match on the first cron post-deploy.
- [x] 6.2 Merge + `wrangler deploy`. Capture the Version ID in `.harness/context_summary.md` Active Context the same minute.
- [x] 6.3 Tail the 19:23 UTC cron the day of deploy. Count `fuzzy_decision` events with `decision: "accepted"` and `decision: "rejected_below_threshold"`. Sanity-check `isrc_prefix_boost: 0.05` vs `0.0` distribution.
- [x] 6.4 One-week soak. If accepted-rate stays > 60% on the eligible queue **and** the operator's manual-match rate over the next 14d drops vs the prior 14d baseline (30 manual matches), declare success and archive the change via `/opsx:archive`.
- [x] 6.5 If accepted-rate is below 40% **or** the operator un-matches > 10% of accepted rows in the first 48h, revert via PR (pure code revert, no data migration) and re-plan with the captured `wrangler tail` corpus as evidence.

## 7. Harness bookkeeping

- [x] 7.1 Register `F-028` in `.harness/features.json` with `status: "in-progress"`, `depends_on: ["F-007", "F-027a"]` (F-027a is a dep because the regression fixtures (task 5.4) come from F-027a's persisted candidates), scope covering the four source files + the four test files.
- [x] 7.2 On successful soak, flip `status: "passing"` + populate `test_file`, `coverage`, `approaches_tried`, and bump the file header's `total_features` + `passing` counters.
- [x] 7.3 Append a Meta-Session retrospective to `.harness/context_summary.md` covering: (a) how production data drove the algorithm choice, (b) which decisions (D1–D7) compounded vs which were independently useful, (c) post-deploy false-positive rate vs the 10% rollback threshold.

---

## Close-out notes (2026-07-12)

Sections 1-5, 6.1, 7.1 were completed in the 2026-05-22 session (PR #29,
merged as 21869c7); the boxes above were ticked retroactively today.

- 6.2: production deploy happened 2026-05-22 12:25:41 UTC, 24 s after the
  merge commit, but the Version ID was never captured — the harness kept
  F-028 "in-progress" for 7 weeks as a result. Today's redeploy
  (c0df8a72-271f-4ffa-950f-081dcb307491) is recorded in context_summary.
- 6.3 (cron tail): superseded — a retroactive DB audit of the entire 7-week
  window is stronger evidence than one cron's tail.
- 6.4 soak VERDICT: SUCCESS, measured 2026-05-22 → 2026-07-12 from Neon:
  35 fuzzy auto-matches; manual matches fell from the 30-per-14d pre-change
  baseline to 9 total (all before 2026-06-06, zero since); pending
  fuzzy_below_threshold queue fell 24 → 3 (all three are genuine hard cases:
  wrong-artist covers and classical-title variants).
- 6.5 rollback triggers: never fired — 0 of 35 accepted fuzzy matches were
  invalidated (threshold was 10%).
