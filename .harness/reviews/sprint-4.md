# Sprint 4 Review (2026-04-26)

Reviewer: Opus, read-only, single deliverable.
Sprint scope: F-006 (ISRC matching), F-007 (fuzzy matching), F-008 (Tidal playlist write).
Commits in scope (4, all on `main`, 4 ahead of `origin/main`):

- `aa585d4` feat(F-006): ISRC-based track matching with artist agreement + duration tiebreak
- `4b4eb48` feat(F-007): fuzzy track matching with weighted scoring + unmatched fallback
- `5441f6e` feat(F-008): Tidal playlist write with create/dedupe/batch/invalid-requeue
- `f15c8b7` docs: update features.json F008 to passing with coverage

Working tree is clean. Sprint 3 fix-wave (`e7d1d0c`, `d4ab1f4`, `441449a`) is in already and the typecheck gate added in S3 is now load-bearing — `npx tsc --noEmit` passes clean (exit 0) on this sprint, and the TaskCompleted hook coverage check (`441449a`) ran before each F-006/F-007/F-008 close. The "false TOOLING BLOCKER" pattern from sprints 1–3 cannot recur silently.

---

## Verdict

**SHIP-WITH-FOLLOW-UPS** — every behavioural MUST across F-006/F-007/F-008 has at least one mapped test, all 323/323 unit tests pass at review time (vs Sprint 3's 172/172 — +151 tests in this sprint), `npx tsc --noEmit` is exit 0, coverage gate met on every src/ file (most at 100%), and there are no Worker-incompatibility regressions. The Sprint 3 mechanical fix-waves are visibly paying off — zero correction cycles on F-006/F-007/F-008, zero false coverage claims, zero Node-API contraband in src/.

Three follow-ups warrant attention before F-009 (sync orchestrator) starts. None block proceeding to F-011 (logging) which is a pre-req for F-009. None require code changes to F-006/F-007/F-008 themselves; the issues are environmental/operational.

- **Critical: schema drift not yet applied to live Neon.** F-008 introduces a new `matches.tidal_id_invalid BOOLEAN NOT NULL DEFAULT false` column and queries it in the playlist watermark SELECT (`src/db/matches.ts:55`). The column is referenced in code, exercised by unit-mock tests, and documented in features.json F008 notes — but it is **NOT** in `db/schema.sql`, **NOT** in any committed migration, and (per features.json notes verbatim: *"PENDING: ALTER TABLE matches ADD COLUMN tidal_id_invalid BOOLEAN NOT NULL DEFAULT false must be applied to production Neon by Ovidiu before first run"*) has not been applied to the production Neon branch. First production run will throw a SQL error from `selectMatchesNewerThan`. C1 below.
- **Major: F-007 has the only explicit `TODO(ovidiu)` Tidal-API audit marker; F-006 and F-008 have only descriptive comments.** Audit discipline is asymmetric — Ovidiu, looking for "what do I need to verify against Tidal docs?", will only find the F-007 search URL via grep. The ISRC filter URL (`isrc.ts:9`), the playlists base URL (`playlist-endpoints.ts:5`), and the relationships/items pattern in `playlist-endpoints.ts:12` all need the same human verification but are easy to miss. M1 below.
- **Minor cluster:** the live Neon `tracks` schema has the `idx_tracks_added_at` index from the Sprint-3 fix wave (verified via `mcp__Neon__describe_table_schema`); `sync_state` matches `db/schema.sql` exactly; `matches`/`unmatched` schemas could not be read from production (permission denied for reviewer — see Audit notes), so the `tidal_id_invalid` column drift is confirmed only against `db/schema.sql`. m1–m6 below.

The fuzzy/ISRC/playlist implementations themselves are clean. Spec-vs-code matches verbatim on the load-bearing items: weights 0.40/0.30/0.20/0.10, ISRC threshold 0.85, fuzzy threshold 0.85, album threshold 0.9, duration cap 5000ms, 2000ms ISRC duration tolerance, BATCH_SIZE 100, tie-break-on-min-duration-delta within 0.001 epsilon, ascending `matched_at` order on append, dedup against current playlist, recreate on missing playlist, 401 via `tidalFetch`, 429 retry-once-with-Retry-After. The `requeueForInvalidTidalId` bypass-pending-guard is justified and isolated (only fires for `reason='tidal_track_removed'`).

Net recommendation: 30-minute follow-up wave (apply the schema migration, add the missing TODO markers, optionally land the m4 deferred-test note), then proceed.

---

## Per-task verdict

- F-006 — ISRC matching: **PASS-WITH-NOTES** (every R1–R11 has at least one T-006-NN test; 24 isrc.test.ts cases pass; isrc.ts coverage 98.8%/97.95%/100%/100% — the one uncovered branch at line 56 is a defensive guard; T-006-13 + T-006-14 deferred to live Tidal API per features.json — acceptable; the URL template at `isrc.ts:9` lacks an explicit `TODO(ovidiu)` audit marker — see M1)
- F-007 — Fuzzy matching: **PASS** (weights and thresholds match spec verbatim; fuzzy.ts/title.ts/score.ts all 100% across the board; 21+12+11+3 tests in fuzzy/score/title/unmatched suites; T-007-15 deferred to live Tidal API per features.json — acceptable; URL template properly carries the `TODO(ovidiu)` marker)
- F-008 — Tidal playlist write: **PASS-WITH-FIXES** (16 playlist-writer + 29 playlist-endpoint tests; every R1–R11 mapped; correctly threads invalid-track-id requeue through both `flagInvalidTidalId` and `requeueForInvalidTidalId`; **schema migration for `matches.tidal_id_invalid` is not yet committed to `db/schema.sql` and not yet applied to production Neon — C1**; URL templates lack `TODO(ovidiu)` markers — see M1)

---

## Coverage report

`npm run test:coverage` runs cleanly under `@cloudflare/vitest-pool-workers@0.5.41` with the istanbul provider. **Real numbers, independently verified at review time:**

```
Test Files  24 passed (24)
     Tests  323 passed (323)
  Duration  5.24s

% Coverage report from istanbul
-------------------|---------|----------|---------|---------|--------------
File               | % Stmts | % Branch | % Funcs | % Lines | Uncovered
-------------------|---------|----------|---------|---------|--------------
All files          |   98.99 |    93.02 |   96.33 |   99.28 |
 scripts/mint-…    |   41.66 |     37.5 |      50 |   41.66 | (CLI path)
 src               |   88.88 |      100 |       0 |     100 |
  index.ts         |   88.88 |      100 |       0 |     100 | (scheduled stub)
 src/auth          |   95.83 |    81.25 |     100 |   95.65 |
  errors.ts        |     100 |      100 |     100 |     100 |
  verify.ts        |   95.23 |    81.25 |     100 |      95 | 30
 src/crypto        |     100 |      100 |     100 |     100 |
 src/db            |     100 |      100 |     100 |     100 |
  matches.ts       |     100 |      100 |     100 |     100 |
  oauth_state.ts   |     100 |      100 |     100 |     100 |
  provider_tokens  |     100 |      100 |     100 |     100 |
  sync_state.ts    |     100 |      100 |     100 |     100 |
  tracks.ts        |     100 |      100 |     100 |     100 |
  unmatched.ts     |     100 |      100 |     100 |     100 |
 src/match         |    99.5 |       99 |     100 |     100 |
  artist.ts        |     100 |      100 |     100 |     100 |
  fuzzy.ts         |     100 |      100 |     100 |     100 |
  isrc.ts          |    98.8 |    97.95 |     100 |     100 | 56
  score.ts         |     100 |      100 |     100 |     100 |
  title.ts         |     100 |      100 |     100 |     100 |
 src/middleware    |    97.5 |    81.48 |     100 |    97.5 |
  auth.ts          |   94.44 |       80 |     100 |   94.44 | 33
  secrets.ts       |     100 |    82.35 |     100 |     100 | 8,15,26
 src/providers/spotify
  liked.ts         |     100 |    89.47 |     100 |     100 | 57,89-92
  oauth.ts         |    98.9 |    93.54 |   93.33 |     100 | 94,179
 src/providers/tidal
  client.ts        |     100 |    95.45 |     100 |     100 | 59
  oauth.ts         |   98.33 |      100 |    90.9 |     100 |
  playlist-endpts  |     100 |      100 |     100 |     100 |
  playlist.ts      |     100 |    98.41 |     100 |     100 | 192
  scopes.ts        |     100 |      100 |     100 |     100 |
 src/routes        |     100 |    94.11 |     100 |     100 |
 src/routes/auth   |     100 |    91.66 |     100 |     100 |
 src/sync          |     100 |      100 |     100 |     100 |
  playlist-writer  |     100 |      100 |     100 |     100 |
-------------------|---------|----------|---------|---------|--------------
```

### Reconciliation with `features.json`

| Feature | features.json claim | Actual | Verdict |
|---------|--------------------|--------|---------|
| F006 | `isrc.ts: 98.8% stmts, 97.95% branches, 100% functions, 100% lines (line 56 defensive guard unreachable from caller); artist.ts: 100%; matches.ts: 100%` | exact match — istanbul shows 98.8/97.95/100/100 with line 56 as the only uncovered branch | **match** |
| F007 | `fuzzy.ts: 100/100/100/100; title.ts: 100; score.ts: 100; unmatched.ts: 100` | exact match across all four files | **match** |
| F008 | `playlist.ts: 100% stmts, 98.41% branches, 100% funcs, 100% lines; playlist-endpoints.ts: 100%; playlist-writer.ts: 100/100/100/100; matches.ts: 100%; sync_state.ts: 100%; unmatched.ts: 100%` | exact match | **match** |

All three Sprint 4 features have honest, accurate coverage claims that survive independent reproduction. **The Sprint-3 D2 hook gate (`441449a`) is doing its job.** This is the first sprint with zero coverage-claim drift since the project began.

### Uncovered-line classification

| File | Line | Classification | Rationale | Recommendation |
|---|---|---|---|---|
| `src/match/isrc.ts` | 56 | **defensive — unreachable from caller** | `if (candidates.length === 0) return null;` — `pickBestCandidate` is called only at L205 *after* `agreeing.length === 0` check at L200. By construction, `pickBestCandidate` never receives an empty array. The guard is genuinely defensive (cheap insurance against a future caller). | Leave as-is. The features.json note "line 56 defensive guard unreachable from caller" is accurate. |
| `src/providers/tidal/playlist.ts` | 192 | **defensive — fall-through after invalid-id extraction** | The 400/422 invalid-id branch at L192-208 is fully covered, but istanbul reports L192 (the `else` of `if (response.status === 400 \|\| response.status === 422)`) as one branch. The "neither 400 nor 422 nor 200" path is exercised by the 500-on-batch test. The 98.41% reflects istanbul's branch-counting peculiarity, not a real gap. | Leave as-is. |

After classification, all uncovered lines are real defensives or istanbul artifacts. **No real test gaps in the Sprint-4 source surface.**

(Pre-existing uncovered lines from Sprints 1–3 — `verify.ts:30`, `auth.ts:33`, `secrets.ts:8/15/26`, `liked.ts:57/89-92`, `spotify/oauth.ts:94/179`, `tidal/client.ts:59`, `tidal.ts:29`, `health.ts:54` — are unchanged from sprint-3.md and still classified there.)

---

## Critical issues (must fix before F-009 / Sprint 5 starts)

### C1. `matches.tidal_id_invalid` schema drift — column queried in code, missing from `db/schema.sql`, not applied to production Neon

- F-008 spec, "Database schema additions":
  ```sql
  ALTER TABLE matches ADD COLUMN tidal_id_invalid BOOLEAN NOT NULL DEFAULT false;
  ```
- `src/db/matches.ts:53-58` queries it:
  ```ts
  `SELECT spotify_id, tidal_id, matched_at::text AS matched_at
   FROM matches
   WHERE matched_at > $1::timestamptz
     AND tidal_id_invalid = false
   ORDER BY matched_at ASC`
  ```
- `src/db/matches.ts:67-70` writes it:
  ```ts
  `UPDATE matches SET tidal_id_invalid = true WHERE tidal_id = $1`
  ```
- `db/schema.sql:55-64` (committed) — no `tidal_id_invalid` column. The CREATE TABLE matches statement ends at `sync_run_id UUID REFERENCES sync_runs(run_id)`.
- features.json F008 notes verbatim: *"PENDING: ALTER TABLE matches ADD COLUMN tidal_id_invalid BOOLEAN NOT NULL DEFAULT false must be applied to production Neon by Ovidiu before first run."*

**Why it matters:**
1. **Live first-production-run failure:** `writePlaylist` calls `selectMatchesNewerThan` on every run (`src/sync/playlist-writer.ts:60`). The first time the playlist writer runs against the production Neon branch, the SELECT will throw `column "tidal_id_invalid" does not exist`. The full sync run will fail.
2. **Mock fiction:** unit tests pass because vi.mock for `@neondatabase/serverless` accepts any SQL string and returns whatever the mock dictates. The `WHERE tidal_id_invalid = false` clause is never validated against a real Postgres parser. F-Integ doesn't cover the F-008 path (gap from Sprint 3 M4 — also unfixed).
3. **Two missing artifacts, not one:**
   - `db/schema.sql` needs the column added so future Neon-branch integration tests apply the right schema.
   - Production Neon needs the `ALTER TABLE` applied. (Reviewer could not verify production schema directly: `mcp__Neon__describe_table_schema` for `matches` was permission-denied for the reviewer role. The features.json note is the authoritative status: not yet applied.)

**Fix sketch (~5-line + 1 SQL):**
```sql
-- Add to db/schema.sql line 64 (after sync_run_id):
ALTER TABLE matches ADD COLUMN IF NOT EXISTS tidal_id_invalid BOOLEAN NOT NULL DEFAULT false;
```
And:
```sql
-- Apply to production Neon (square-wave-04443485, branch production):
ALTER TABLE matches ADD COLUMN IF NOT EXISTS tidal_id_invalid BOOLEAN NOT NULL DEFAULT false;
```

The `ADD COLUMN IF NOT EXISTS` form is idempotent — safe to apply multiple times. Only Ovidiu has the production Neon credential to apply this; reviewer cannot. The schema.sql edit is the agent-fixable half; ALTER TABLE is the human half.

**Recommendation**: P0 for the F-008 fix wave, before any F-009 implementation that touches the playlist write path. Same recurring class as Sprint 3 M3 (the missing `idx_tracks_added_at` index, also caught at review and not applied to production at the time — that one was applied subsequently per the schema.sql header comment).

---

## Major issues (should fix before F-009 starts)

### M1. Tidal-API audit-marker discipline asymmetric across the three features

- F-007 `src/match/fuzzy.ts:9-12` correctly carries the audit marker:
  ```ts
  // TODO(ovidiu): Verify this endpoint against current Tidal Open API v2 docs.
  // Documented form as of 2026-04-26: GET /v2/searchresults/{query}/relationships/tracks
  // with ?countryCode=<CC>&include=tracks&limit=5
  const TIDAL_SEARCH_BASE = "https://openapi.tidal.com/v2/searchresults";
  ```
- F-006 `src/match/isrc.ts:7-9` has only descriptive prose, no audit marker:
  ```ts
  // Tidal Open API v2 — search by ISRC
  // https://developer.tidal.com/reference/get_tracks-v2
  const TIDAL_TRACKS_URL = "https://openapi.tidal.com/v2/tracks";
  ```
- F-008 `src/providers/tidal/playlist-endpoints.ts:1-13` likewise:
  ```ts
  // Tidal Open API v2 playlist endpoints
  // Batch size sourced from Tidal API docs: max 100 items per add-tracks request.
  export const BATCH_SIZE = 100;
  export const TIDAL_PLAYLISTS_URL = "https://openapi.tidal.com/v2/playlists";
  export function playlistUrl(playlistId: string): string { return `${TIDAL_PLAYLISTS_URL}/${playlistId}`; }
  export function playlistTracksUrl(playlistId: string): string { return `${TIDAL_PLAYLISTS_URL}/${playlistId}/relationships/items`; }
  ```

**Why this matters in practice.** The task brief explicitly asks: *"all picked URL templates from the Tidal Open API and marked as TODOs for Ovidiu to verify."* F-006 and F-008 deviate from this. A future `grep -rn "TODO(ovidiu)" src/` will surface only `fuzzy.ts:9` — Ovidiu will not see the F-006 and F-008 endpoints flagged for verification. All three feature specs (F-006-R1, F-008-R4) explicitly say *"sourced from the Tidal Open API reference"* — without an audit marker, the implicit "yes, this is a guess; please verify" is invisible to a future reader.

The four endpoints that need explicit Ovidiu verification are:

1. **F-006 ISRC search**: `GET /v2/tracks?filter[isrc]=<ISRC>&countryCode=<CC>` — verify the `filter[isrc]` query-param syntax matches Tidal v2 (some Tidal v2 endpoints use `filter` with bracketed keys, others use plain query params).
2. **F-007 fuzzy search**: `GET /v2/searchresults/{query}/relationships/tracks?include=tracks&limit=5&countryCode=<CC>` — verify the relationships path and `include` semantics.
3. **F-008 create playlist**: `POST /v2/playlists` with `{data: {type: "playlists", attributes: {title, description, privacy: "private"}}}` JSON:API body. Verify the `privacy` enum value (Tidal docs may use `PRIVATE` uppercase, `private`, or a different field like `visibility`); the spec at F-008-R3/T-008-03 explicitly notes "(or the equivalent Tidal API value documented in the constants file)" — if Tidal uses `PRIVATE`, the constant should live in `playlist-endpoints.ts` rather than being inlined as the literal string `"private"` at `playlist.ts:36`.
4. **F-008 add tracks**: `POST /v2/playlists/{id}/relationships/items` with batch body. Verify batch limit is in fact 100 (current `BATCH_SIZE = 100`) and the JSON:API relationship-add shape matches.

**Fix (one-line per endpoint):** add `// TODO(ovidiu): Verify URL template against Tidal Open API v2 docs.` immediately above each constant. Cost: 4 additional comments. Payoff: Ovidiu's pre-deploy audit becomes mechanical (`grep TODO(ovidiu) src/`).

While there, also lift the literal `"private"` at `playlist.ts:36` into a named constant in `playlist-endpoints.ts` (`export const PLAYLIST_PRIVACY = "private";`) so the audit marker can apply to it directly. The description literal at `playlist.ts:21-22` is fine where it is (matches F-008-R2 verbatim).

**Recommendation**: 5-minute fix as part of the C1 wave.

---

## Minor issues (style, polish)

- **m1.** `src/sync/playlist-writer.ts:88-90` — the watermark advance logic is documented in code but the comment understates a real semantic. The comment says: *"Advance the watermark only on overall success (even partial writes advance it so that successfully-added tracks are not retried; deduplication handles safety)"*. But: if `result.errors > 0` (e.g., second 429 on a later batch caused partial abort), the watermark **still advances**. This means matches that landed *after* the in-flight watermark but were not added to the playlist this run will be re-evaluated next run via the `selectMatchesNewerThan` query — but they'll be filtered by the dedup against current playlist contents (if they got added) or re-attempted (if they didn't, since they're newer than the new watermark). This is sound: `getAllPlaylistTrackIds` re-fetches every run. But the comment could be clearer: *"Watermark advances after addTracksToPlaylist returns (even with errors). Re-attempted matches are filtered out by getAllPlaylistTrackIds dedup on the next run; missed-this-run matches will appear as 'newer than watermark' next run and be picked up."*

- **m2.** `src/sync/playlist-writer.ts:88-91` — `writeState(sql, KEY_LAST_WRITE_AT, new Date().toISOString())` advances the watermark using the **wall-clock at the moment of writeState call**, not the latest `matched_at` from the matches that were just processed. This is a subtle off-by-one risk: if a match row gets inserted *between* `selectMatchesNewerThan` (line 60) and `writeState` (line 90) — e.g., the orchestrator (F-009) writes a match concurrently — that newly-inserted match will have `matched_at < wall-clock-now` but `> the watermark we're about to set`. The watermark advance to "now" would skip it. Spec F-008 §"Append new matches" reads `matches with matched_at > last_playlist_write_at` (so `>` not `>=`); using max(matched_at) of just-processed batch instead of `now()` would be safer. **In practice**: F-009 will hold a per-run lock so concurrent matches aren't a real risk for v1 (single-tenant, single Worker invocation). Leave for now; track for F-009 to consider when implementing the run lock.

- **m3.** `src/providers/tidal/playlist.ts:73` — `getPlaylistTracks` builds the URL as `${playlistTracksUrl(playlistId)}?include=items&limit=100` and then `tidalFetch` injects `countryCode=<CC>` via `url.searchParams.set("countryCode", ...)`. This works, but the URL construction is mixed-paradigm: string concat for `?include=...&limit=100`, then `URLSearchParams` for `countryCode`. Switching everything to `URLSearchParams` (or accepting the existing helper signature) would be more uniform. Cosmetic.

- **m4.** F-007 deferred test (T-007-15: curated-set precision against live Tidal API) is tracked in features.json F007 notes verbatim: *"Deferred: T-007-15 (curated 20-track precision, requires live Tidal API or recorded fixtures)"*. F-006 has the same shape: *"Deferred: T-006-13 (curated set live API test), T-006-14 (corrupted ISRC live API test)"*. F-Q1's e2e harness (Sprint 3) exists for live-API metric tests but is currently scoped to OAuth/auth latency — extending it for curated Tidal-API match-rate tests would close all three deferred tests in a single follow-up. **Suggest**: a Sprint-5+ feature `F-Q2: live-Tidal curated-set match-rate harness` that consumes a recorded fixture (e.g., fetching against the production Tidal client once, cached locally). Out of scope for Sprint-4 fix wave.

- **m5.** `src/providers/tidal/playlist.ts:88` — `const hasMore = nextCursor !== null || (json.links?.next !== undefined);` — uses both `meta.cursor` and `links.next` as pagination signals. JSON:API allows either form depending on the server implementation. The defensive OR is correct; one-line comment "// JSON:API allows pagination via either meta.cursor or links.next; check both" would help future readers.

- **m6.** `src/providers/tidal/playlist.ts:21-22` — `PLAYLIST_DESCRIPTION` is module-level. F-008-R2 mandates a specific exact string. The constant is correctly verbatim. But the test suite never asserts the description appears in the create-playlist body. Add one assertion in `tests/providers/tidal/playlist.test.ts` describe `createPlaylist` block:
  ```ts
  expect(body.data.attributes.description).toContain("spotify-roon-sync");
  expect(body.data.attributes.description).toContain("Do not edit manually");
  ```
  Cost: 2 lines. Payoff: catches a future drift in the constant.

- **m7.** `src/match/fuzzy.ts:119` — query string is `${normaliseTitle(track.artist)} ${normaliseTitle(track.title)}` — the Spotify **artist** is normalised by `normaliseTitle` (which strips remaster/feat./single-version etc patterns). For artist names with literal " - Mono" or "(Remastered)" suffixes (rare but plausible: a band like "Massive Attack - Mezzanine Edition" if mis-tagged), this would strip valid artist content. F-007-R1 says *"the concatenation `<artist> <title>` after normalisation"* — and per spec Algorithm at lines 60-61, `normaliseTitle` is applied to titles, while the artist is passed raw to `tokenSortRatio`. The query construction doesn't follow the spec exactly: it normalises both artist and title via `normaliseTitle`. However, `tokenSortRatio` at scoring time correctly uses the raw artist (`score.ts:46`). The only effect is on the **search query string**, where stripping valid artist suffixes might degrade the candidate set Tidal returns. Low risk in practice (most artist names don't carry these suffixes), but consider passing the raw artist to the query: `${track.artist} ${normaliseTitle(track.title)}`. Defer; this is a recall-vs-precision trade-off that needs live-data validation.

