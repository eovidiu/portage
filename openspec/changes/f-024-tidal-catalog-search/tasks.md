## 1. Shared Tidal search helper (refactor extraction)

- [ ] 1.1 Create `src/match/tidal-search.ts` exporting `searchTidalCandidates(env, query): Promise<{ candidates: ResolvedTidalCandidate[]; retried: boolean; status: number }>` that owns the URL composition (`https://openapi.tidal.com/v2/searchResults/{encodeURIComponent(query)}?include=tracks,tracks.artists,tracks.albums`), the 429 + `Retry-After` single-retry pattern, and the JSON:API → `ResolvedTidalCandidate[]` extraction (moved from `extractCandidates` + `resolveTrack` in `src/match/fuzzy.ts`)
- [ ] 1.2 Refactor `src/match/fuzzy.ts` to consume `searchTidalCandidates` — delete the inlined `searchTidal`, `extractCandidates`, and `resolveTrack` once the helper replaces them
- [ ] 1.3 Re-run the full fuzzy test suite (`npm test -- src/match/fuzzy.test.ts`) and confirm 100% pass with no behavioral change
- [ ] 1.4 Fallback path: if 1.1–1.3 prove too invasive (e.g., touching the scoring module's internal types), revert and inline the same pattern in the new handler — the spec mandates behavior, not the refactor

## 2. Query and limit validation

- [ ] 2.1 Add `validateSearchQuery(q: unknown): { ok: true; q: string } | { ok: false; error: "invalid_query"; message: string }` to `src/routes/unmatched.ts` (or a new `src/routes/_validators.ts` if it'd be reused elsewhere) — enforces trimmed length 1–200 and rejects `/[\x00-\x1F]/`
- [ ] 2.2 Add `validateSearchLimit(raw: unknown): { ok: true; limit: number } | { ok: false; error: "invalid_limit"; message: string }` — accepts absent (defaults to 10), integer string, integer; rejects non-integers and out-of-range
- [ ] 2.3 Write vitest unit tests for both validators covering every R2 scenario (missing q, 201-char q, control char in q, limit=26, limit absent, limit=0, limit=non-integer)

## 3. Per-principal token-bucket rate limiter

- [ ] 3.1 Add `src/middleware/rate-limit.ts` (or inline in the route module) implementing a 10 req / 60 s token bucket keyed on the `cf-access-authenticated-user-email` header, state in a module-scope `Map<string, { tokens: number; lastRefillMs: number }>`
- [ ] 3.2 Expose `takeToken(email: string): { allowed: true } | { allowed: false; retryAfterSec: number }` and a `_resetBuckets()` test helper
- [ ] 3.3 Vitest unit tests: 10 successful takes in a row, 11th rejected; refill correctness over simulated time advance; two distinct principals have independent buckets

## 4. Route handler

- [ ] 4.1 Implement `GET /:spotify_id/search` in `src/routes/unmatched.ts` mounted on the existing router so it inherits F-019 CF Access middleware
- [ ] 4.2 Handler flow (in this exact order so failure cases short-circuit before any upstream call): validate query → validate limit → resolve `spotify_id` against `tracks` table (404 if absent) → take rate-limit token (429 if exhausted) → call `searchTidalCandidates` with 3s AbortController timeout → map result to flat candidates → slice to `limit` → emit structured log → return 200
- [ ] 4.3 Implement the error taxonomy mapper: `TidalReauthRequired` → 502/`tidal_reauth_required`; `AbortError` → 504/`tidal_timeout`; non-2xx upstream after retry → 502/`tidal_upstream_error`; malformed JSON:API → 502/`tidal_upstream_error`

## 5. Response mapper

- [ ] 5.1 Implement `mapCandidateToResponseShape(c: ResolvedTidalCandidate): { tidal_id, title, artists[], album, duration_ms, isrc }` ensuring `artists` is always an array (empty if unresolvable), `album` is `null` when absent, `duration_ms` defaults to 0 on unparseable duration, and `isrc` is `null` when absent
- [ ] 5.2 Confirm by code review and by R3 scenario tests that `confidence` is NOT present on any candidate returned by this endpoint
- [ ] 5.3 Vitest unit tests for the mapper covering: full track with all fields; track with missing album; track with empty `duration`; track with no resolvable artists

## 6. Structured logging

- [ ] 6.1 Emit exactly one `console.log(JSON.stringify({ event: "manual_search", spotify_id, q_len, result_count, tidal_status, duration_ms }))` per request, on success and on every error path
- [ ] 6.2 Capture `Date.now()` at handler entry and at log emission to compute `duration_ms`
- [ ] 6.3 Vitest assertion that no log line emitted by the handler contains the raw query value, the CF Access email, the Tidal bearer token (any `eyJ`-prefixed substring), or the configured Tidal client id

## 7. Integration tests

- [ ] 7.1 Write `src/routes/unmatched.search.test.ts` using vitest with a fetch-mocked `tidalFetch` covering every R5 error code:
  - Happy path (200 with 5 candidates)
  - 400 `invalid_query` (missing, too long, control char)
  - 400 `invalid_limit` (out of range, non-integer)
  - 404 `unknown_spotify_id`
  - 429 `rate_limited` (11th request in a tight loop)
  - 502 `tidal_upstream_error` (Tidal 503 twice)
  - 502 `tidal_reauth_required` (`TidalReauthRequired` thrown)
  - 504 `tidal_timeout` (Tidal upstream delayed beyond 3s)
  - 502 `tidal_upstream_error` on malformed upstream JSON
- [ ] 7.2 Assert that no `eyJ`-prefixed substring appears in any 502 response body
- [ ] 7.3 Confirm the 401-path test runs against the router stack so the middleware actually executes and rejects (no special-case in the handler)

## 8. Coverage gate

- [ ] 8.1 Run `npm test -- --coverage` and confirm ≥95% line coverage on `src/routes/unmatched.ts` (new handler), `src/match/tidal-search.ts` (new helper), and `src/middleware/rate-limit.ts` (new limiter)
- [ ] 8.2 Add any missing-branch tests until the gate passes

## 9. Harness registration

- [ ] 9.1 Add a new entry to `.harness/features.json` with `id: "F024"`, `description: "Manual Tidal catalog search proxy for the Unmatched picker"`, `priority: <next available>`, `status: "pending"`, `scope: ["src/routes/unmatched.ts", "src/match/tidal-search.ts", "src/middleware/rate-limit.ts"]`, `depends_on: []`, `assigned_to: null`, `test_file: null`, `coverage: null`, `notes: "spec: openspec/changes/f-024-tidal-catalog-search"`, `correction_cycles: 0`, `scope_expansions: []`, `approaches_tried: []`, `failure_reason: null`, `discovered_via: "F-012 Sprint-7 M1 broken auto-candidates"`
- [ ] 9.2 Confirm the new entry passes JSON schema validation by re-reading the file and checking the existing-feature shape (all required keys present)

## 10. Cross-repo contract sanity check

- [ ] 10.1 After both the portage and portage-ui proposals materialize, run the contract diff from plan §6: `diff <(grep -A20 '"candidates"' openspec/changes/f-024-tidal-catalog-search/specs/tidal-catalog-search/spec.md) <(grep -A20 '"candidates"' /Users/fameftimie/work/portage-ui/openspec/changes/portage-ui-foundation/specs/web-ui-tidal-search/spec.md)` and confirm the JSON shape blocks agree on field names, types, and the absence of `confidence`
- [ ] 10.2 If they diverge, update the lagging spec — do NOT change the contract without re-running the cross-repo agreement

## 11. Final harness check

- [ ] 11.1 Run `.harness/init.sh full_test` and confirm green (all 637+ existing tests still pass)
- [ ] 11.2 Mark F024 status `"passing"`, set `test_file` to `"src/routes/unmatched.search.test.ts"`, set `coverage` to the measured number, and commit the harness metadata change as a `docs(harness)` commit separate from the implementation commit
