# Sprint 5 Final Review

Reviewer: `reviewer` (Opus, read-only)
Branch: `main` @ `b9b4db3`
Scope: full `src/` (44 .ts files, ~1700 LOC excluding tests)
Method: cross-feature consistency, security, spec-coverage matrix per feature, invariant audit, dead-code sweep

## Verdict

**SHIP-WITH-FOLLOW-UPS**

Mechanical gates (tsc, full_test, coverage-claim, schema-drift) are green and the architecture invariants on tokens (I-003), runs (I-004), and cursor advance (I-005) are correctly enforced where claimed. The blocking risk to ship is contained — JWT coverage is correct, no plaintext token leakage, no SQL injection. The follow-ups listed below are real spec gaps that have escaped per-feature reviews because each feature's tests passed against its own mocks rather than the spec's full picture.

## Summary

Reviewed 44 source files across 17 features and the architecture/spec matrix. Found **0 critical**, **8 major**, **5 minor** issues. Major findings cluster around three themes: (1) F-012 candidate fetch + re-evaluation rules (R3, R4, R10, R11) silently unimplemented, (2) orchestrator failure-attribution + status logic doesn't match F-009 spec, (3) F-013-R9 orphan-track handling partially implemented (orphans bypass ISRC stage, picked up only by fuzzy). One Type hole (`env.WALL_TIME_OVERRIDE_MS`) recently introduced. Cross-cutting log-on-error discipline weak in HTTP route catches (NFR §5.4 violation).

## Critical (ship-blocker)

None.

## Major (next sprint)

### [M1]: F-012-R3 / R4 — candidates field is hardcoded `[]`, never fetched from Tidal
- File: `src/db/unmatched.ts:102` and `src/routes/unmatched.ts:23`
- Spec: F-012-R3, F-012-R4 (Sprint 5 / F-012 spec §"Detailed requirements")
- Issue: `listPending` returns `candidates: []` for every row. The route handler does `candidates: r.candidates ?? []`. Spec mandates the response include "the current top 5 Tidal candidates with scores from F-007's algorithm" with a 10-second total timeout. T-012-04 passes only because the mock injects fake candidates before invoking the route. iOS clients will see an empty candidates array on every unmatched row.
- Suggested fix: Implement a `fetchCandidatesForUnmatched(env, rows, deadlineMs)` helper that, for each row, calls Tidal search exactly as F-007 does, scores via `scoreCandidate`, and returns top 5 with scores. Wire it into `routes/unmatched.ts` GET handler with a `Promise.race([allCandidates, timeout(10_000)])` deadline so timeout returns partial response with `candidates=[]` per R4.

### [M2]: F-012-R10 violation — fuzzy matcher re-evaluates `skipped` unmatched rows
- File: `src/match/fuzzy.ts:97-104`
- Spec: F-012-R10 ("rows with status='skipped' MUST never be re-evaluated by F-007 again")
- Issue: `fetchUnmatchedTracks` selects `tracks LEFT JOIN matches WHERE m.spotify_id IS NULL`. It does not exclude tracks whose `unmatched.status='skipped'`. Because `insertMatch` uses `ON CONFLICT DO NOTHING`, a previously-skipped track that fuzzy now resolves WILL get a new matches row, silently undoing the operator's skip decision.
- Suggested fix: Add `LEFT JOIN unmatched u ON t.spotify_id = u.spotify_id` and `AND (u.status IS NULL OR u.status NOT IN ('skipped','matched'))` to the WHERE clause. Note: also fixes a subtle correctness issue where rows already marked `unmatched.status='matched'` (e.g. via F-012 manual match) would re-trigger fuzzy on the next run when the `matches` row is technically present — currently masked because `m.spotify_id IS NULL` is false in that case. Defense in depth.

