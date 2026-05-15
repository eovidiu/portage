## 1. Spec & feature registration

- [x] 1.1 Write proposal.md, design.md, tasks.md
- [x] 1.2 Write specs/rematch-heuristic/spec.md (ADDED requirements)
- [ ] 1.3 Register F025 in `.harness/features.json` with `depends_on: ["F024"]`

## 2. Helper: `src/match/rematch.ts`

- [ ] 2.1 Export `buildRematchQuery(artist, title): string | null`
- [ ] 2.2 Unit-test the matrix in design.md D1 (Drake feat., empty artist, single-word artist, parenthetical title, etc.)
- [ ] 2.3 Export `runRematchSweep(env, { limit }): Promise<RematchSweepResult>` that iterates pending unmatched and per-row delegates to `buildRematchQuery` + `searchTidalCandidates`

## 3. Routes: `src/routes/unmatched.ts`

- [ ] 3.1 Add `GET /unmatched/rematch` (sweep) — validates `limit` (default 10, max 25), returns sweep payload
- [ ] 3.2 Add `GET /unmatched/:spotify_id/rematch` (single-row) — looks up the row, applies the helper, returns the F-024 response shape OR `{ error: "invalid_input" }` 400
- [ ] 3.3 Emit `event: "rematch_row"` and `event: "rematch_sweep"` structured log lines (no PII, no raw query)

## 4. Tests

- [ ] 4.1 `tests/match/rematch.test.ts` — heuristic happy paths + edge cases
- [ ] 4.2 `tests/routes/unmatched.test.ts` — sweep happy path, partial Tidal failure, invalid_input handling, 405/501 NOT applicable (only GET)
- [ ] 4.3 Single-row variant: 404 on unknown spotify_id, 400 on degenerate metadata, 200 on happy path

## 5. Verification

- [ ] 5.1 `npm test -- match/rematch`
- [ ] 5.2 `npm test -- routes/unmatched`
- [ ] 5.3 `npm test` full suite to confirm no regressions
- [ ] 5.4 Coverage check: 95% on touched code in `src/match/rematch.ts` and the new route handlers

## 6. Cross-repo UI

- [ ] 6.1 Author sister OpenSpec change `rematch-panel` in `portage-ui` (separate repo)
- [ ] 6.2 UI: `src/hooks/useRematch.ts` (manual-trigger query, NOT auto-fetched)
- [ ] 6.3 UI: button on UnmatchedPage that triggers the sweep
- [ ] 6.4 UI: per-row panel rendering candidates with "Use" buttons that reuse `useMatchUnmatched`
- [ ] 6.5 UI tests in MSW

## 7. Archive

- [ ] 7.1 After both repos merge and the route is exercised in prod, archive this change under `openspec/changes/archive/YYYY-MM-DD-f-025-rematch-heuristic/`