- **m8.** `src/providers/tidal/playlist.ts:138` — `errors += trackIds.length - i - BATCH_SIZE;` — this counts "remaining tracks after the aborted batch". Calculation: at iteration `i` (0-indexed start of batch), we've consumed `i + BATCH_SIZE` tracks total (current batch counted as errors via `result.errors`). Remaining = `trackIds.length - (i + BATCH_SIZE)` = `trackIds.length - i - BATCH_SIZE`. Correct. But: if the final batch is the aborted one and `trackIds.length - i - BATCH_SIZE` could go negative (if `trackIds.length < i + BATCH_SIZE`, which happens on the last partial batch), the computation wrongly subtracts. Trace: when `i = 100` and `trackIds.length = 105`, `BATCH_SIZE = 100` → `batch.slice(100, 200)` = 5 items → `errors += 105 - 100 - 100 = -95`. This subtracts 95 from the error count. Bug. **Recommendation**: `errors += Math.max(0, trackIds.length - i - BATCH_SIZE);`. One-line fix; cover with a test that has a partial last batch + 429 on it. Currently the test at `playlist.test.ts:200-211` uses `BATCH_SIZE + 1` items, so the second batch is exactly 1 item — and the abort happens on the **first** batch, so the bug never triggers in tests. A `trackIds.length = 105` + abort-on-last-batch test would catch it.