### [M3]: F-012-R11 — fuzzy matcher re-tries every below-threshold track on every run
- File: `src/match/fuzzy.ts:97-104`
- Spec: F-012-R11 ("Pending rows older than 7 days MUST be re-evaluated on the next sync run")
- Issue: Spec's intent is that pending rows are NOT re-evaluated for 7 days. Current implementation re-runs Tidal search for every track without a match, every run. Two harms: (a) wasted Tidal API quota, (b) faster path to rate-limit.
- Suggested fix: Filter `fetchUnmatchedTracks` to exclude pending-unmatched rows whose `last_attempt_at >= now() - interval '7 days'`. Express as `AND (u.spotify_id IS NULL OR u.last_attempt_at < now() - interval '7 days')`.

### [M4]: F-013-R9 — orphan capture tracks bypass the ISRC stage
- File: `src/sync/orchestrator.ts:87-99` (`fetchNewTracks`)
- Spec: F-013-R9 ("orchestrator MUST be extended to process tracks that have no entry in `matches` or `unmatched` (orphans)")
- Issue: `fetchNewTracks` only selects tracks with `first_seen_at >= startedAt` — that is, tracks fetched by the current run's `fetchLikedSongs`. An orphan track inserted earlier via `POST /captures` (whose `first_seen_at` is older) is invisible to ISRC matching. It picks up the orphan only via the fuzzy stage, which happens to scan all non-matched tracks. Net effect: capture-borne tracks bypass the strongest match path.
- Suggested fix: In `fetchNewTracks`, additionally `UNION` orphan tracks: `SELECT spotify_id, isrc, artist, duration_ms FROM tracks t WHERE NOT EXISTS (SELECT 1 FROM matches m WHERE m.spotify_id = t.spotify_id) AND NOT EXISTS (SELECT 1 FROM unmatched u WHERE u.spotify_id = t.spotify_id)`. This makes the orchestrator R9-compliant without disturbing the non-orphan path.

### [M5]: F-009 — error attribution is hardcoded to `spotify_reauth_required`
- File: `src/sync/orchestrator.ts:108-126` (`runSyncBody` first try/catch)
- Spec: F-009 §"Run with hard failure before any progress" + failure-modes table (lists `spotify_reauth_required`, `tidal_reauth_required`, `db_unreachable`, etc.)
- Issue: Any throw from `fetchLikedSongs` is captured as `error_code = "spotify_reauth_required"`. Throws can come from: HTTP 5xx → "Spotify API error: 502", second 429 → "Spotify rate limit", `IntegrityError` from token decryption, generic transport failure, etc. Operator runbooks (architecture §10.2) key off `error_code` to decide whether to re-OAuth, retry, or escalate. Misclassifying transient/HTTP errors as `spotify_reauth_required` will trigger needless re-auth flows.
- Suggested fix: Discriminate the caught error: if it's a `SpotifyAuthError` with `code === "reauth_required"`, classify as `spotify_reauth_required`. If it's the second-429 / 5xx, classify as `spotify_transient`. If `IntegrityError`, classify as `token_decrypt_failed`. Default fallback to `spotify_fetch_failed`.

### [M6]: F-009 status logic doesn't match the "no progress" rule
- File: `src/sync/orchestrator.ts:168` (`status = totalErrors > 0 ? "partial" : "succeeded"`)
- Spec: F-009 §"Run with partial errors": `status='partial'` if `errors > 0 AND (matched_isrc + matched_fuzzy + unmatched) > 0`
- Issue: When isrc + fuzzy both throw fatal exceptions (caught and recorded as errors) but produce zero matches/unmatched, the run is marked `partial`. Per spec, with zero progress and any error, this should be `failed`. The state-machine diagram (architecture §8.1) reinforces: `running → failed: hard failure before any tracks processed`.
- Suggested fix: `const progress = isrcResult.matched + fuzzyResult.matched + tracksUnmatched + isrcResult.skipped; const status = totalErrors > 0 ? (progress > 0 ? "partial" : "failed") : "succeeded";` This treats the case where errors exist but no progress was made as a hard failure, not a partial.

