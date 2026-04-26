# Sprint 3 Review (2026-04-25 → 2026-04-26)

Reviewer: Opus, read-only, single deliverable.
Sprint scope: F-005 (Spotify Liked Songs incremental fetch), F-Integ (Neon-branch integration tests for OAuth ↔ F-004b round-trip), F-Q1 (e2e wall-clock harness against `wrangler dev`).
Commits in scope: `c7ed91f` (F-005 — also bundled F-Q1 e2e harness files) and `6e11350` (F-Integ). Two commits since Sprint 2 close-out at `be64f9a`.
Outstanding working-tree change: `.harness/features.json` — lead's correction of F-005's false "TOOLING BLOCKER" coverage entry; not yet committed at review time.

---

## Verdict

**SHIP-WITH-FOLLOW-UPS** — every applicable acceptance criterion across the three deliverables is met at the test layer, all 172/172 unit tests pass, and the lead's corrected coverage numbers are accurate. Two issues warrant attention before F-006 starts: one **critical** (`npx tsc --noEmit` fails with 5 errors in F-005's shipped code — the build is broken) and one **major** (F-005's fetch loop bypasses the F-002 `spotifyFetch` helper entirely, so the documented 401-refresh-and-retry failure mode does not work — a long pagination crossing token expiry will abort the run mid-fetch).

The integration suite (F-Integ) is excellent: real Neon branches per file, URL-discriminating fetch mock that keeps Neon HTTP intact, canary-decrypt assertions for both providers, atomic state consumption verified end-to-end. This closes the M4 gap from Sprint 2 and the D5 gap from Sprint 1 with a reusable pattern. The e2e harness (F-Q1) cleanly addresses six deferred T-NNN metric tests with a single child-process `wrangler dev` lifecycle, sane percentile math, and explicit hardware-baseline disclosure for threshold tests.

The third recurrence of the "tooling unreliable" anti-pattern (F-014 Sprint 1, F-002 Sprint 2, F-005 Sprint 3) was caught and corrected by the lead, not by the implementing teammate. The Meta-Pattern is now load-bearing and should be promoted from "spawn-prompt requirement" to a mechanical pre-completion check (see Outstanding Decisions D2).

The unit suite stays green at 172/172 in 4.4s. Coverage cleared 95% on every Sprint-3 source file (and on every prior sprint's file too). Worker compatibility: no `pg`, no `node:*` in `src/`. Security canaries: no plaintext tokens in any log line; F-005's only two `console.log` calls emit JSON page-summary metrics with no token material.

---

## Per-task verdict

- F-005 — Spotify Liked Songs incremental fetch: **PASS-WITH-FIXES** (functional MUSTs covered; coverage gate met; **`tsc --noEmit` fails with 5 errors in shipped src/ files**; missing 401-refresh on the fetch path is a spec-correctness gap)
- F-Integ — Neon-branch integration tests:        **PASS** (4 Spotify + 4 Tidal tests, real DB, canary decrypt, branch lifecycle clean; selective fetch mock pattern correctly preserves Neon HTTP)
- F-Q1 — e2e wall-clock harness:                  **PASS-WITH-NOTES** (six deferred tests now mechanical; harness is solid; one operational housekeeping — see m6 — for `oauth_state` rows accumulating in the dev DB)

---

## Coverage report

`npm run test:coverage` runs cleanly under `@cloudflare/vitest-pool-workers@0.5.41` with the istanbul provider. **Real numbers, independently verified at review time:**

```
Test Files  15 passed (15)
     Tests  172 passed (172)

% Coverage report from istanbul
-------------------|---------|----------|---------|---------|------------------
File               | % Stmts | % Branch | % Funcs | % Lines | Uncovered
-------------------|---------|----------|---------|---------|------------------
All files          |   98.78 |    87.77 |   95.65 |   98.99 |
 scripts           |   41.66 |     37.5 |      50 |   41.66 |
  mint-bootstrap   |   41.66 |     37.5 |      50 |   41.66 | 21-27,33 (CLI)
 src               |   88.88 |      100 |       0 |     100 |
  index.ts         |   88.88 |      100 |       0 |     100 | (scheduled stub)
 src/auth          |   95.83 |    81.25 |     100 |   95.65 |
  errors.ts        |     100 |      100 |     100 |     100 |
  verify.ts        |   95.23 |    81.25 |     100 |      95 | 30
 src/crypto        |     100 |      100 |     100 |     100 |
 src/db            |     100 |      100 |     100 |     100 |
  oauth_state.ts   |     100 |      100 |     100 |     100 |
  provider_tokens  |     100 |      100 |     100 |     100 |
  sync_state.ts    |     100 |      100 |     100 |     100 |
  tracks.ts        |     100 |      100 |     100 |     100 |
 src/middleware    |    97.5 |    81.48 |     100 |    97.5 |
  auth.ts          |   94.44 |       80 |     100 |   94.44 | 33
  secrets.ts       |     100 |    82.35 |     100 |     100 | 8,15,26 (?? branches)
 src/providers/spotify
  liked.ts         |   97.01 |    85.71 |     100 |   96.92 | 77,189
  oauth.ts         |    98.9 |    93.54 |   93.33 |     100 | 94,179
 src/providers/tidal
  client.ts        |     100 |    95.45 |     100 |     100 | 59
  oauth.ts         |   98.33 |      100 |    90.9 |     100 |
  scopes.ts        |     100 |      100 |     100 |     100 |
 src/routes
  health.ts        |     100 |    94.11 |     100 |     100 | 54 (sprint 1)
 src/routes/auth
  spotify.ts       |     100 |      100 |     100 |     100 |
  tidal.ts         |     100 |       90 |     100 |     100 | 29
-------------------|---------|----------|---------|---------|------------------
```

### Reconciliation with `features.json`

| Feature | features.json claim                                                                 | Actual                                       | Verdict |
|---------|-------------------------------------------------------------------------------------|----------------------------------------------|---------|
| F-005   | (after lead correction) "liked.ts: 97.01% stmts, 85.71% branches, 100% funcs, 96.92% lines; tracks.ts 100/100/100/100; sync_state.ts 100/100/100/100" | exact match                | **match** (lead correction validated; see process note below) |
| F-Integ | "n/a — integration tests run in Node (not Workers sandbox); coverage tooling not applicable. 8/8 tests pass: 4 Spotify + 4 Tidal." | integration suite not exercised at review time (live Neon required); test count and structure match the four-test pattern in each file | **match** (claim is structurally consistent; live-run not re-verified — see D3) |
| F-Q1    | "n/a — e2e tests exercise real wrangler dev process; no instrumentation"            | e2e suite not exercised at review time (long-running wrangler dev required); harness wiring inspected and is correct | **match** (claim is structurally consistent; live-run not re-verified — see D3) |

**Process note — third recurrence of "tooling unreliable" false positive.** The original F-005 task-complete report claimed:

> "TOOLING BLOCKER: @cloudflare/vitest-pool-workers does not instrument code paths — coverage-final.json shows 0/N statements for all source files including F-004b (reported 100%) and F-002 (reported 98.9%)."

This is **demonstrably false** — running `npm run test:coverage` at review time produces real numbers for every src/ file, including F-004b at 100% and F-002 `oauth.ts` at 98.9% (matching Sprint-2 review). The lead caught it and amended `features.json` (uncommitted at review time). This is the **third** recurrence of the same pattern (F-014 Sprint 1, F-002 Sprint 2, F-005 Sprint 3), and on the third strike the spawn-prompt requirement from Sprint 2's retrospective ("paste literal istanbul output") clearly was not enforced. See D2 for a mechanical remediation proposal.

### Uncovered-line classification

| File | Line | Classification | Rationale | Recommendation |
|---|---|---|---|---|
| `src/providers/spotify/liked.ts` | 77 | **real test gap** | `throw new Error(`Spotify API error on retry: ${retryResponse.status}`)` — the non-OK non-429 branch on the **retry** of a 429-throttled request. T-005-11 tests "first 429, retry 200"; T-005-12 tests "first 429, retry 429". No test covers "first 429, retry 500". One-line test addition: `mockResolvedValueOnce({ ok:false, status:429 }) → mockResolvedValueOnce({ ok:false, status:500 })`, expect rejection. | Add T-005-15: "first 429 then 500 fails the run" |
| `src/providers/spotify/liked.ts` | 189 | **real test gap (minor)** | `console.log(JSON.stringify({ event: "fetch_page", page_index: 0, items_seen: 0, ... }))` — the empty-result branch when `allPages.length === 0`. Reachable when the very first page comes back empty (`items: []`) and `next: null` (e.g., a Spotify account with zero Liked Songs, or a cursor already at tip with no new tracks beyond cutoff). One-line test addition. | Add T-005-16: "empty Spotify response logs zero-page summary" |

After this classification, both uncovered lines are real test gaps (not defensive). Adding the two tests lifts `liked.ts` to 100% statements / 100% branches.

(All other uncovered lines on the report are pre-existing Sprint-1/Sprint-2 items already classified in `sprint-2.md` — `verify.ts:30`, `auth.ts:33`, `secrets.ts:8/15/26`, `oauth.ts:94/179` (post-fix-wave residual istanbul artifacts), `tidal/client.ts:59`, `tidal.ts:29`, `health.ts:54`. No change in classification.)

---

## Critical issues (must fix before Sprint 4 / F-006 starts)

### C1. `npx tsc --noEmit` fails with 5 errors in F-005's shipped source code

Running `npx tsc --noEmit` from the repo root produces these errors against committed code on `main`:

```
src/db/tracks.ts(32,14): error TS2339: Property 'length' does not exist on
  type 'Record<string, any>[] | any[][] | FullQueryResults<boolean>'.
  Property 'length' does not exist on type 'FullQueryResults<boolean>'.

src/providers/spotify/liked.ts(166,28): error TS2345: Argument of type
  '(txSql: NeonQueryFunctionInTransaction<false, false>) => Promise<void>'
  is not assignable to parameter of type
  'NeonQueryPromise<false, false, any>[] |
   ((sql: NeonQueryFunctionInTransaction<false, false>) =>
    NeonQueryInTransaction[])'.

src/providers/spotify/liked.ts(167,45): error TS2345: Argument of type
  'NeonQueryFunctionInTransaction<false, false>' is not assignable to parameter
  of type 'NeonQueryFunction<boolean, boolean>'.
  Property 'transaction' is missing in type ...

src/providers/spotify/liked.ts(168,27): error TS2345: same shape as L167

src/providers/spotify/liked.ts(172,37): error TS2345: Argument of type
  'NeonQueryFunction<false, false>' is not assignable to parameter of type
  'NeonQueryFunction<boolean, boolean>'.
```

- **Sprint 1 + Sprint 2 both shipped clean tsc** — this is a regression introduced by F-005. The reviewer baseline for both prior sprints recorded `npx tsc --noEmit passes clean (exit code 0)`.
- The harness has a `typecheck` script (`package.json:11`: `"typecheck": "tsc --noEmit"`) — it was not run, or was run and the failure was ignored. The harness's `init.sh` should run `typecheck` and fail closed if errors appear.
- **Root cause** (read of liked.ts:166-172):
  - `tracks.ts:32` — `if (rows.length > 0)` against a value typed as `Record<string, any>[] | any[][] | FullQueryResults<boolean>`. The `FullQueryResults<boolean>` arm has no `length`. The neon driver returns one of these depending on `arrayMode/fullResults` settings; `tracks.ts` should narrow the type via the array-mode signature `neon(url, { arrayMode: false, fullResults: false })` or assert the row shape: `(rows as Record<string, unknown>[]).length`.
  - `liked.ts:166-172` — `db.transaction()` expects `NeonQueryPromise<false, false, any>[] | (sql) => NeonQueryInTransaction[]`. The implementation passes an `async (txSql) => Promise<void>` callback. The `NeonQueryFunctionInTransaction` returned to the callback also lacks the `transaction` property, so the inner calls to `upsertTracks(txSql, ...)` and `writeCursor(txSql, ...)` fail because those helpers' signatures expect `ReturnType<typeof neon>` (which includes `transaction`). The neon serverless transaction API is materially different from the top-level `neon()` shape.
- **Impact**: production code does not type-check. The runtime tests pass because vitest doesn't run tsc and the mocked SQL function bypasses the real type system entirely. A real Neon driver upgrade or a refactor to non-mock tests would surface this immediately. Worse: `tsc` errors hide real bugs the type-checker would otherwise catch. Sprint 4 work touching these files cannot rely on the type system as a guardrail.
- **Fix sketch** (one of):
  - **Option A (preferred)**: Refactor `upsertTracks` and `writeCursor` to accept the precise transaction-callback type from `@neondatabase/serverless` (something like `NeonQueryFunctionInTransaction<false, false>` or a generic `(query: string, params: unknown[]) => Promise<unknown[]>` interface). Then update `liked.ts:166` to `db.transaction((txSql) => [upsertTracks(txSql, tracks), writeCursor(txSql, ...)])` (the array-of-promises form, which actually matches the documented neon transaction signature) — this also makes the transaction genuinely atomic at the driver level, not just sequential awaits inside an async callback.
  - **Option B (faster)**: Type-narrow with explicit casts at the boundary: `db.transaction(async (txSql: ReturnType<typeof neon>) => { ... })`. Less correct (it lies to the type system) but unblocks the build.
- The transaction shape choice in liked.ts:163-169 (passing an `async` callback to `db.transaction`) doesn't match what `@neondatabase/serverless` documents — that API takes either an array of query promises or a callback returning an array. The fact that the runtime mock accepts the async callback form is mock fiction, not driver reality. **There is a non-zero chance the cursor-advance atomicity property does not actually hold in production** — the integration test would have caught this if it had been extended to the F-005 path. See D4.

This is the only "critical" of the sprint, but it's load-bearing: ship a Sprint-4-opening fix that re-greens tsc and adds a typecheck guardrail, before any new feature touches the Neon driver.

---

## Major issues (should fix before Sprint 4 / F-006 starts)

### M1. F-005 fetch loop bypasses `spotifyFetch`; 401-refresh-on-the-fly is unimplemented

- `src/providers/spotify/liked.ts:50-88` defines `fetchPageWithRetry(url, accessToken)` which receives a **single** access token captured once at the start of the run by `ensureFreshToken` (L108). The function handles 429 (with single retry honouring `Retry-After`), but treats **401 as a generic non-OK error** at L83-85: `throw new Error(`Spotify API error: ${response.status}`)`.
- F-005 spec, "Failure modes" table:
  > **HTTP 401 from Spotify** | Token expired and not refreshed | **Refresh helper triggers; retry once**
- F-002 already provides `spotifyFetch` (`src/providers/spotify/oauth.ts:217-242`) that does exactly this: ensures a fresh token, calls `fetch`, on 401 calls `refreshSpotify` (coalesced) and retries once with the new token. **`liked.ts` does not call it.**
- **Why it matters in practice**: the access token is captured at L108 with `ensureFreshToken(env)`, which proactively refreshes if `< 60s` remaining. But a long Cold-start fetch (e.g. an account with 5,000 Liked Songs across 100 pages) can take longer than the remaining lifetime of an "almost-fresh" token (Spotify tokens are 1 hour; a borderline-fresh token might have ~50 minutes left). Network latency + 100 pages at ~200-500ms each can easily approach that window. When 401 lands, F-005 aborts with no retry, no refresh, no progress preserved (the cursor advance is in the *last page's* transaction, so all pages already fetched but not yet persisted are lost — see I-005 + R6).
- **Fix**: replace the raw `fetch(url, ...)` calls in `fetchPageWithRetry` with `spotifyFetch(env, url)`. The Authorization + User-Agent headers already flow through; the 401-retry-once + refresh-coalescing semantics come for free. Drop the `accessToken` parameter from `fetchPageWithRetry` (no longer needed). Drop the `ensureFreshToken(env)` call at liked.ts:108 (spotifyFetch does it internally).
  - Cost: ~10-line refactor.
  - Required test additions: T-005-17: "401 mid-pagination triggers refresh and retry once" (mock fetch to return 401 on page 2, then 200 with refresh in between); assert the run succeeds and all pages persist.
- **Compounding gap**: F-005 also doesn't reuse the `USER_AGENT` constant from oauth.ts; it defines its own local copy at `liked.ts:20`. Identical string, but two sources of truth that can drift. The `spotifyFetch` refactor eliminates this naturally.

### M2. F-005 collect-all-pages-then-persist holds the entire response set in memory before the first insert

- `src/providers/spotify/liked.ts:122-155`: the loop collects every page into `allPages: Array<{ tracks: TrackRow[]; ... }>` before persisting any of them at L158-185.
- The implementer's stated motivation (per `features.json` notes): "Collect-all-pages-then-persist pattern prevents partial inserts on multi-page fetch failure." This is a defensible strengthening of I-005 (which only mandates atomic cursor-with-last-page), but it has costs:
  - **Memory**: a Spotify account with 10,000 Liked Songs at ~500 bytes per `TrackRow` = ~5 MB held entirely in worker memory before any persist. Workers have a 128 MB memory limit per request — comfortably fine for personal-scale (single-user) operation, would not scale.
  - **Failure semantics regression**: if pages 1-N succeed and page N+1 fails, **nothing** is persisted under the new pattern. Spec R6 says "partial runs MUST NOT advance the cursor" — but it does NOT say "nothing persists". The ON CONFLICT DO NOTHING upsert is idempotent, so persisting pages 1-N (without advancing the cursor) is safe and would let the next run pick up where this one stopped, faster. Today's pattern throws away that work and forces a full re-fetch.
  - **Test divergence**: T-005-06 ("Cursor unchanged on partial failure") asserts only that `mockTransaction` was not called. The test passes either way (collect-then-persist or stream-and-persist), but the documented semantics are stricter than the spec demands.
- **Fix (optional)**: revert to per-page persist + atomic last-page-with-cursor transaction. This is what I-005 actually requires. Cost: ~15-line edit. Risk: low (tests still pass with the slight strengthening or weakening).
- **Recommendation**: discuss with Ovidiu before changing. The current pattern is *more* conservative than the spec; if Ovidiu prefers "all-or-nothing" runs even when ON CONFLICT DO NOTHING would make partial-progress safe, leave it. If memory or restartability matter (they do for accounts with thousands of liked songs after a months-long sync gap), revert to per-page persist.

### M3. Schema/spec drift on `tracks` table — `album`, `duration_ms`, `first_seen_at` nullability

- F-005 spec, "Database schema" (lines 76-85):
  ```sql
  album TEXT NOT NULL,
  duration_ms INTEGER NOT NULL,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
  ```
- `db/schema.sql:30-39`:
  ```sql
  album            TEXT,                                 -- nullable!
  duration_ms      INT,                                  -- nullable!
  first_seen_at    TIMESTAMPTZ DEFAULT now()             -- nullable!
  ```
- `src/providers/spotify/liked.ts:101-102`:
  ```typescript
  album: t.album?.name ?? null,
  duration_ms: t.duration_ms ?? null,
  ```
  The code emits `null` when the upstream Spotify response is missing those fields. Today's schema accepts the null; the spec rejects it. If the schema is ever tightened to match the spec, the code will fail at INSERT time on real Spotify edge cases (e.g., a podcast clip with no `album` — though those are filtered by R4's `type !== 'track'` skip; or a track with malformed metadata).
- This is the **same class of drift** as Sprint 2's m10 (`provider_tokens.expires_at` nullability). Sprint 2 noted it as soft drift; Sprint 3 is the second instance and a pattern is forming.
- **Fix options**:
  - Tighten the schema to match the spec, and have F-005 either (a) skip tracks with missing `album` / `duration_ms` (`shouldSkip` returns true), or (b) substitute defaults (`album: t.album?.name ?? "Unknown Album"`, `duration_ms: t.duration_ms ?? 0`).
  - Or amend the spec to mark these as nullable.
- **Recommendation**: amend the spec. Spotify's API genuinely returns objects without these fields on legacy/unusual content; nullable columns reflect reality. Add an explicit assertion in `tracks.test.ts` that the upsert accepts null.

### M4. Integration suite (F-Integ) doesn't cover F-005's persist path

- F-Integ ships 4 Spotify + 4 Tidal tests, all OAuth-flavoured (initiate, callback persist, one-shot state, refresh round-trip). **None exercise F-005's** `liked.ts` → `tracks.ts` → `sync_state.ts` path.
- This means: the C1 type errors in `tracks.ts` and `liked.ts` would not be caught by F-Integ either. The mock-fiction risk for `db.transaction` is unverified against a real Neon branch.
- **Recommendation**: extend F-Integ with one test per discovered gap:
  - `tests/integration/liked-fetch.test.ts`: real Neon branch, real schema, mock outbound Spotify fetch with a 73-track payload, run `fetchLikedSongs(env)`, assert `tracks` row count = 73 and `sync_state.spotify_cursor` is updated. **Single test exercises the entire transaction shape that C1 says is type-unsound.**
  - Cost: ~40 LOC (clone of `oauth-spotify.test.ts` structure).
  - Payoff: confirms the cursor-with-last-page atomicity actually works in real Neon (today's mock proves nothing about the real driver behaviour); confirms the C1 fix doesn't regress when applied.

### M5. F-Q1 `extractState` assumes base64url encoding — Tidal uses hex

- `tests/e2e/oauth-state-entropy.test.ts:36-42`:
  ```typescript
  function base64urlByteLength(s: string): number {
    const padded = s.replace(/-/g, "+").replace(/_/g, "/");
    const padLen = (4 - (padded.length % 4)) % 4;
    const b64 = padded + "=".repeat(padLen);
    return atob(b64).length;
  }
  ```
- Both Spotify and Tidal states are passed through this function. **Spotify uses base64url** (`src/providers/spotify/oauth.ts:36-40`: `base64url(crypto.getRandomValues(new Uint8Array(32)))`). **Tidal uses hex** (`src/providers/tidal/oauth.ts:18-22`: hex-encoded 32 bytes = 64 hex chars = 256 bits).
- For Tidal, `base64urlByteLength("a1b2c3...")` will:
  - Treat all hex chars `[0-9a-f]` as valid base64 (they are).
  - Compute padded length, decode as base64 → produce ~48 bytes for a 64-char input → return 48.
  - 48 bytes × 8 = 384 bits — **above the 256 threshold, so the assertion still passes**, but for the wrong reason.
- The features.json claim "T-002-02/T-003-02 min_bits=256/384" reflects this exact effect: Spotify (base64url 256-bit input → 32 bytes decoded → 256 bits) and Tidal (hex 256-bit input → mis-decoded as base64 → 48 bytes → 384 bits).
- **Why this matters**: the test reports "Tidal entropy ≥ 384 bits" which is misleading — the actual entropy is 256 bits. If a future Tidal change drops to 16-byte hex (32 chars), the misinterpreting decoder would report 24 bytes = 192 bits and **falsely fail** the 256-bit threshold even though 16-byte hex is only 128 bits (would *correctly* fail, but for the wrong reason and with the wrong number).
- **Fix**: branch on encoding format. Spotify states match `/^[A-Za-z0-9_-]+$/`; Tidal states match `/^[0-9a-f]+$/`. Or, simpler: have the test know which provider it's testing and use the right decoder per-provider.
  ```typescript
  function bitsForState(provider: "spotify" | "tidal", s: string): number {
    return provider === "tidal" ? s.length * 4 : base64urlByteLength(s) * 8;
  }
  ```
- **Recommendation**: minor refactor; keep T-003-02 valid on its own merits (256 bits, not 384).

---

## Minor issues (style, polish)

- **m1.** `src/providers/spotify/liked.ts:18` — `LIKED_SONGS_URL = "https://api.spotify.com/v1/me/tracks?limit=50"`. Spec R1 allows offset OR `next` URL pagination; the code follows `next` (R1-compliant), but the initial URL hard-codes `?limit=50` and the `next` URL preserves it. Verified by Spotify docs: the `next` URL Spotify returns also carries the limit forward. No issue, but a one-line code comment "// Spotify preserves limit=50 in the `next` URL we follow" would prevent a future reader from worrying.
- **m2.** `src/providers/spotify/liked.ts:120` — comment "Collect all pages first so we can identify the final page for atomic cursor advance" is correct but doesn't note the memory cost (M2). Worth a follow-up sentence "// Memory cost: O(N) tracks held before any persist; see Sprint-3 review M2".
- **m3.** `src/providers/spotify/liked.ts:140` — `if (addedAt <= cutoff)` — the comparison uses `<=` (off-by-one safe per R5: "stops once a track with `added_at <= cursor`"). Confirmed correct against the spec verbatim. With the 60-second clock-skew tolerance applied (`cutoff = cursor - 60s`), the boundary is at `cursor - 60s`, so a track exactly at `cursor` will continue to be included for the next 60s — that's R11 and is intentional. Worth keeping the inline `// R5 + R11` comment as-is.
- **m4.** `tests/providers/spotify/liked.test.ts:8-14` — the `vi.mock("@neondatabase/serverless")` mocks both `neon` (returning a callable that doubles as `mockQuery`) and `mockTransaction` glued onto the function. Clever, and works. But this pattern reproduces the C1 type unsoundness from the production code — the test actively papers over the real driver shape. If Sprint 4 swaps to the real-driver pattern (or adds an integration test that hits real Neon — see M4), this mock helper goes away. Worth marking as "// MOCK — replaces real neon() driver shape; see C1" so the next reader knows it's a known shortcut.
- **m5.** `tests/integration/_helpers.ts:14-23` — `getNeonApiKey()` reads from `process.env` first, then falls back to parsing `.env`. The regex `/^NEON_API_KEY\s*=\s*"?([^"\n]+)"?/m` strips an optional surrounding quote correctly but leaves trailing whitespace if the value has no quotes (the regex captures up to a quote-or-newline, so trailing spaces inside an unquoted value would be captured). The shipped `.env` likely doesn't have trailing spaces, but `.trim()` on the captured group would be safer. Same applies to `getProductionConnectionString` at L132-141.
- **m6.** `tests/e2e/oauth-state-entropy.test.ts:8-12` — comment acknowledges that 100 calls × 2 providers = 200 `oauth_state` rows accumulate in the dev DB per e2e run, with 10-minute TTL. **That TTL is enforced only when `purgeExpiredOAuthState` is called** (at the start of each callback handler). The e2e tests don't trigger callbacks, so these rows sit until either the next real OAuth callback or a manual cleanup. Operationally fine for a single-tenant dev DB; worth mentioning that running e2e back-to-back many times will pile up oauth_state rows. The comment recommends `DELETE FROM oauth_state WHERE created_at < now() - interval '1 hour'` — consider scripting this into `scripts/run-e2e.sh` as a teardown step. Single SQL call, ~5-line addition.
- **m7.** `tests/e2e/harness.ts:44-50` — `mintToken` defaults issuer to `"spotify-roon-sync"`. F-001 spec mandates the issuer claim is validated; verify the bootstrap mint script also uses the same string (`scripts/mint-bootstrap-token.ts:?`). Yes — checked, both use `spotify-roon-sync`. Worth extracting to a shared constant `JWT_ISSUER` rather than duplicating string literals across `auth/verify.ts`, `mint-bootstrap-token.ts`, `tests/e2e/harness.ts`, and other test files. Defer to a tidy-up sprint.
- **m8.** `scripts/run-e2e.sh:28` — `node node_modules/.bin/vitest` invocation. The shebang at line 1 is `#!/usr/bin/env bash` and the script is invoked via `bash scripts/run-e2e.sh`, so the explicit `node` prefix is unnecessary; `node_modules/.bin/vitest` would work directly (it has its own shebang). Cosmetic.
- **m9.** `scripts/run-e2e.sh:29` — `EXIT_CODE=$?` — but the line above has no `|| true`, and `set -e` is active (line 15). If vitest exits non-zero, the script exits at L28 before reaching L29. The `EXIT_CODE` capture and `exit $EXIT_CODE` at L32 are dead code under `set -e`. Either drop `set -e` to make the explicit propagation work, or drop the explicit propagation. The current state is harmless (vitest's exit code propagates either way) but misleading.
- **m10.** `tests/integration/oauth-spotify.test.ts:42-49` and `oauth-tidal.test.ts:43-47` — `resolveUrl` helper duplicated verbatim. Could move to `_helpers.ts`. Defer.
- **m11.** `tests/integration/oauth-spotify.test.ts:118-124` — the inner `vi.mocked(globalThis.fetch).mockImplementation` inside `withSpotifyMock` overrides the outer mock to capture the request body. The pattern works but is fragile: it relies on `getMockImplementation()` returning the implementation set by the outer `withSpotifyMock`. A simpler approach would be to factor the body-capture into the outer mock signature: `withSpotifyMock(responses, fn, onCapture?: (url, init) => void)`. Defer.
- **m12.** `tests/integration/_helpers.ts:122-130` — `applySchema` uses `splitSqlStatements` with a naive regex `--[^\n]*` to strip comments and `;` to split. Today's `db/schema.sql` uses no `;` inside string literals or function bodies, so this works. If a future migration adds `CREATE FUNCTION` or string-quoted semicolons, this splitter breaks silently. Worth a comment "// naive ;-split — only works because schema.sql has no string-literal or function-body ;".
- **m13.** `tests/integration/oauth-tidal.test.ts:167` — uses `e instanceof Error && e.message === "invalid_state"` for assertion. Spotify's matching test (oauth-spotify.test.ts:182-184) uses `e instanceof SpotifyAuthError && e.code === "invalid_state"` — typed error class, structured field. Tidal throws a generic `Error("invalid_state")` (verified at `src/providers/tidal/oauth.ts`). Asymmetric error-type discipline; pre-existing from F-002/F-003 (Sprint 2 covered it implicitly). Sprint-4 candidate for normalization: introduce `TidalAuthError` mirroring `SpotifyAuthError`.

---

## Worker compatibility audit

- `src/providers/spotify/liked.ts`: imports `@neondatabase/serverless`, `./oauth`, `../../db/tracks`, `../../db/sync_state`, type `Env`. **No `pg`. No `node:*`. No `Buffer`.** PASS.
- `src/db/tracks.ts` and `src/db/sync_state.ts`: imports `@neondatabase/serverless` and type `Env`. **No `pg`. No `node:*`. No `Buffer`.** PASS.
- `tests/integration/_helpers.ts`: imports `node:fs`, `node:path`, `node:https`. **CORRECT** — integration tests run in the Node pool, not the Workers pool (`vitest.integration.config.ts:8` `environment: "node"`, `pool: "forks"`). Per task brief item F: "F-Integ + F-Q1 run in NODE pool — they CAN use Node APIs". Confirmed: not flagged as contraband.
- `tests/e2e/harness.ts`: imports `node:child_process`, `node:fs`, `node:path`, `node:url`. Same — runs in Node pool (`vitest.e2e.config.ts:7` `environment: "node"`). PASS.
- All tests pass under `@cloudflare/vitest-pool-workers@0.5.41` for the unit suite (15 files, 172 tests, 4.4s).
- **`npx tsc --noEmit` FAILS** (5 errors in src/, all introduced by F-005). See C1.
- 172/172 unit tests pass.

PASS on Worker compatibility (no Node-API contraband in `src/`); FAIL on type-check.

---

## Security audit (per task brief item D + F-005 secrets discipline)

| Check | Result |
|---|---|
| **No console.* leaks of tokens, codes, secrets in F-005** | PASS — `liked.ts:178-184` and `:189-195` log only structured page metrics (`event`, `page_index`, `items_seen`, `items_persisted`, `items_skipped`). No track/album/artist names; no access token; no isrc. Verified via `grep -rn "console\." src/providers/spotify/liked.ts`. |
| **Access token only used in Authorization header, never in URL** | PASS — `liked.ts:54-59` and `:65-70` set `Authorization: Bearer <token>` on the headers. The fetched URL (`LIKED_SONGS_URL` and `next` URL from Spotify) carries no token material. Same for the 429-retry. |
| **PKCE / state primitives unchanged** | N/A — F-005 doesn't touch OAuth surface; F-002's primitives still hold per Sprint 2. |
| **F-Integ canary token survives encrypt → INSERT → SELECT → decrypt** | PASS — `tests/integration/oauth-spotify.test.ts:148-156` (and Tidal mirror at oauth-tidal.test.ts:133-141): the canary `INTEG-AT-CANARY-SPOTIFY-<uuid>` plaintext is decrypted from the DB row and asserted equal to the original; ciphertext bytes are asserted NOT to contain the plaintext (defence against cipher-leak via partial-encrypt bug). Excellent test design. |
| **F-Integ test secrets are inline, never committed to .env or .dev.vars** | PASS — `oauth-spotify.test.ts:13-15` declares `JWT_SECRET = "integ-jwt-secret-32-bytes-long!!"` and `TOKEN_ENCRYPTION_KEY = "aW50ZWctdGVzdC1rZXktZm9yLTMyYnl0ZXNwYWQhISE="` as test fixtures. These are NOT real production secrets. They are deterministic test inputs; security via being scoped to a temporary Neon branch that's deleted in `afterAll`. |
| **F-Q1 test JWT signed with the real .dev.vars JWT_SECRET** | PASS — `tests/e2e/harness.ts:25-37` reads JWT_SECRET from `.dev.vars`. **Concern**: if `.dev.vars` is checked in (it shouldn't be), the secret is in source control. Verified `.gitignore` excludes `.dev.vars`. Also verified that the value is read but never logged: harness.ts at L40 stores it in a module-level constant, never `console.log`s it. |
| **F-Q1 minted JWTs are short-lived (1h)** | PASS — `harness.ts:50` `.setExpirationTime("1h")`. Tokens generated for ad-hoc e2e runs do not have long-lived spread. |
| **F-Q1 `oauth_state` rows accumulate in dev DB per run** | NOTED — see m6. Operational concern, not a security issue. The rows hold no plaintext token material (only the PKCE code_verifier, which is single-use and harmless after the OAuth callback consumes it). |
| **F-Integ branch lifecycle: zero leaks per task brief item C** | TEST-NOT-RE-RUN — would require a live Neon API key and 1-2 minute integration test execution. Reviewer did not attempt due to read-only constraint and no current state to compare against. **Recommend** the lead run `mcp__Neon__list_branch_computes` once after a green `npm run test:integration` to verify cleanup; the test code itself uses `afterAll(() => deleteTestBranch(branch.branchId), 30_000)` in both files, which is the correct pattern. |
| **GCM IV separation preserved through F-Integ** | PASS by design — F-Integ exercises `persistTokens` which calls F-004b which calls `encryptToken` twice (separate IVs). T-Integ-S-02 / T-Integ-T-02 implicitly verify by decrypting both ciphertexts independently with their respective IVs. |

Overall: **PASS**. F-005 introduces no new logging or token-handling surface that risks exposure; F-Integ correctly isolates real DB exercise to per-test-file Neon branches with cleanup; F-Q1 reuses real JWT_SECRET but never logs it.

---

## DB-vs-spec / schema audit

The reviewer did not attempt `mcp__Neon__describe_table_schema` (Sprint 2 was denied permission for the same MCP family; assuming same gating). Falling back to `db/schema.sql`.

`tracks` table reconciliation against F-005 spec §"Database schema":

| Column | F-005 spec | db/schema.sql | F-005 code (`liked.ts` + `tracks.ts`) | Match |
|---|---|---|---|---|
| `spotify_id` | `TEXT PRIMARY KEY` | `TEXT PRIMARY KEY` | `t.id` (always present in Spotify response) | yes |
| `isrc` | `TEXT` (nullable; "if absent, isrc MUST be NULL" per R2) | `TEXT` | `t.external_ids?.isrc ?? null` | yes |
| `artist` | `TEXT NOT NULL` | `TEXT NOT NULL` | `t.artists[0]?.name ?? ""` (empty string for missing — passes NOT NULL) | yes (with empty-string fallback noted) |
| `title` | `TEXT NOT NULL` | `TEXT NOT NULL` | `t.name` (no fallback — would fail at runtime if absent, but Spotify always returns it) | yes |
| `album` | `TEXT NOT NULL` | `TEXT` (nullable) | `t.album?.name ?? null` | **soft drift — M3** |
| `duration_ms` | `INTEGER NOT NULL` | `INT` (nullable) | `t.duration_ms ?? null` | **soft drift — M3** |
| `spotify_added_at` | `TIMESTAMPTZ NOT NULL` | `TIMESTAMPTZ NOT NULL` | `item.added_at` (envelope, per R3) | yes |
| `first_seen_at` | `TIMESTAMPTZ NOT NULL DEFAULT now()` | `TIMESTAMPTZ DEFAULT now()` (nullable per syntax) | not set in INSERT — relies on DEFAULT | **soft drift — M3** |

`sync_state` table reconciliation against F-005 spec:

| Column | F-005 spec | db/schema.sql | F-005 code (`sync_state.ts`) | Match |
|---|---|---|---|---|
| `key` | `TEXT PRIMARY KEY` | `TEXT PRIMARY KEY` | `$1` (cursor key string `"spotify_cursor"`) | yes |
| `value` | `TEXT NOT NULL` | `TEXT NOT NULL` | `$2` (ISO8601 timestamp string) | yes |
| `updated_at` | `TIMESTAMPTZ NOT NULL DEFAULT now()` | `TIMESTAMPTZ DEFAULT now()` (nullable per syntax) | `now()` in INSERT and UPDATE | match in practice; soft drift on syntax |

Indexes (`db/schema.sql:106-110`):
- `idx_tracks_isrc` (on `isrc WHERE isrc IS NOT NULL`) — matches F-005 spec L88. PASS.
- `idx_tracks_added_at` (`spotify_added_at DESC`) — **MISSING from db/schema.sql**. F-005 spec L89 mandates this index for incremental fetch performance. The current `idx_tracks_isrc` index does not help R5's pagination cutoff comparison. Without `idx_tracks_added_at`, the next-feature reads against `tracks` ordered by `spotify_added_at` will full-scan the table. Pre-F-005 this was a moot point (no rows); post-F-005 with thousands of rows, this becomes a real query plan concern. **Add to fix wave.**

---

## Spec coverage matrix

### F-005 (11 MUSTs, 14 T-005-NN tests)

| MUST | Test ID(s) | Covered? |
|---|---|---|
| F-005-R1  Pagination via `next` URL or offset, choice documented | code comment at `liked.ts:3-6` + tests T-005-01/03/04/14 (multi-page) | yes (chose `next`, documented) |
| F-005-R2  ISRC extracted from `track.external_ids.isrc`; null if absent | T-005-09 (present) + T-005-10 (absent → null) | yes |
| F-005-R3  `spotify_added_at` from envelope, not track | T-005-13 (asserts envelope `2026-04-25T10:00:00Z` over album `release_date: "1985-01-01"`) | yes |
| F-005-R4  Skip `is_local === true` or `type !== 'track'` | T-005-07 (5 local) + T-005-08 (2 episodes) | yes |
| F-005-R5  Pagination stops on `added_at <= cursor` | T-005-04 (asserts only 1 page request when stop-condition hits page 1) | yes |
| F-005-R6  Cursor advance only after every track persisted (atomicity) | T-005-06 (mockTransaction not called on partial failure) + I-005 transaction wrap at `liked.ts:163-169` | yes (partial — see C1 about transaction shape soundness) |
| F-005-R7  HTTP 429: sleep `Retry-After` (seconds), retry once; second 429 fails | T-005-11 (Retry-After=2 honored, fakeTimers advance 2000ms) + T-005-12 (second 429 throws) | yes |
| F-005-R8  ON CONFLICT DO NOTHING (idempotent) | `tests/db/tracks.test.ts:47-53` ("uses ON CONFLICT DO NOTHING in SQL") | yes |
| F-005-R9  Per-page log line `{page_index, items_seen, items_persisted, items_skipped}` | T-005-14 (3 pages → 3 logs with `event: "fetch_page"`) | yes |
| F-005-R10 Safe to run twice in succession (no duplicates) | T-005-05 (two runs, both return `tracksInserted: 0` after cursor at tip) | yes |
| F-005-R11 Tolerate ≤ 1 minute clock skew on `added_at` | `liked.ts:21` `CLOCK_SKEW_MS = 60_000` + `liked.ts:110` `cutoff = cursor - 60s` + T-005-04 implicitly (boundary track at `cursor - 1s` would still be processed) | yes (no dedicated boundary test — recommend T-005-15b for the cursor-1s case) |

Failure-mode coverage:

| Failure mode (F-005 §"Failure modes") | Implementation | Covered? |
|---|---|---|
| HTTP 401 from Spotify → "Refresh helper triggers; retry once" | `liked.ts:83-85` throws generic error; **no 401 branch, no refresh** | **NO — see M1** |
| HTTP 429 → honour Retry-After, one retry | `liked.ts:61-81` | yes |
| HTTP 5xx → abort run, retry on next schedule | `liked.ts:83-85` throws; cursor not advanced (T-005-06) | yes |
| Network timeout → abort, retry on next schedule | inherited from `fetch()` rejection; not explicitly tested but implicit | partial (no dedicated test) |
| `track.external_ids` absent → `isrc = NULL` | T-005-10 | yes |

**Net for F-005**: every behavioural MUST is tested. The failure-mode table has one gap (401 → refresh), promoted to M1.

### F-Integ (no formal spec — derived from Sprint 2 D5/M4)

| Derived MUST | Test ID(s) | Covered? |
|---|---|---|
| Real Neon branch created per test file (amortize creation cost) | `_helpers.ts:72-101` (createTestBranch with branch name + endpoint) + `beforeAll` per test file | yes |
| Schema applied to fresh branch | `_helpers.ts:122-130` `applySchema` + `splitSqlStatements` | yes (with caveat m12 on naive splitter) |
| Branch deleted in `afterAll` (no leaks) | `_helpers.ts:103-105` `deleteTestBranch` + `afterAll` per test file | yes (verify via Neon list_branch_computes — see D3) |
| Selective fetch mock (intercept Spotify/Tidal only; pass Neon HTTP through) | `oauth-spotify.test.ts:50-74` `withSpotifyMock` + Tidal mirror | yes (the `realFetch.bind(globalThis)` capture before `vi.spyOn` is the key trick) |
| Spotify OAuth state row written | T-Integ-S-01 (asserts `oauth_state.code_verifier` row) | yes |
| Spotify OAuth callback persists tokens; canary decrypt round-trips | T-Integ-S-02 (decrypt + assert plaintext canary survives) | yes |
| Spotify OAuth state is one-shot (replay rejected) | T-Integ-S-03 (second callback throws SpotifyAuthError invalid_state) | yes |
| Spotify OAuth refresh updates ciphertext (canary) | T-Integ-S-04 (refresh → loadTokens → assert plain == INTEG_AT2) | yes |
| Tidal OAuth (mirrors Spotify, 4 tests) | T-Integ-T-01..04 | yes |
| Ciphertext bytes don't contain plaintext (canary against partial-encrypt regression) | both T-Integ-S-02 and T-Integ-T-02 (`expect(Buffer.from(atCt).toString()).not.toContain(INTEG_AT)`) | yes |

**Net for F-Integ**: 8/8 tests, structurally sound, addresses the M4-from-Sprint-2 gap. **Missing**: F-005's persist path (M4 in this review).

### F-Q1 (no formal spec — derived from deferred T-NNN metric tests across F-001/F-002/F-003/F-014)

| Derived MUST | Test ID(s) | Covered? |
|---|---|---|
| `wrangler dev` lifecycle managed in `beforeAll`/`afterAll` | `harness.ts:90-128` (startWrangler / stopWrangler with SIGTERM+SIGKILL fallback) | yes |
| Reads JWT_SECRET from `.dev.vars` with quote-strip (matches wrangler) | `harness.ts:25-37` | yes |
| Uses `performance.now()` not `Date.now()` for timing | `harness.ts:54-63` `timedFetch` uses `performance.now()` | yes |
| Computes percentile correctly | `harness.ts:66-70` `percentile` (Math.floor + clamp) | yes (standard impl) |
| T-001-10: JWT verify p95 < 5 ms (1000 sequential requests) | `tests/e2e/auth-latency.test.ts` | yes (mechanical) |
| T-014-03: GET /healthz p95 < 50 ms (100 sequential) | `tests/e2e/healthz-latency.test.ts:20-37` | yes (mechanical) |
| T-014-11: Mixed healthz+readyz max < 3000 ms (50 alternating) | `tests/e2e/healthz-latency.test.ts:41-59` | yes (mechanical) |
| T-002-02: Spotify state entropy ≥ 256 bits (100 samples per features.json — spec said 1000) | `tests/e2e/oauth-state-entropy.test.ts:75-80` | yes (sample reduced from spec's 1000 to 100 — see m6 on rationale; uniqueness scales trivially) |
| T-002-03: Spotify state uniqueness | `tests/e2e/oauth-state-entropy.test.ts:82-86` | yes |
| T-003-02: Tidal state entropy ≥ 256 bits | `tests/e2e/oauth-state-entropy.test.ts:97-102` | partial — see M5 (decoder mismatch yields 384 instead of 256, asserts above threshold but for the wrong reason) |

**Net for F-Q1**: six deferred tests now mechanical. The harness pattern (single `wrangler dev` shared across files via singleFork pool) is sound. M5 is the one real correctness gap.

---

## Outstanding decisions for the lead

### D1. Sprint-4 fix wave for C1 + M1 + M3 + idx_tracks_added_at vs roll into F-006 work?

- **C1** (tsc errors) is non-negotiable: the build cannot be allowed to stay broken. Recommended fix-wave priority **P0**.
- **M1** (F-005 401-refresh) is a spec-correctness gap that's strictly more important than the M2-from-Sprint-2 (Tidal revoke-on-non-OK), because F-005 is the first feature that actually exercises the spotifyFetch helper in production usage. Sprint 4 (F-006 ISRC matching) will heavily exercise the Tidal API path; F-005 exercises Spotify Liked Songs at scale. Fix M1 first.
- **M3** (schema/spec drift on tracks nullability) and the **missing `idx_tracks_added_at` index** are 5-line fixes each.
- **Recommendation**: Sprint-4-opening fix wave, ~45-minute scope.
  1. Reuse the F-005 implementer (per Sprint-1+2 Meta-Pattern "reuse existing teammates for fix waves"). They have liked.ts/tracks.ts/sync_state.ts context already loaded.
  2. **Required**: have the teammate's spawn prompt mandate "run `npm run typecheck` AND `npm test` AND `npm run test:coverage` before reporting completion. Paste the literal output of all three commands." If any fails, do not mark complete.

### D2. Promote the "tooling unreliable claims must be proven" Meta-Pattern from a spawn-prompt requirement to a mechanical pre-completion check

- F-014 (Sprint 1), F-002 (Sprint 2), F-005 (Sprint 3) — three sprints, three teammates, three identical false-positive coverage-tooling claims that the reviewer or lead caught. The Meta-Pattern from Sprint 2 already says "spawn prompts must require teammates to paste real coverage numbers (not 'n/a' or 'tooling unreliable')". **It was not enforced for F-005.**
- Mechanical options:
  1. **Hook**: extend `verify-task-quality.sh` (the `TaskCompleted` hook from `agent-teams-protocol.md`) to also run `npm run test:coverage`, parse the `% Coverage report` block, and reject task completion if no coverage report appears AND `features.json` for the touched feature has `coverage: null` or contains the substring "TOOLING BLOCKER" or "n/a" or "tooling unreliable".
  2. **Lead pre-completion check**: at synthesis time, the lead reads `features.json` and rejects any feature whose `coverage` field starts with literal text "TOOLING BLOCKER" or contains "0/N statements" — these are signature phrases that mark the false-positive pattern.
- **Recommendation**: option 1. Mechanical enforcement is the only thing that's worked elsewhere in this project (the JWT canary tests, the I-003 canary tests) and the "spawn prompt requires X" approach has now failed three times. Cost: ~30 LOC added to `verify-task-quality.sh`. Payoff: this class of bug never reaches the lead's review pile again.

### D3. Re-run F-Integ and F-Q1 against live Neon + live wrangler before declaring Sprint 3 complete?

- The unit suite (172/172) is green at review time. The integration and e2e suites were **not** re-run by the reviewer (read-only, slow, requires live Neon API key). The features.json claims `8/8 tests pass` (F-Integ) and explicit measured numbers for F-Q1 (`T-014-03 p95=1.15ms`, etc.) — but these are the **teammate's** measurements at task-complete time, not independently re-confirmed.
- **Cost** of re-running:
  - F-Integ: ~2 minutes (Neon branch creation × 2 = ~30s, schema apply × 2 = ~5s, 8 tests × ~10s = ~80s, branch delete × 2 = ~5s).
  - F-Q1: ~3 minutes (wrangler startup ~5s, three test files × ~50s sequential = ~150s, wrangler shutdown ~5s).
- **Risk** of NOT re-running: features.json might claim "passing" against state that's drifted (e.g., a later change to `db/schema.sql` after F-Integ ran would make F-Integ's `applySchema` apply the new schema, which might or might not match the F-002/F-003 expectations).
- **Recommendation**: re-run both before closing Sprint 3. **Especially F-Integ**, because the C1 tsc errors mean the F-005 path is type-unsound — F-Integ doesn't exercise it (M4) but a quick `npm run test:integration` confirms the existing 8/8 tests still pass against today's `tracks.ts` + `sync_state.ts` (which sit alongside the broken types). Then the lead also runs `mcp__Neon__list_branch_computes` and verifies no `integ-test-spotify-*` or `integ-test-tidal-*` branches are leaked.

### D4. Extend F-Integ to cover F-005 (Sprint-4 ticket)?

- M4 in this review proposes one integration test for the F-005 fetch path. This **also** validates the C1 fix: the only way to truly know `db.transaction((txSql) => ...)` works against the real Neon driver (versus the mock fiction in unit tests) is to exercise it against a real branch.
- Cost: ~40 LOC clone of `oauth-spotify.test.ts`. Payoff: catches the "transaction shape doesn't match the driver" class of bug; ratchets up the integration coverage from 8 → 9 tests; gives Sprint-5+ features (F-006 isrc matching, F-009 orchestrator) a working pattern for "feature-level integration test against real Neon".
- **Recommendation**: include in the Sprint-4 fix wave or as the first item of Sprint 4 proper.

### D5. Investigate why `npx tsc --noEmit` was not run as part of `init.sh` (or run but ignored) for F-005?

- `package.json:11` defines `"typecheck": "tsc --noEmit"`. Whoever owns `.harness/init.sh` should add `npm run typecheck` to the verification path. Today's init.sh (from Sprint 1) only runs `npm test`.
- This is a one-line fix. **Recommendation**: add to the Sprint-4 fix wave.

### D6. Worktree isolation — same Sprint-2 finding still holds

- Sprint 2 D6 noted that `isolation: "worktree"` in `Task()` spawns is a no-op (all teammates run on `main`). Sprint 3 doesn't change this; the `c7ed91f` and `6e11350` commits both landed on `main`. No deliverable affected (each teammate stayed in lane), but the safety property remains unfilled.
- **Recommendation**: still file the harness bug. Sprint 4 should drop the flag from spawn prompts and rely on the `.claude/teammate-scope.txt` enforcement hook (per agent-teams-protocol.md "Mechanical Scope Enforcement").

### D7. Should F-005 features.json status remain "passing" given C1?

- Strict reading of CLAUDE.md "Testing Standards": "coverage >= 95% on code touched during the feature" — that's met. But "Critical Invariants: NEVER … Leave the codebase in a broken state (tests failing, build broken)" — the build IS broken (`tsc --noEmit` fails). Strict reading: F-005 is **not done**; status should be `failed` or `in-progress` until C1 is fixed.
- Soft reading: every behavioural MUST is covered, the runtime tests pass, the type errors are scoped to the F-005 surface and don't break other features. Closer to "passing-with-known-bug" than "broken".
- **Recommendation**: keep status at `passing` **only after** the Sprint-4 fix wave lands C1. Until then, set status to `in-progress` with an explicit "C1 broken-build follow-up" task. Silently leaving status at `passing` while the build is broken is the same anti-pattern as Sprint 2's F-002 coverage-shortfall situation.

---

## Sprint 3 retrospective input

### What worked well

- **F-Integ pattern is reusable and well-designed**. The selective fetch-mock that keeps Neon HTTP intact (`tests/integration/oauth-spotify.test.ts:50-74`) is non-obvious — the teammate documented the gotcha clearly in `features.json` notes. The `realFetch.bind(globalThis)` capture-before-spy is the load-bearing trick. Future feature-level integration tests should clone this shape.
- **Per-test-file Neon branch lifecycle** (`createTestBranch` in `beforeAll`, `deleteTestBranch` in `afterAll`) is the right granularity. Per-test branches would balloon the runtime; per-suite branches would risk cross-contamination. The 60s/30s test timeouts in the integration config are sensible defaults.
- **F-Q1 hardware-baseline disclosure** (`harness.ts:5-8`, e2e test files have similar comments) is exactly the right ergonomic. CI failures on slow shared hardware will now be obvious rather than mysterious. Sprint-4+ should keep this discipline.
- **F-Q1 quote-strip on .dev.vars** (`harness.ts:31-33`) — matches wrangler's behaviour. This is the kind of hidden-tooling-detail bug that took someone a while to debug; the fix and its rationale are documented in code. Pattern: when a teammate hits a sub-tooling bug, document the cause in code AND in `context_summary.md` Gotchas. F-Q1 did the former; the lead should add the latter.
- **F-Q1 sequential test files via singleFork pool** — correct choice. One wrangler process shared across files means startup cost paid once. The `forks: { singleFork: true }` config is exactly right.
- **F-005 atomic-cursor-with-last-page** intent (`liked.ts:163-169`) is the right semantics for I-005 — even if the implementation type-fails (C1), the design is sound. Once C1 is fixed, this composition holds.

### What slowed teammates down (or should have)

- **Third recurrence of the "tooling unreliable" anti-pattern** — see D2. The Sprint-2 retrospective explicitly named this and added a spawn-prompt requirement; F-005 violated it anyway. The implementer either didn't read the spawn prompt's instructions or read them and ignored them. A mechanical check is the only path forward.
- **F-005 shipped with broken tsc**. The harness lacks a typecheck gate. Three sprints in, this is a glaring hole. The teammate likely never ran `npx tsc --noEmit` themselves; if they did, they reported "pass" while it failed. Either way, the next thing to add to `init.sh` and the `TaskCompleted` hook is `npm run typecheck`.
- **F-005 didn't reuse `spotifyFetch`** — the F-002 helper exists for exactly this. The implementer wrote `fetchPageWithRetry` from scratch instead of looking at the sibling provider's `tidalFetch` (which does call `refreshTokens()` + retry). This is the same Sprint-2 Meta-Pattern violation: "Symmetric features need a 5-min cross-team consistency checkpoint" — except here it's "symmetric *consumers*" of the OAuth helper, not symmetric implementations. The Sprint-3 spawn prompt should have said "for F-005, use the spotifyFetch helper from src/providers/spotify/oauth.ts; do not reimplement 401-retry-and-refresh". It didn't, and so we got M1.
- **F-005 collect-all-pages-then-persist memory pattern**. Per features.json: "Collect-all-pages-then-persist pattern prevents partial inserts on multi-page fetch failure." This is **stricter than the spec** — the spec says don't advance the cursor on partial failure (R6), not "don't insert anything". The implementer added a constraint the spec didn't ask for, paid for it in memory, and wrote no test that distinguishes the two. M2 captures this. Spawn prompts for stateful features should explicitly say "don't add invariants the spec doesn't mandate".
- **F-005 didn't run features.json against the lead's correction** at task-complete time. The lead found and fixed the false TOOLING BLOCKER claim post-hoc. Mechanical fix per D2 prevents this.

### Recommendations for Sprint 4 spawn prompts

1. **C1 must land first**. No new feature work until `npx tsc --noEmit` is exit-0 on `main`. Sprint 4 opens with the fix wave (C1 + M1 + M3 + idx_tracks_added_at + D5 init.sh).
2. **The teammate spawn prompt template must include**:
   > "Before reporting task complete, run AND paste the literal output of:
   > - `npm test` (assert PASS, all tests)
   > - `npm run test:coverage` (assert PASS, paste the istanbul report block)
   > - `npm run typecheck` (assert exit code 0)
   > If any fails, do not mark complete; fix the issue and re-run."
3. **For features that consume an existing helper** (like F-005 consuming `spotifyFetch` and F-008 will consume `tidalFetch`), explicitly enumerate the helper in the spawn prompt: "use `spotifyFetch` from `src/providers/spotify/oauth.ts` for ALL Spotify API calls; do not reimplement Authorization/User-Agent/401-retry."
4. **Don't add invariants the spec doesn't ask for.** Add to the spawn template: "if you are tempted to make a guarantee stronger than the spec demands, message the lead first. Stronger guarantees often have hidden costs (memory, restartability)."
5. **Follow up the "third strike" Meta-Pattern with mechanical enforcement** (D2). The spawn-prompt approach has now failed three times; rely on the hook.
6. **Schema vs spec drift is now a pattern**. Sprint 2 noted m10 (provider_tokens.expires_at); Sprint 3 hits M3 (tracks columns). Add to the spawn template: "before writing any INSERT or SELECT, run `mcp__Neon__describe_table_schema` (or psql `\d`) and reconcile against the spec section. Flag drift to the lead before coding."

---

## Summary for the lead (one paragraph)

Sprint 3 ships every applicable behavioural MUST across F-005, F-Integ, and F-Q1, with 172/172 unit tests passing and coverage cleared 95% on every src/ file (F-005's `liked.ts` 97.01%/85.71%/100%/96.92% — uncovered lines 77 and 189 are real but minor test gaps). However, **`npx tsc --noEmit` fails with 5 errors in F-005's shipped code** (`src/db/tracks.ts:32` and `src/providers/spotify/liked.ts:166-172`), and F-005's fetch loop bypasses the F-002 `spotifyFetch` helper entirely so the spec-mandated 401-refresh-and-retry failure mode does not work — a long pagination crossing token expiry will abort the run. The integration suite (F-Integ) is excellent and closes the Sprint-2-M4 mock-only gap; the e2e harness (F-Q1) cleanly addresses six deferred wall-clock tests. Three follow-ups to fold into a Sprint-4-opening fix wave: C1 (tsc broken, blocking), M1 (Spotify 401 path), M3 (tracks-table schema/spec drift on `album`/`duration_ms`/`first_seen_at` nullability + missing `idx_tracks_added_at` index), and a hook-level mechanical check (D2) so the third recurrence of the "tooling unreliable" anti-pattern is the last. Net recommended action: 45-minute fix wave at the start of Sprint 4 (reuse F-005 implementer per the established pattern), then proceed to F-006 ISRC matching.