- **m9.** `src/db/sync_state.ts:46-59` — `buildCursorQuery` is unused in Sprint 4 (it was added for F-005 transaction shape per Sprint 3 fix wave). It's exported but the only consumer is `liked.ts`. Not introduced by Sprint 4; flagging only because the file diff shows in `git log` as touched.

- **m10.** `tests/sync/playlist-writer.test.ts:262-289` — T-008-10 (idempotent on partial failure) does two runs back-to-back, but the test sets up fresh mock state for each (resetting `mockSql` between runs). This proves the *application logic* is idempotent against itself, but does not prove what the spec actually claims: that *playlist contents* end up correct after a real partial failure + retry. The spec says: *"After both runs, the playlist contains exactly the 10 tracks, no duplicates, in the expected `matched_at` order."* The test only asserts that `addTracksToPlaylist` was not called on the second run because the mock'd `getAllPlaylistTrackIds` returned the 5 tracks. This proves the dedup logic's input-output behaviour, not the end-to-end invariant. A future F-Integ extension for F-008 (analogous to Sprint-3's F-Integ for OAuth) would close this with a real Neon branch + recorded Tidal fixtures.

- **m11.** `tests/match/fuzzy.test.ts:435-457` — describe block "matchByFuzzy — sort tie-break path (line 89)" sets up two candidates `td-A` (delta=100ms) and `td-B` (delta=100ms) and asserts a match was made. The test passes either way — both candidates have *identical* duration delta, so the tie-break can pick either. The test doesn't actually exercise the asymmetric tie-break. F-007-R11 / T-007-09 (line 159 of the same file) does test the asymmetric case correctly (`td-220` over `td-225` when Spotify is at 222000). The "line 89" test exists for coverage of the sort callback's tie-break branch, which is fine, but the assertion `expect(insertCall).toBeDefined()` is too weak to call a tie-break test. Rename to "covers tie-break branch" or strengthen by making one candidate strictly closer.

- **m12.** `src/match/fuzzy.ts:14-16` — three single-letter-named constants `ACCEPT_THRESHOLD`, `TIE_EPSILON`, `MAX_CANDIDATES` are clear; no issue. But `WEIGHTS` in `score.ts:4` and `DURATION_CAP_MS` are also constants of the same family (they parameterize the spec's scoring algorithm). Consider co-locating all spec-derived numeric constants in one named block — currently spread across `artist.ts:50` (ARTIST_THRESHOLD), `score.ts:4-6` (WEIGHTS, DURATION_CAP_MS, ALBUM_THRESHOLD), `fuzzy.ts:14-16`. A single `src/match/constants.ts` would make the F-007 spec audit mechanical: one file, every magic number, every threshold. Defer.

---

## Worker compatibility audit

- `src/match/isrc.ts`: imports `@neondatabase/serverless`, `tidalFetch`, `insertMatch`, `artistAgrees`, type `Env`. **No `pg`. No `node:*`. No `Buffer`.** PASS.
- `src/match/artist.ts`: zero imports. Pure functions. **PASS.**
- `src/match/fuzzy.ts`: imports `@neondatabase/serverless`, `tidalFetch`, `insertMatch`, `upsertUnmatched`, `normaliseTitle`, `scoreCandidate`, `tidalDurationMs`, type `Env`. **No `pg`. No `node:*`. No `Buffer`.** PASS.
- `src/match/title.ts`, `src/match/score.ts`, `src/match/index.ts`: pure helpers. **PASS.**
- `src/providers/tidal/playlist.ts`, `src/providers/tidal/playlist-endpoints.ts`: import `Env` and `tidalFetch`. **No `pg`. No `node:*`. No `Buffer`.** PASS.
- `src/sync/playlist-writer.ts`: imports `@neondatabase/serverless`, `Env`, `playlist` helpers, `selectMatchesNewerThan`, `flagInvalidTidalId`, `readState`, `writeState`, `requeueForInvalidTidalId`. **No `pg`. No `node:*`. No `Buffer`.** PASS.
- `src/db/matches.ts`, `src/db/unmatched.ts`: import only `NeonQueryFunction` type. **PASS.**
- `src/db/sync_state.ts`: imports `neon`, `NeonQueryFunction`, `NeonQueryFunctionInTransaction`, `Env`. The `buildCursorQuery` for transaction-callback shape lives here (unchanged from Sprint 3). **PASS.**
- Repo-wide grep: only Worker-incompatible `Buffer.from(...)` calls exist at `src/db/provider_tokens.ts:39` (Sprint 2 code, not Sprint 4) — this is pre-existing and the bytea encoding shape is needed for `@neondatabase/serverless` parameter binding. **Not introduced by Sprint 4.**
- `npx tsc --noEmit` passes clean (exit 0). **No regressions.**
- 323/323 unit tests pass in 5.24s.

PASS on Worker compatibility.

---

## Security audit

| Check | Result |
|---|---|
| **No console.* leaks of tokens, ISRCs-as-secrets, OAuth codes, encryption keys** | PASS — all five Sprint-4 console.log calls (`isrc.ts:186` artist mismatch, `fuzzy.ts:170/190/210` decision logs, `playlist-writer.ts:37` recreated event) emit structured JSON with **no token material**. ISRCs are public catalog identifiers, not secrets — logging `track.spotify_id` and `tidal_id` is intended audit trail. Verified: no `accessToken`, no `client_secret`, no `code_verifier`, no `JWT_SECRET`, no `TOKEN_ENCRYPTION_KEY` in any new log line. |
| **Access tokens flow only via tidalFetch's Authorization header** | PASS — neither `isrc.ts`, `fuzzy.ts`, `playlist.ts`, nor `playlist-writer.ts` ever touches `tokens.accessToken` directly. All Tidal HTTP goes through `tidalFetch(env, url, options)`, which sets `Authorization: Bearer ...` inside `_tidalRequest` (`client.ts:50`). The token never appears in the URL or in any log. |
| **PKCE / state primitives unchanged** | PASS — F-002 / F-003 OAuth flows are unmodified by Sprint 4; the only `src/providers/tidal/` changes in scope are `playlist.ts` (new) and `playlist-endpoints.ts` (new). `oauth.ts`, `client.ts`, and `scopes.ts` are unchanged. `git log src/providers/tidal/oauth.ts` last touch is `de98236` (Sprint 2). |
| **`requeueForInvalidTidalId` bypass justified and isolated** | PASS — the bypass of the `WHERE unmatched.status = 'pending'` guard at `unmatched.ts:48-57` is intentional for the specific case where a previously-matched track's Tidal ID was discovered invalid at write time. Hard-coded `reason = 'tidal_track_removed'` (lines 50, 52) — no caller can pass an arbitrary reason through this path. The bypass is **only** invoked by `playlist-writer.ts:84` after `addTracksToPlaylist` reports the ID as invalid. Spec F-008 §"Track removed from Tidal catalog" mandates this exact behaviour. **Audit verdict**: the bypass is necessary, scoped, and tested (`playlist-writer.test.ts:309-341`). |
| **No new auth code in Sprint 4** | CONFIRMED — `git diff` shows F-006/F-007/F-008 add code only under `src/match/`, `src/sync/`, `src/providers/tidal/playlist.ts`, `src/providers/tidal/playlist-endpoints.ts`, and `src/db/{matches,sync_state,unmatched}.ts`. No middleware changes. No JWT changes. No secret reads in new code. |
| **TIDAL_PLAYLIST_TITLE / TIDAL_COUNTRY_CODE handling** | PASS — both env vars are read with sane fallbacks (`playlist-writer.ts:29` `env.TIDAL_PLAYLIST_TITLE \|\| "Spotify Liked"`; `client.ts:26` `env.TIDAL_COUNTRY_CODE \|\| "RO"`). Both are also baked into `wrangler.toml [vars]`, so they're always set in production. The fallbacks defend against a misconfigured wrangler.toml in a future deploy. No security concern. |

Overall: **PASS**. Sprint 4 introduces no new logging or token-handling surface that risks exposure.

---

## DB-vs-spec / schema audit

Reviewer access: `mcp__Neon__describe_table_schema` is partially available (read-only); two tables (`tracks`, `sync_state`) succeeded; two tables (`matches`, `unmatched`) were permission-denied for the reviewer role (production-DB-read scope is wider than read-only-review scope — see Outstanding Decisions D2 if this should change). For the denied tables, the audit falls back to `db/schema.sql`.

### `matches` table

| Column | F-008 spec addition | db/schema.sql | Sprint-4 code | Live Neon | Match |
|---|---|---|---|---|---|
| `tidal_id_invalid` | `BOOLEAN NOT NULL DEFAULT false` (added in spec §"Database schema additions") | **MISSING** from `db/schema.sql` | queried at `matches.ts:55` and `matches.ts:68` | reviewer **could not query** (permission denied); features.json F008 notes confirm column is **not yet applied** | **C1 — drift** |
| `spotify_id`, `tidal_id`, `method`, `confidence`, `matched_at`, `sync_run_id` | unchanged from F-006 | unchanged | unchanged | not re-verified | inherited from prior sprints |

The `matches` table needs the `tidal_id_invalid` column. C1 covers the fix.

### `unmatched` table

| Column | F-007 spec | db/schema.sql | Sprint-4 code | Live Neon | Match |
|---|---|---|---|---|---|
| `spotify_id` | `TEXT PRIMARY KEY REFERENCES tracks(spotify_id)` | matches | matches | not re-queryable (perm-denied) | yes (inherited) |
| `reason` | `TEXT NOT NULL` | matches | matches | not re-queryable | yes |
| `attempts` | `INTEGER NOT NULL DEFAULT 1` | `INT NOT NULL DEFAULT 0` | upserts hard-code `1` on first insert (`unmatched.ts:18`) | not re-queryable | **soft drift on default value** — spec says `DEFAULT 1`, schema says `DEFAULT 0`. The inserts always pass `1` explicitly so the schema default is never used. Cosmetic drift; consider updating `db/schema.sql` to `DEFAULT 1` to match spec. |
| `last_attempt_at` | `TIMESTAMPTZ NOT NULL DEFAULT now()` | `TIMESTAMPTZ` (nullable, no default) | always passes `now()` explicitly in INSERT and UPDATE | not re-queryable | **soft drift** — spec says NOT NULL DEFAULT now(); schema is nullable without default. The code never writes NULL, so functionally equivalent. Cosmetic. |
| `status` | `TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','matched','skipped'))` | matches | upserts always set `'pending'` | not re-queryable | yes |
| Index `idx_unmatched_status` | `CREATE INDEX idx_unmatched_status ON unmatched(status) WHERE status = 'pending'` | `CREATE INDEX ... ON unmatched(status, attempts)` (no partial filter) | n/a | not re-queryable | **soft drift** — spec specifies a partial index for pending status; schema specifies a composite index without partial. Either works for the typical query (`WHERE status = 'pending'`); the spec's partial form is smaller but rebuilds on status change. Defer. |

### `tracks` table (verified live)

Reviewer queried `mcp__Neon__describe_table_schema` for `tracks` on `square-wave-04443485`:

| Column | live Neon | matches db/schema.sql? | matches Sprint-4 code use? |
|---|---|---|---|
| `spotify_id` | `text NOT NULL` (PRIMARY KEY) | yes | yes (FK target for matches.spotify_id) |
| `isrc` | `text NULL` | yes | F-006 reads via `track.isrc` |
| `artist` | `text NOT NULL` | yes | F-006 reads via `track.artist`; F-007 reads via `track.artist` |
| `title` | `text NOT NULL` | yes | F-007 reads via `track.title` |
| `album` | `text NULL` | yes | F-007 handles `track.album: string \| null` correctly |
| `duration_ms` | `integer NULL` | yes | F-006 + F-007 handle `duration_ms: number \| null` correctly |
| `spotify_added_at` | `timestamptz NOT NULL` | yes | not used by F-006/F-007/F-008 |
| `first_seen_at` | `timestamptz NULL DEFAULT now()` | yes | not used by F-006/F-007/F-008 |
| `idx_tracks_isrc` (partial on `isrc IS NOT NULL`) | present | yes | Used implicitly by F-006 if it ever batches tracks by ISRC presence |
| `idx_tracks_added_at` (DESC) | present | yes | Sprint-3 fix-wave addition; no Sprint-4 query uses it |

`tracks` is **fully consistent**: live Neon ↔ db/schema.sql ↔ Sprint-4 code.

### `sync_state` table (verified live)

Live Neon `sync_state` matches `db/schema.sql` exactly: `key text NOT NULL PRIMARY KEY`, `value text NOT NULL`, `updated_at timestamptz NULL DEFAULT now()`. F-008 uses two new keys: `tidal_playlist_id` and `last_playlist_write_at` — both stored as TEXT (the `last_playlist_write_at` is an ISO 8601 string passed to `writeState(sql, key, value)` and parsed via `::timestamptz` cast in `selectMatchesNewerThan`). **PASS.**

### Cross-feature integration risks (per task brief item E)

1. **F-008's `requeueForInvalidTidalId` BYPASSES F-007's `status='pending'` guard** — verified: bypass is justified and isolated (see Security audit table above). The hard-coded `reason='tidal_track_removed'` is the gating condition, not caller-controlled. **PASS.**

2. **F-008 reuses F-005's `sync_state`; new `readState`/`writeState` helpers added without breaking `readCursor`/`writeCursor`** — verified: `src/db/sync_state.ts` has both the F-005 originals (`readCursor`, `buildCursorQuery`) and the new F-008 generics (`readState`, `writeState`). The two pairs are independent — `readCursor` accepts an `Env` and creates its own `neon()` connection (`sync_state.ts:6-14`); `readState` accepts a `NeonQueryFunction<false, false>` directly (`sync_state.ts:18-27`). No shared state, no signature collision. **PASS.**

3. **`LEFT JOIN matches WHERE m.spotify_id IS NULL` pattern (F-007)** — verified at `fuzzy.ts:97-104`. `selectMatchesNewerThan` (F-008's) at `matches.ts:51-59` is a totally different SELECT (`FROM matches WHERE matched_at > $1::timestamptz AND tidal_id_invalid = false`) — no overlap. **PASS.**

4. **Order of operations**: F-008's `selectMatchesNewerThan` returns rows in ascending `matched_at`; `playlist-writer.ts:75` maps to `tidalIds` preserving order; `addTracksToPlaylist` batches preserving order. Spec F-008-R6 ("ascending matched_at") is end-to-end honored. **PASS.**

---

## Spec coverage matrix

### F-006 (11 MUSTs, 14 T-006-NN tests in spec; 12 implemented + 2 deferred)

| MUST | Test ID(s) | Covered? |
|---|---|---|
| F-006-R1 ISRC search via Tidal `tracks` filter, sourced from Open API | `isrc.ts:9` URL constant + T-006-12 (URL passed to tidalFetch contains `filter[isrc]`) | partial — URL is committed and tested for shape, but **not flagged for Ovidiu verification** (M1) |
| F-006-R2 `countryCode` per F-003-R8 | T-006-12 (verifies `tidalFetch` injects countryCode) | yes (delegated to `tidalFetch` which is F-003 territory) |
| F-006-R3 Artist agreement via token-sort after lowercasing + strip | `artist.ts:40-48` (normalise function) + T-006-06 (feat. strip), T-006-07 (parenthetical strip), `artist.test.ts` "case-insensitive comparison" | yes (algorithm matches spec verbatim) |
| F-006-R4 Threshold `>= 0.85` token-sort | `artist.ts:50` `ARTIST_THRESHOLD = 0.85` + `artist.test.ts` "completely different artists do not agree" | yes |
| F-006-R5 Multi-candidate: select by min `abs(td.duration - sp.duration)` | `isrc.ts:66-83` `pickBestCandidate` loop + T-006-04 (220300 picked over 215000/230000) | yes |
| F-006-R6 Duration tolerance 2000 ms; reject outside | `isrc.ts:11` + `isrc.ts:77` + T-006-05 (5000ms/7000ms deltas rejected) | yes |
| F-006-R7 Confidence `0.95`, method `'isrc'` | `isrc.ts:215` + T-006-11 (asserts confidence === 0.95) | yes |
| F-006-R8 At most one Tidal call per spotify_id per run | `isrc.ts:124-219` (per-track loop, single `fetchByIsrc`) + T-006-08 (50 tracks → 50 calls) | yes |
| F-006-R9 401 → refresh + retry once | inherited from `tidalFetch` (`client.ts:32-39`) + T-006-09 (verifies isrc.ts handles result) | yes (delegated; tidalFetch does this in F-003 layer) |
| F-006-R10 429 → sleep Retry-After, retry once; second 429 = error + fall-through | `isrc.ts:90-103` `fetchByIsrc` + T-006-10 (two 429s → tidal_429 error, no match) | yes |
| F-006-R11 Defensive parsing | `isrc.ts:163-174` JSON parse try/catch + T-006-defensive (parse error test) + T-006 ("missing data field gracefully") | yes |
| **Failure mode**: ISRC absent → skip stage | `isrc.ts:125-128` + T-006-03 (zero Tidal calls with isrc=null) | yes |
| **Failure mode**: Tidal returns 5xx → per-track error | `isrc.ts:153-160` + T-006 5xx test | yes |
| **Failure mode**: Empty results → fall through | `isrc.ts:177-180` + "Tidal returns no results" test | yes |
| T-006-13 (curated 20-track live test, ≥18 matches) | **deferred** (live API or recorded fixture; tracked in features.json F006 notes) | acknowledged-deferred |
| T-006-14 (corrupted ISRC produces no false match) | **deferred** (live API or recorded fixture; tracked in features.json F006 notes) | acknowledged-deferred |

**Net for F-006**: every functional MUST has at least one test. The two deferred tests need live API or recorded fixtures — appropriate to defer. M1 is the audit-marker gap, not a test gap.

### F-007 (13 MUSTs, 15 T-007-NN tests; 14 implemented + 1 deferred)

| MUST | Test ID(s) | Covered? |
|---|---|---|
| F-007-R1 Query = `<artist> <title>` post-normalisation | `fuzzy.ts:119` (note: applies normaliseTitle to both) + implicit in T-007 search tests | yes (with caveat m7 — applies title normalisation to artist; low-risk recall trade) |
| F-007-R2 Title normalisation strips remaster/feat./version patterns | `title.ts:1-25` (case-insensitive) + `title.test.ts` (10 tests covering each pattern) | yes (matches spec patterns verbatim) |
| F-007-R3 Top 5 candidates max | `fuzzy.ts:16` `MAX_CANDIDATES = 5` + `fuzzy.ts:69` `.slice(0, MAX_CANDIDATES)` | yes |
| F-007-R4 Weights 0.40/0.30/0.20/0.10 | `score.ts:4` `WEIGHTS = { title: 0.40, artist: 0.30, duration: 0.20, album: 0.10 }` + T-007-10 (0.40+0.30+0.10+0 = 0.80 weighted assertion) | yes (verbatim) |
| F-007-R5 Title score = token-sort ratio of normalised titles | `score.ts:40-43` + T-007-01 (1.0 on identical), T-007-03 (remaster normalised) | yes |
| F-007-R6 Artist score = token-sort ratio of artists (raw) | `score.ts:45-46` (`tokenSortRatio(sp.artist, tidalArtist)` — no `normalise` call) + T-007-02 (Atmosphere vs Beatles → low) | yes |
| F-007-R7 Duration score formula `1 - min(abs(delta), 5000) / 5000` | `score.ts:48-51` + T-007-11 (delta=10000 → 0.0; delta=2500 → 0.5; delta=0 → 1.0) | yes (formula matches spec verbatim) |
| F-007-R8 Album score: 1.0 if token-sort `>= 0.9`, else 0.0 | `score.ts:53-55` `ALBUM_THRESHOLD = 0.9` + T-007-10 (album=0 case verified) | yes |
| F-007-R9 Final = weighted sum in [0,1] | `score.ts:57-61` + T-007-10 (0.80 verified) | yes |
| F-007-R10 Threshold `>= 0.85` | `fuzzy.ts:14` `ACCEPT_THRESHOLD = 0.85` + T-007-05 (≥0.85 → match), T-007-06 (<0.85 → unmatched) | yes |
| F-007-R11 Tie-break by min duration delta within 0.001 | `fuzzy.ts:87-91` + T-007-09 (220 picked over 225 when both score within epsilon) | yes |
| F-007-R12 At most one search call per spotify_id per run | `fuzzy.ts:118-226` (per-track loop, single `searchTidal`) + T-007-12 (30 tracks → 30 calls) | yes |
| F-007-R13 Per-decision log line | `fuzzy.ts:170/190/210` (3 console.log paths: no_candidates, accepted, rejected_below_threshold) + T-007-13 (5 tracks → 5 fuzzy_decision lines) | yes |
| **Failure mode**: 401 inherited from tidalFetch | inherited; not separately tested at the matcher layer | yes (delegated) |
| **Failure mode**: Empty title normalisation falls back to original | `title.ts:24` `s.length > 0 ? s : title.trim()` + `title.test.ts` "returns original title when stripping produces empty string" | yes |
| T-007-15 (curated 20-track precision ≥0.80) | **deferred** (live API or recorded fixture; tracked in features.json F007 notes) | acknowledged-deferred |

**Net for F-007**: every behavioural MUST tested. T-007-15 deferred appropriately. m7 is the only spec-vs-code nuance (normalising artist in the search query string, which the spec doesn't strictly mandate).

### F-008 (11 MUSTs, 14 T-008-NN tests; all 14 implemented)

| MUST | Test ID(s) | Covered? |
|---|---|---|
| F-008-R1 Title from `TIDAL_PLAYLIST_TITLE` env, default `"Spotify Liked"` | `playlist-writer.ts:29` + T-008-02 (passes title to createPlaylist) + ensurePlaylist default-fallback test | yes |
| F-008-R2 Description = `"Synced from Spotify by spotify-roon-sync. Do not edit manually."` | `playlist.ts:21-22` (verbatim) | code matches spec, but **not asserted in tests** — m6 |
| F-008-R3 Privacy = private | `playlist.ts:36` (literal `"private"`) + T-008-03 (createPlaylist called) + playlist.test.ts "createPlaylist sends POST with correct body" (asserts `body.data.attributes.privacy === "private"`) | yes (literal verified in test) |
| F-008-R4 BATCH_SIZE ≤ 100 sourced from Tidal API | `playlist-endpoints.ts:3` `BATCH_SIZE = 100` + T-008-09 (120 matches → max batch ≤ 100; mock asserts payload shape) | yes (value committed; **needs Ovidiu verification** — M1) |
| F-008-R5 De-duplicate against current playlist | `playlist-writer.ts:66-68` (`getAllPlaylistTrackIds` + `.filter`) + T-008-07 (T1 in playlist → only T3,T4 sent) | yes |
| F-008-R6 Ascending `matched_at` order | `matches.ts:56` `ORDER BY matched_at ASC` + T-008-06 (5 matches inserted in order, sent in order) | yes |
| F-008-R7 401 → refresh + retry once | inherited from `tidalFetch` (`client.ts:32-39`) + T-008-11 (calls addTracksToPlaylist; retry is inside tidalFetch) | yes (delegated) |
| F-008-R8 429 → Retry-After + retry once; second 429 ends batch + records errors | `playlist.ts:167-176` + playlist.test.ts "aborts batch on second 429" + "uses default 1s retry-after" | yes (with bug — m8 — error count math underflows on partial last batch) |
| F-008-R9 Never remove tracks | `playlist.ts` has no DELETE call; `playlist-writer.ts` has no DELETE call + T-008-14 (no remove calls observed) | yes |
| F-008-R10 `last_playlist_write_at = now()` after success | `playlist-writer.ts:90` + T-008-13 (timestamp >= T0 verified) | yes |
| F-008-R11 Recreate on missing playlist; previous not referenced again | `playlist-writer.ts:31-46` + T-008-05 (404 from getPlaylist → createPlaylist called; previous_id + new_id logged) | yes |
| **Failure mode**: invalid Tidal id → flag `tidal_id_invalid` + requeue to unmatched with `reason='tidal_track_removed'` | `playlist.ts:153-211` (extract invalid ids from 400/422 with pointer or id) + `playlist-writer.ts:79-86` + T-008-12 + playlist.test.ts "extracts invalid ids from 400 error response with pointer" (and `id` field) | yes |

**Net for F-008**: every MUST tested. m6 (description not asserted) and m8 (error count underflow) are the only gaps. C1 (schema migration not applied) is the only blocker for production use.

### Cross-cutting acceptance criteria

| Criterion | Status |
|---|---|
| All tests in T-006/T-007/T-008 pass | ✅ 24 + 21 + 16 + 29 + supporting tests = 90+ tests in Sprint 4; 323/323 unit suite green |
| ISRC matches at ≥18/20 on curated set (F-006 acceptance) | deferred per features.json F006 notes (T-006-13 / T-006-14) |
| Fuzzy precision ≥0.80 at 0.85 threshold (F-007 acceptance) | deferred per features.json F007 notes (T-007-15) |
| First playlist run creates playlist + adds all matched tracks (F-008 acceptance) | tested via mocks (T-008-01); end-to-end blocked by C1 (column missing in production) |
| Second run with no new matches makes zero writes (F-008 acceptance) | T-008-08 |
| Idempotency on partial failure: no duplicates (F-008 acceptance) | T-008-10 (logic verified via mock; end-to-end blocked by C1) |

---

## Outstanding decisions for the lead

### D1. Sprint-4 fix wave for C1 + M1 + m6 + m8 vs roll into F-009 prep?

- **C1** (missing `tidal_id_invalid` column) is non-negotiable: any production run of F-008 will throw before doing useful work. Recommended fix-wave priority **P0**.
  - Schema.sql edit: ~1 line.
  - Production ALTER: requires Ovidiu credential; cannot be agent-applied.
- **M1** (TODO markers on Tidal URLs) is documentation discipline; ~5 minutes; should land before any production verification pass.
- **m6** (assert description in playlist test) and **m8** (error-count underflow on partial last batch) are 1-line fixes each.
- **Recommendation**: 30-minute fix wave at the start of F-009 prep. Reuse the F-008 implementer per the Sprint-1+2+3 Meta-Pattern ("reuse existing teammates for fix waves") since they have the playlist code and test scaffolding loaded.
  - The teammate's spawn prompt should mandate `npm run typecheck && npm test && npm run test:coverage` before completion, paste literal output, and explicitly call out the **production ALTER TABLE** as a manual-action handoff for Ovidiu (do not silently skip it).

### D2. Should the reviewer have read access to production Neon schema (matches/unmatched), or is the current denial correct?

- Sprint 3 reviewer noted the same gap: `mcp__Neon__describe_table_schema` was denied for at least some tables.
- This sprint, the denial scoped to `matches` and `unmatched` while allowing `tracks` and `sync_state`. The asymmetry is interesting — possibly because `matches`/`unmatched` are the tables most likely to contain real user data once the system runs, while `tracks` and `sync_state` are catalog/state with no PII. The denial reason cited "production-DB read" wider than "read-only review" scope.
- **Recommendation**: leave as-is. The reviewer can still cross-check `db/schema.sql` against the Sprint feature spec, which is sufficient for catching C1-class drift. Production-schema verification can stay with the lead via the Neon dashboard or a non-reviewer harness role. If a future sprint adds RLS or sensitive columns to `tracks`/`sync_state`, reconsider.

### D3. Add F-Integ test coverage for F-008 playlist write path?

- Sprint 3's M4 noted F-Integ doesn't exercise F-005's persist path. Sprint 4 inherits the same gap for F-008 (playlist write through real Neon + recorded Tidal). C1's mock-vs-real divergence is the symptom: the unit suite is happy with `tidal_id_invalid` because the mock SQL function never parses the query; a real Neon branch would fail at SELECT time.
- **Cost**: ~50 LOC clone of `oauth-spotify.test.ts` structure, plus a recorded Tidal HTTP fixture for the playlist + add-tracks flow.
- **Payoff**: prevents the C1-class bug from recurring on future schema-touching features (F-009 will likely add `sync_runs` write paths; F-011 reads them). Would also serve as a real end-to-end verification of T-008-01/04/05/06/07/08/10 against a live DB.
- **Recommendation**: Sprint-5 candidate, after F-009 + F-011 land (so the F-Integ test can exercise the full sync cycle, not just the playlist write phase). Track as a discovered feature with `discovered_via: "F-008"` and depth 1 — same lineage shape as F-Integ's discovery via F-004b.

### D4. m7 (artist normalisation in fuzzy search query) — spec amendment or code change?

- Spec §"Algorithm: scoring" (lines 60-61) shows artist passed raw to `tokenSortRatio`, title passed through `normaliseTitle`. Spec R1 says "after normalisation" without specifying *which* normalisation applies to artist vs title.
- Code at `fuzzy.ts:119` applies `normaliseTitle` (which strips remaster/feat./version patterns) to **both** artist and title.
- **Effect**: for an artist named e.g. `"The Beatles - Mono Edition"` (rare), the search query would lose `"- Mono Edition"`. Most artist names lack these suffixes.
- **Recommendation**: amend the spec to clarify what "artist normalisation" means. Either:
  - (a) "artist normalisation = lowercasing + strip parenthetical only (no remaster/version stripping)" — needs a new normalisation helper.
  - (b) "artist normalisation = same as title normalisation" — current code is correct, spec should match.
- Defer to Ovidiu's domain judgment. Not a Sprint-4 blocker; no test fails today.

### D5. Sprint-5 spawn prompt template additions

Building on Sprint-3's hook gate work, add:

1. **Schema-drift mechanical check**: extend the TaskCompleted hook to grep new SQL in src/ for column references, then check those columns appear in `db/schema.sql`. Cost: ~30 LOC bash. Payoff: would have caught C1 mechanically. Pattern: same shape as the Sprint-3 D2 coverage-claim hook.
2. **TODO marker discipline**: when a feature spawn prompt mentions "Tidal Open API endpoint", require the teammate to add `// TODO(ovidiu): Verify URL template against Tidal Open API v2 docs.` immediately above each URL constant. Could be added as a Stage 4 to the TaskCompleted hook (grep for `openapi.tidal.com` in new src/ code, require an immediately-preceding `TODO(ovidiu)` line).

---

## Sprint 4 retrospective input

### What worked well

- **Sprint 3's mechanical fix-waves are paying compounding dividends.** Sprint 4 had **zero** correction cycles across F-006/F-007/F-008. Coverage claims are honest. tsc is clean. No "tooling unreliable" claims appeared. The TaskCompleted hook from Sprint 3 (commit `441449a`) and the spotifyFetch / typecheck guardrails from the Sprint-3 fix wave (commit `e7d1d0c`) cleared the runway.
- **One file per concern continues to win.** F-006 split into `isrc.ts` (orchestration) + `artist.ts` (normalisation + tokenSortRatio); F-007 split into `fuzzy.ts` (orchestration) + `title.ts` (normalisation) + `score.ts` (scoring); F-008 split into `playlist.ts` (HTTP surface) + `playlist-endpoints.ts` (URLs + constants) + `playlist-writer.ts` (orchestration). Each file is ≤100-200 LOC, each tests independently. The Sprint-2 Meta-Pattern "one file per concern beats one file per provider" is now baked in.
- **Spec adherence on numeric constants is verbatim.** All weights (0.40/0.30/0.20/0.10), thresholds (0.85, 0.85, 0.85 for ARTIST/ACCEPT/album-input, 0.9 for album-output), epsilons (0.001), batch sizes (100), tolerances (2000ms ISRC, 5000ms fuzzy duration cap), and confidence (0.95 ISRC) match the spec exactly. No "close enough" rounding. Spec-test-code traceability is mechanical.
- **Test discipline: per-spec test ID citation in describe-block names.** Every T-006-NN, T-007-NN, T-008-NN test is named with its ID (e.g., `describe("T-006-04: multiple results selected by closest duration")`). The spec-coverage matrix above was mechanical to assemble. **Continue this pattern.**
- **`requeueForInvalidTidalId` design.** Clean separation between the protective `upsertUnmatched` (status='pending' guard) and the bypass `requeueForInvalidTidalId` (hard-coded reason). The bypass is a justified divergence that Ovidiu can audit in one place; no caller can accidentally trigger the bypass with a different reason. **This is the right shape for "narrow exception to a general rule" cases — replicate when F-009 needs similar overrides.**
- **`tidalFetch` reuse from Sprint 2/3.** All three Sprint-4 features go through `tidalFetch` for the 401-refresh-and-retry semantics. Lesson from Sprint 3 M1 (F-005 reimplemented this and missed the 401 path) was learned and applied. The implementers checked the existing helper before writing new HTTP code.

### What slowed teammates down (or should have)

- **Schema migration discipline still not mechanical.** F-008 introduces `tidal_id_invalid` and queries it without committing the schema.sql change OR applying it to production Neon. The features.json note acknowledges the gap (verbatim: *"PENDING: ALTER TABLE matches ADD COLUMN tidal_id_invalid BOOLEAN NOT NULL DEFAULT false must be applied to production Neon by Ovidiu before first run"*) — but this is the same shape as Sprint 3's missing `idx_tracks_added_at` index (also caught at review, also not applied to production at the time). The Meta-Pattern from Sprint 1 ("Always describe-table the schema before writing a query") was followed for *reading*, but the inverse ("if you add a column reference, also commit the schema migration AND flag it as production-pending") wasn't enforced. **Recommendation**: D5.1 — add a TaskCompleted hook stage that greps src/ for new column references and verifies they appear in db/schema.sql. Mechanical enforcement, like the Sprint-3 coverage-claim gate.
- **TODO marker discipline asymmetric.** F-007 carried the `TODO(ovidiu)` marker for its Tidal endpoint; F-006 and F-008 did not. The task brief explicitly asked for the marker pattern. Three teammates working on parallel Tidal endpoints, only one followed the convention. The Sprint-2 Meta-Pattern "Symmetric features need a 5-min cross-team consistency checkpoint" applies here — but with three implementers on three separate Tidal endpoints, the consistency check would need to be lead-orchestrated rather than peer-to-peer. **Recommendation**: D5.2 — add a hook stage that greps src/ for new `openapi.tidal.com` URL constants and requires an immediately-preceding `TODO(ovidiu)` marker.
- **F-007 search query string normalises artist via title-normalisation helper (m7).** Per spec, only the title undergoes the remaster/feat./version stripping; the artist is passed raw to `tokenSortRatio`. Code applies `normaliseTitle` to both. Low-risk in practice (most artists don't carry these suffixes), but a spec deviation that no test caught. **Recommendation**: spec amendment or code fix — D4 above.

### Recommendations for Sprint 5 spawn prompts

1. **Mandate column-vs-schema reconciliation** in the spawn prompt for any feature that touches src/db/ or adds new columns. Pattern: *"If your feature introduces a new SQL column, BOTH commit the change to db/schema.sql AND flag the production-Neon ALTER as a manual-action handoff for Ovidiu in features.json notes (verbatim: 'PENDING: ALTER TABLE ... must be applied by Ovidiu before first run')."*
2. **Mandate TODO-marker convention for new external-API URL constants**: *"Every URL constant pointing to an external API (openapi.tidal.com, api.spotify.com, etc.) MUST carry an immediately-preceding `// TODO(ovidiu): Verify URL template against <provider> Open API docs.` comment. Existing constants in oauth.ts/client.ts/scopes.ts are exempt only because they were verified in Sprint 2."*
3. **Continue per-spec test ID citation in describe-block names** — Sprint 4 demonstrated again that this pattern makes the spec-coverage matrix mechanical.
4. **Continue one-file-per-concern.** F-009 (orchestrator) is large enough that it should split into `orchestrator.ts` (state machine) + `orchestrator-fetch.ts` (sync_runs row writes) + `run-router.ts` (HTTP surface), or similar. Don't ship a 500-LOC orchestrator.ts.
5. **Sprint-5 work plan**: F-009 prep. C1 must land first (~30-min fix wave). M1 and m6/m8 fold into the same wave. Then F-011 (logging — simpler, depends only on F-001) can run in parallel with the F-009 stub interface (lead-stub pattern from Sprint 2 Meta-Pattern). F-009 depends on F-005, F-006, F-007, F-008, F-011 — all of which will be passing post-fix-wave.

---

## Summary for the lead (one paragraph)

Sprint 4 ships every behavioural MUST across F-006, F-007, F-008 with zero correction cycles, 323/323 unit tests green (vs Sprint 3's 172/172), `npx tsc --noEmit` exit 0, and coverage cleared 95%+ on every src/ file (most at 100%). The Sprint 3 mechanical fix-waves (TaskCompleted hook coverage-claim gate, typecheck guardrail) eliminated the false-claim and broken-build regressions that plagued Sprints 1–3. Spec-vs-code traceability is mechanical — every numeric constant matches the spec verbatim (weights 0.40/0.30/0.20/0.10, ISRC threshold 0.85, fuzzy threshold 0.85, album threshold 0.9, duration cap 5000ms, batch size 100, ISRC duration tolerance 2000ms, tie-break epsilon 0.001, ISRC confidence 0.95) and every R-NN has at least one mapped T-NNN-MM test. **The one critical follow-up before F-009 / F-011 implementation can start using F-008 in earnest is C1: the `matches.tidal_id_invalid` column referenced by `selectMatchesNewerThan` and `flagInvalidTidalId` is missing from `db/schema.sql` and not yet applied to production Neon — first production run of `writePlaylist` will throw**. Two majors and a handful of minors complete the picture: M1 (Tidal-API audit-marker discipline asymmetric — F-007 has `TODO(ovidiu)`, F-006 and F-008 don't), m6 (description literal not asserted in tests), m8 (error-count underflow on partial last batch + 429 abort). Net recommended action: 30-minute fix wave at start of F-009 prep (reuse F-008 implementer per Meta-Pattern), produce the schema migration patch + ALTER for Ovidiu to apply, add the TODO markers, then proceed to F-011 + F-009.