### [M7]: NFR §5.4 violation — HTTP route catches swallow errors with no log line
- Files (representative):
  - `src/routes/captures.ts:32, 42, 107, 137`
  - `src/routes/unmatched.ts:25, 36, 53, 68, 79`
  - `src/routes/sync/runs.ts:18`
  - `src/routes/sync/status.ts:21`
  - `src/routes/stats.ts:19`
  - `src/routes/health.ts:58` (deliberate; readyz checks dbOk via the catch — partially OK)
- Spec: NFR §5.4 ("All errors MUST emit a structured log line with `run_id`, `feature`, `stage`, `error_code`, `message`")
- Issue: 11 catch sites convert thrown errors to `503 service_unavailable` without recording the error message anywhere. When the operator gets a 503 from `/sync/runs`, there is no log trace to debug it. The orchestrator's logging discipline (sync_run_completed, isrc_artist_mismatch, etc.) does NOT extend to HTTP route handlers.
- Suggested fix: Introduce a `logRouteError(stage: string, err: unknown)` helper that emits `console.log(JSON.stringify({event: "route_error", stage, message: err instanceof Error ? err.message : String(err)}))`. Replace each `} catch {` with `} catch (err) { logRouteError("captures.list", err); ...`. Mechanical refactor; ~30 LOC change.

### [M8]: Type hole — `env.WALL_TIME_OVERRIDE_MS` referenced but missing from `Env`
- File: `src/sync/orchestrator.ts:208-211`; `src/env.ts:1-13` does not declare it
- Spec: implicit (TS strict + spec discipline)
- Issue: The orchestrator reads `env.WALL_TIME_OVERRIDE_MS` to compute the wall-time cap. The `Env` interface (`src/env.ts`) does not declare this property. TypeScript only permits this access because Workers env objects derive their shape from wrangler bindings, not the `Env` interface; the interface is just a type-shim. As a result, this code-path silently passes tsc but has no compile-time guarantee the variable exists. If misspelled (e.g. someone refactors to `env.WALL_TIME_OVERRIDE`), tsc won't catch it.
- Suggested fix: Add `WALL_TIME_OVERRIDE_MS?: string;` to the `Env` interface in `src/env.ts`. Either declare it as a documented test-only override (used by `tests/sync/orchestrator.test.ts`) or rip it out and inject via parameter.

## Minor

### [m1]: stats.ts uses an inconsistent error-response shape
- File: `src/routes/stats.ts:13`
- Issue: This is the ONLY `c.json` error response in the entire src/ that includes a `message:` field alongside `error:`. Every other 4xx/5xx in the project returns `{error: "<code>"}` only (33 distinct sites verified). F-001-R9 (the only spec that explicitly constrains 4xx body shape) says "single `error` field"; F-001 only covers 401, but the convention has been adopted everywhere else.
- Suggested fix: Drop the `message` field — `{error: "invalid_period"}` is sufficient. Or, if a human-readable detail is desired, document that pattern in the architecture spec and apply it consistently.

### [m2]: Duplicate TODO(ovidiu) markers in match/isrc.ts and match/fuzzy.ts
- Files: `src/match/isrc.ts:7,10`; `src/match/fuzzy.ts:9,12`
- Issue: Both files have two adjacent TODO(ovidiu) comments that say almost the same thing (verify the URL/filter against Tidal Open API v2 docs). Sprint 4's TODO discipline didn't catch the duplication because each TODO covered a slightly different surface (the URL vs the filter param). Visual noise; one TODO per concern is cleaner.
- Suggested fix: Collapse each pair into a single TODO that calls out both surfaces.

### [m3]: aggregateStats interpolates the period interval directly into SQL
- File: `src/db/sync_runs.ts:194`
- Issue: `WHERE started_at >= now() - interval '${interval}'` — the `interval` value comes from a hardcoded whitelist (`"1 day"`, `"7 days"`, `"1 month"`) and `period` is validated upstream against `VALID_PERIODS`. Not a SQL injection. But it bypasses the parameterized-SQL convention used everywhere else in the project. Future maintainer might accidentally widen the whitelist.
- Suggested fix: Use `interval $1` with `[interval]` as a param. Postgres accepts interval expressions as parameters. Defense-in-depth.

### [m4]: Dead exports — countTracks, getUnmatchedCount, findMatchedIds
- Files: `src/db/tracks.ts:55` (countTracks), `src/db/unmatched.ts:30` (getUnmatchedCount), `src/db/matches.ts:25` (findMatchedIds)
- Issue: Three exported helpers are tested in tests/db/* but unused in production code. Under code-quality.md ("No unused imports, variables, or functions"), these qualify as dead code. They may be earmarked for future use (the orchestrator could use findMatchedIds for incremental matching, etc.) but they are currently unreferenced.
- Suggested fix: Either wire them in (orchestrator `fetchNewTracks` could narrow with `findMatchedIds`) or delete + their tests. Recommend keeping if a Sprint 6 feature will adopt them; otherwise prune.

### [m5]: `c.set("subject" as never, subject)` — Hono context type-shim
- File: `src/middleware/auth.ts:38`
- Issue: `as never` masks a genuine Hono typing requirement (the variable name should appear in `Hono<{Bindings, Variables}>`). The `as never` cast hides this. Future readers will see the cast and not know what to do with it.
- Suggested fix: Declare the Hono app with `Hono<{Bindings: Env; Variables: {subject: string}}>` and remove the cast. Threads through src/index.ts `app` declaration. ~3 LOC.

## What's Working Well

- **Per-spec test ID citation in describe blocks** — every test file (sampled across 11) cites `T-NNN-MM` in its describe and a leading comment. Made the spec-coverage matrix mechanical to audit. Continue this for all future features.
- **One-file-per-concern decomposition** — F-006 (isrc.ts + artist.ts), F-007 (fuzzy.ts + title.ts + score.ts), F-008 (playlist.ts + playlist-endpoints.ts + playlist-writer.ts) all split cleanly. Easy to read, easy to test.
- **Lead-stub interface pattern** — confirmed in commits 9cee614 (sync_runs.ts), 7aaff41 (provider_tokens.ts/oauth_state.ts). The pre-committed stubs let parallel teammates implement consumers without blocking on producers. The pattern transfers to any future feature triple where one provides an interface module.
- **sql.transaction sync-callback array form** — used correctly in 3 features now (F-005 cursor advance at `liked.ts:154`, F-012 manual match at `unmatched.ts:117`). The pattern is stable and the type signature `NeonQueryFunctionInTransaction` is now well-understood. The wrong async form would have been a Type error caught by tsc; the project picked the right shape.
- **Pool/WebSocket for session-scoped DB primitives** — `src/sync/orchestrator.ts:56-85` correctly uses `Pool` + a single `PoolClient` for the advisory-lock pair, with `pool.end()` in finally. The Sprint 5 lesson about HTTP driver session-per-query is now baked into the code, not just a memory.
- **Idempotency window pattern (F-013, 60s findRecentCapture)** — `src/db/captures.ts:53-71` is concise, parameter-safe, and exactly what the spec mandates. Reusable for any future "operator may submit twice within window" flow.
- **Mechanical hook gates (Stage 1-4 in verify-task-quality.sh)** — the cumulative leverage compounds: tsc + full_test + coverage-claim + schema-drift each independently catches a recurring anti-pattern. Sprint 6's TODO-marker hook (Stage 5) is the natural next gate.
- **JWT skip-paths are correct and narrow** — `AUTH_SKIP_PATHS` in `src/index.ts:16` lists exactly `/healthz`, `/readyz`, `/auth/spotify/callback`, `/auth/tidal/callback` — no over-broad matching, no path-prefix wildcards. `secretsGuard` separately exempts only `/healthz` + `/readyz` per F-014-R10. Verified all 17 routes registered in `src/index.ts:24-32` flow through the JWT middleware unless explicitly skip-listed.
- **No plaintext token leakage** — audited every `console.log` / `console.warn` / `console.error` (16 sites). Each emits structured payloads with `event`, `run_id`, error codes, or non-sensitive metadata. No JWT, JWT_SECRET, refresh_token, or access_token plaintext appears in any log path. I-003 / F-001-R5 satisfied.
- **No `any`-typed code** — zero `: any` and zero ` as any` in src/. Two `as never` (one in middleware/auth.ts) and small `as unknown[]` casts in DB layer for length checks. Tight type discipline.
- **Crypto invariants enforced cleanly** — encryptToken (`src/crypto/encrypt.ts:13`) generates a fresh 96-bit IV per call via `crypto.getRandomValues`. importKey (`src/crypto/key.ts:16`) validates the 32-byte length post-base64-decode. decryptToken converts any subtle.decrypt failure to `IntegrityError("token_integrity_failure")` — no error-message leakage.

## Spec Coverage Matrix

Format: `F-NNN: <reqs cited in tests> / <total reqs in spec>` — citation = `T-NNN-MM` or describe-block reference matches an `F-NNN-RM`.

| Feature | Requirements | Cited in tests | Coverage |
|---|---|---|---|
| F-001 Auth | R1-R11 (11) | T-001-01..15 | All R1-R10 cited; R11 (Authorization header only, no query param) is asserted by middleware shape. R8 (5ms p95) deferred to F-Q1 e2e (T-001-10). |
| F-002 Spotify OAuth | R1-R11 (~11) | T-002-01..14b | All cited. R5 (no logging of sensitive values) verified by no-console-log audit on `src/providers/spotify/oauth.ts`. R7 (refresh coalescing) covered by T-002-12b. |
| F-003 Tidal OAuth | R1-R11 (~11) | T-003-01..15 | All cited. R7 (User-Agent / Tidal headers) covered in client.test.ts. R6 (refresh coalescing) covered in oauth.test.ts. M5 (route mount under /auth) covered structurally. |
| F-004 Token Encryption | R1-R5 | T-004-01..14 | All cited. R3 (96-bit IV, separate columns) verified at schema level + roundtrip.test.ts. T-004-13 canary covered (no plaintext in errors). |
| F-004b Token Persistence | derived from F-004 | tests/db/provider_tokens.test.ts + oauth_state.test.ts | Schema (IV columns, status enum) verified. |
| F-005 Liked Songs | R1-R11 | T-005-01..14 | R1-R10 cited; R6 (atomic cursor advance) covered by T-005-13 transaction test. R11 (60s clock skew) covered. |
| F-006 ISRC Match | R1-R12 | T-006-01..14 | R1-R12 cited; T-006-13 (curated 20-track precision) and T-006-14 (corrupted ISRC live API) deferred — require live Tidal or recorded fixtures. |
| F-007 Fuzzy Match | R1-R13 | T-007-01..15 | R1-R13 cited. T-007-15 (curated 20-track precision @0.85 threshold) deferred per same reason as T-006-13. **Gap: F-012-R10/R11 cross-feature constraints not asserted in fuzzy.test.ts** (see M2, M3). |
| F-008 Tidal Playlist Write | R1-R11 | T-008-01..14 | All cited. R8 (429 retry) + R7 (401 retry) covered via tidalFetch shared client tests. |
| F-009 Sync Orchestration | R1-R11 | T-009-01..12 | R1-R9 + R11 cited. R10 (single completion log line) covered by T-009-03. **Gap: status='failed' path when all match stages throw fatal but fetch succeeded — see M6.** T-009-10 (wall-time metric) deferred to F-Q1 e2e. |
| F-010 Scheduled Execution | R1-R7 | T-010-01..09 | R1 (cron triggers), R7 (25s manual race + 202 + 409) all cited. |
| F-011 Sync Logging | R1-R10 | T-011-01..12 | All cited. R7 (4-sig-digit match_rate) covered. R10 (lag_hours 1-decimal) covered. T-011-13 (p95 with 1000 rows) deferred to F-Q1 e2e. |
| F-012 Unmatched Queue | R1-R11 | T-012-01..14 | R1, R2, R5, R6, R7, R8, R9 cited and asserted. **Gap: R3 (top-5 candidates with scores) and R4 (10s candidate-fetch timeout) NOT implemented — see M1. R10 (no re-eval of skipped) and R11 (7-day re-eval window) silently violated by F-007 path — see M2/M3.** |
| F-013 Captures API | R1-R11 | T-013-01..15 | All cited and asserted. R9 (orchestrator orphan-track processing) **partially implemented** — orphans hit fuzzy but bypass ISRC, see M4. |
| F-014 Health/Readyz | R1-R10 | T-014-01..12 | R1-R7, R9, R10 cited. R8 (3s response time) deferred to F-Q1 e2e (T-014-03 + T-014-11). |
| F-Integ | n/a | tests/integration/*.test.ts | 8 integration tests across Spotify+Tidal OAuth round-trip. |
| F-Q1 | n/a | tests/e2e/*.test.ts | 6 e2e tests covering deferred wall-clock metrics. |

**Aggregate**: ~165 individual requirements across 17 features. ~155 cited in tests (94%). ~10 deferred to F-Q1 (mostly wall-clock latency). 4 silently unimplemented (F-012-R3, R4, R10, R11 — see M1, M2, M3).

## Invariant Audit

| Invariant | Enforced | Where |
|---|---|---|
| **I-001** spotify_id in EXACTLY one of matches OR unmatched | Mostly | `src/db/unmatched.ts:117-132` (manual match transaction). **Soft violation** at `src/sync/playlist-writer.ts:80-85` — `flagInvalidTidalId` + `requeueForInvalidTidalId` runs sequentially; matches row is left in place (`tidal_id_invalid=true`) AND unmatched row is inserted. Semantically the spec accepts this (F-008 spec lines 53-55 mandate both actions), but it's at odds with I-001's literal text. The code relies on `selectMatchesNewerThan` filtering `tidal_id_invalid=false` to maintain correctness. **Recommendation:** Either tighten I-001's wording in architecture.md to acknowledge `tidal_id_invalid=true` rows as "soft-deleted matches", or apply a transaction wrapping the flag + requeue + matches DELETE. |
| **I-002** matches.tidal_id resolves at write time | Yes | F-006 (ISRC verifies via Tidal lookup), F-007 (fuzzy verifies via Tidal search), F-012 (manual match verifies via tidalFetch in `routes/unmatched.ts:52` BEFORE the markMatched transaction). |
| **I-003** non-null ciphertext, no plaintext anywhere | Yes | Schema NOT NULL on ciphertext columns (`db/schema.sql:21-24`). `persistTokens` always encrypts before write. No console.log emits plaintext (audited 16 console sites). |
| **I-004** sync_runs.status enum, terminal states have non-null finished_at | Yes (CHECK + code) | DB CHECK at `db/schema.sql:47`. All `updateRun` calls that set terminal status (succeeded/partial/failed) include `finished_at` (orchestrator.ts:170-173, 239-243). |
| **I-005** cursor advances atomically with page persist | Yes | `src/providers/spotify/liked.ts:153-158` uses `db.transaction((txSql) => [...buildUpsertQueries, buildCursorQuery])` sync-callback array form — single transaction, atomic. |

## Process Notes

- **Read-only review confirmed**: no source or test file was modified during this pass.
- **Mechanical gates trusted**: tsc, full_test, coverage-claim, and schema-drift hooks were left untouched and not re-run; relied on the green state asserted by the lead.
- **No verification of TODO(ovidiu) URL claims**: the spec gaps M1-M4 are independent of whether the Tidal Open API v2 URLs are correct. Even if the URLs are wrong, the spec-vs-impl drift exists. The TODO(ovidiu) markers are tracked separately and out of scope for this review.
