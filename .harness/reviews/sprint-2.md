# Sprint 2 Review (2026-04-25)

Reviewer: Opus, read-only, single deliverable.
Sprint scope: F-001 (JWT auth + bootstrap mint + secrets guard), F-004b (token persistence helpers + oauth_state), F-002 (Spotify OAuth), F-003 (Tidal OAuth).
Commits in scope: `95498b9 .. b43c0aa` (5 commits on `main`, post Sprint 1 close-out at `b5841e1`).

---

## Verdict

**SHIP-WITH-FOLLOW-UPS** — every applicable acceptance criterion is met, all 134 tests pass, and the sprint's spec coverage is genuinely strong. Two issues warrant a fix-wave before Sprint 3 starts (one logic bug, one OAuth-spec correctness gap), and the F-002 coverage shortfall is real but not load-bearing.

The cryptographic, persistence, and auth surfaces are solid: F-001 auth middleware is precise, F-004b round-trips correctly with separate IVs and atomic state consumption, F-003 hits 100% on `oauth.ts` and 100% on the route, and F-002 ships every behavioural MUST with traceable test IDs. The two follow-up items are scoped to the Spotify provider (one R7 coalescing hole on the 401 path; the F-002 teammate's "coverage tooling unreliable" framing is wrong and should be replaced with the real numbers and a small fix-wave).

A separate process observation: the F-003 refresh path treats *any* non-OK response from Tidal's token endpoint as "refresh token revoked" and persists `status='revoked'`. F-003 spec only requires revocation when Tidal "returns an OAuth error indicating an expired or revoked refresh token" — a 5xx blip should not force the user through reauth. Currently a `503 Service Unavailable` from Tidal will pull the user out of the system. M2 below.

The F-002/F-003 → F-004b integration is mocked end-to-end at the test layer, but no test exercises the real persist path. That's the same Sprint-1 D5 already on the docket; flagged again as Sprint-3 candidate, not a Sprint-2 blocker.

---

## Per-task verdict

- F-001 — JWT auth middleware + bootstrap mint + secrets guard:    **PASS-WITH-NOTES** (95.83% / 97.5% on touched files; one real-but-minor unreachable-by-design line, one istanbul branch-counting artifact)
- F-004b — Persistence helpers + oauth_state:                       **PASS** (100/100/100/100 on `src/db/`; atomic `DELETE … RETURNING`; separate IVs verified)
- F-002 — Spotify OAuth:                                            **PASS-WITH-FIXES** (functionally complete; one real R7-coalescing hole on the 401 path; coverage 89.58% on `oauth.ts` is below the 95% gate and the gap is real, not tooling)
- F-003 — Tidal OAuth:                                              **PASS-WITH-FIXES** (functionally complete and best-covered of the four; one real spec-correctness bug — non-OAuth refresh failures wrongly mark `revoked`)

---

## Coverage report

`npm run test:coverage` runs cleanly under `@cloudflare/vitest-pool-workers@0.5.41` with the istanbul provider. Real numbers (paste from istanbul output):

```
Test Files  12 passed (12)
     Tests  134 passed (134)

% Coverage report from istanbul
-------------------|---------|----------|---------|---------|------------------
File               | % Stmts | % Branch | % Funcs | % Lines | Uncovered
-------------------|---------|----------|---------|---------|------------------
All files          |   98.41 |    82.77 |   95.67 |   98.63 |
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
 src/middleware    |    97.5 |    81.48 |     100 |    97.5 |
  auth.ts          |   94.44 |       80 |     100 |   94.44 | 33
  secrets.ts       |     100 |    82.35 |     100 |     100 | (?? branch)
 src/providers/spotify
  oauth.ts         |   89.58 |    71.42 |   86.66 |    91.3 | 88,208,235,244
 src/providers/tidal
  client.ts        |   96.87 |    86.36 |     100 |   96.87 | 22
  oauth.ts         |     100 |      100 |     100 |     100 |
  scopes.ts        |     100 |      100 |     100 |     100 |
 src/routes
  health.ts        |     100 |    94.11 |     100 |     100 | (sprint 1)
 src/routes/auth
  spotify.ts       |   92.85 |       50 |     100 |   92.85 | 27
  tidal.ts         |     100 |       90 |     100 |     100 |
-------------------|---------|----------|---------|---------|------------------
```

### Reconciliation with `features.json`

| Feature | features.json claim                                                                 | Actual                                       | Verdict |
|---------|-------------------------------------------------------------------------------------|----------------------------------------------|---------|
| F-001   | "src/auth: 95.83% stmts, 100% funcs; src/middleware: 97.5% stmts, 100% funcs"       | exact match                                  | **match** |
| F-004b  | "100% statements, 100% branches, 100% functions, 100% lines on src/db/"             | exact match                                  | **match** |
| F-002   | "coverage measurement affected by known Istanbul/Workers sandbox .tmp file write issue" | 89.58 stmt / 71.42 branch on `oauth.ts`; 92.85 stmt / 50 branch on routes — fully measurable | **mismatch — F-002's framing is wrong; numbers are real** |
| F-003   | "src/providers/tidal/: 98.87% stmts, 91.17% branches, 100% funcs; src/routes/auth/tidal.ts: 100% stmts, 90% branches, 100% funcs" | matches exactly                              | **match** |

The F-002 teammate's claim that coverage "measurement [was] affected by known Istanbul/Workers sandbox .tmp file write issue" is **false**. F-003 ran on the same tooling on the same project at the same sprint and measured cleanly to 98.87% — both teammates ran `npm run test:coverage`, both got real numbers. F-002's gap is a genuine test gap, not tooling. See M3 for the recommended remediation; see C0 (none — no critical issues this sprint) for what would have been a blocker if the gap had hit a security path. Recommend updating `features.json` for F-002 with the real numbers and the per-line classification below.

### Uncovered-line classification (per CLAUDE.md "no defensive code that can't happen" rule)

| File | Line | Classification | Rationale | Recommendation |
|---|---|---|---|---|
| `src/auth/verify.ts` | 30 | real test gap | `throw new AuthError("malformed_token")` for `ERR_JWT_CLAIM_VALIDATION_FAILED` whose claim is not `iss` (e.g., bad `aud`) | Add a T-001 unit test that mints a token with `aud` set to a wrong value; one line of test for one line of code |
| `src/middleware/auth.ts` | 33 | unreachable defensive | `return authReject("missing_token")` after `slice("Bearer ".length).trim()` returns empty. The "Bearer " test at line 126-133 of `auth.test.ts` documents that Hono trims trailing whitespace, so the prefix check `!authHeader.startsWith("Bearer ")` already catches it | Either delete L32-34 (preferred per "no defensive code that can't happen") or accept the istanbul artifact and document |
| `src/middleware/secrets.ts` | 8/15/26 (branch) | istanbul `??` artifact | `env.JWT_SECRET ?? ""` and `env.TOKEN_ENCRYPTION_KEY ?? ""` and `skipPaths = []` default — istanbul counts the unused fallback branch even though the value is always provided | Accept; istanbul over-reports `??` branches |
| `src/providers/spotify/oauth.ts` | 88 | istanbul function-signature artifact | The `: Promise<void>` declaration line of `handleCallback` | Accept |
| `src/providers/spotify/oauth.ts` | 208 | unreachable defensive | `throw "Tokens missing after refresh"` — `loadTokens` returning null *immediately* after a successful `persistTokens` call. Only happens under DB cleanup race or DB outage between persist and select | Remove (defensive, can't happen on the happy path) or add a test that mocks `loadTokens` to return null on the post-refresh select |
| `src/providers/spotify/oauth.ts` | 235 | unreachable defensive | Same as L208 for the 401 retry path | Same: remove or test |
| `src/providers/spotify/oauth.ts` | 244 | **real test gap** | `return response;` — the happy path return when `spotifyFetch` succeeds **without** a 401 on the first try. T-002-14 only tests the 401-retry path. There is no test for "spotifyFetch returns 200 first try" | Add a one-line test: mock fetch to 200, call `spotifyFetch`, expect status 200 |
| `src/routes/auth/spotify.ts` | 27 | unreachable defensive | `return c.json({ error: "token_exchange_failed" }, 400);` — fallback for a non-SpotifyAuthError throw out of `handleCallback`. Today the only callers are typed and only throw `SpotifyAuthError`, so this catches a type-system escape | Remove or test (mock `handleCallback` to throw a `TypeError`) |
| `src/routes/auth/tidal.ts` | 29 | branch artifact | `err instanceof Error ? err.message : String(err)` ternary — the `String(err)` arm is unreachable in practice | Same: remove `String(err)` arm or accept |
| `src/providers/tidal/client.ts` | 22 | unreachable defensive | Same as Spotify L208: `loadTokens` returning null after a successful proactive refresh. `tests/providers/tidal/client.test.ts:258` *does* exercise this path with `mockResolvedValueOnce(null)` — the istanbul "uncovered" report here is a false positive (likely line-mapping noise from the surrounding optional-chain block) | Accept or add a more direct unit test |
| `scripts/mint-bootstrap-token.ts` | 21-27, 33 | CLI entry point | Inside `/* istanbul ignore next */` blocks — istanbul still reports the lines but the function is exercised via `import` from `auth.test.ts` | Accept; per `features.json` notes, "CLI main() untestable from Workers sandbox" |

After this classification, the only **real test gaps** are L30 of `verify.ts` and L244 of Spotify `oauth.ts`. Both are one-line tests. Adding them lifts Spotify `oauth.ts` to ≥95% statement coverage and `src/auth/verify.ts` to 100%.

---

## Critical issues (must fix before Sprint 3 starts)

None this sprint. The closest is M1 (Spotify R7 coalescing hole on the 401 path) — it's a logic bug, but it doesn't expose secrets, doesn't corrupt data, and only manifests under concurrent traffic that today's single-tenant Worker is unlikely to hit. Promoted to "major" rather than "critical".

---

## Major issues (should fix before Sprint 3 starts)

### M1. Spotify `spotifyFetch` 401-retry path violates F-002-R7 (refresh coalescing)

- `src/providers/spotify/oauth.ts:229-230`:
  ```typescript
  const inFlight = doRefresh(env).finally(() => refreshInFlight.delete("spotify"));
  refreshInFlight.set("spotify", inFlight);
  ```
- The 401-retry path calls `doRefresh()` directly and **then** sets the `refreshInFlight` map, with **no check for an existing in-flight refresh**. If a proactive refresh from `ensureFreshToken()` is already running (started in `ensureFreshToken` at L199-201) when a different concurrent request gets a 401 and lands here, this code path starts a **second concurrent refresh** and overwrites the existing Map entry. The first refresh's `finally` then runs and `delete`s the *new* refresh's Map entry — leaving the second refresh effectively un-coalesced for a subsequent call.
- F-002-R7: "Concurrent refresh attempts MUST be coalesced; only one refresh request may be in flight per provider at any time."
- T-002-12 (the coalescing test) only exercises the `ensureFreshToken` path with concurrent calls; it does not exercise a mixed `ensureFreshToken` + `spotifyFetch(401)` interleaving. The test passes but doesn't prove R7 holds across both paths.
- Compare to the Tidal implementation: `src/providers/tidal/oauth.ts:110-122` `refreshTokens()` checks the Map first and reuses the existing in-flight promise. The Tidal `client.ts:32-39` 401-retry path also calls `refreshTokens()` (which does the Map check), so Tidal *does* coalesce across both paths. Spotify should mirror this.
- **Impact**: under burst traffic with one near-expiry token and one stale-but-200 token, the system can issue 2 refresh POSTs to Spotify back-to-back. Spotify rate-limits refresh; this could trip 429s and cascade. Single-tenant operation makes the burst rare but not impossible (e.g., a sync run firing 50 concurrent track fetches when the token has 30s left).
- **Fix**: factor a `refreshSpotify()` helper that mirrors Tidal's `refreshTokens()` pattern (Map check → reuse-or-create), and call it from both `ensureFreshToken` and the `spotifyFetch` 401 branch. ~10-line refactor; T-002-12 should be extended to cover the mixed path.

### M2. Tidal `_doRefresh` marks tokens revoked on **any** non-OK response, including transient 5xx/429

- `src/providers/tidal/oauth.ts:148-151`:
  ```typescript
  if (!response.ok) {
    await markRevoked(env, "tidal");
    throw new TidalReauthRequired();
  }
  ```
- F-003 spec, "Handle refresh failure": "Given Tidal returns an OAuth error indicating an expired or revoked refresh token … the system marks the `provider_tokens` row as `revoked`."
- F-003-R-failure-table (rows 3 and 4) explicitly distinguish:
  - "Refresh fails permanently" → re-run OAuth flow (this is the revoke case)
  - "Tidal returns 5xx repeatedly" → "backoff with jitter, retry within run; abort run after 3 failures" — **not revoke**
- Today's code revokes on a single 503, a 429, a 502, a network blip — anything that's not 2xx. The user is then forced through a full reauth on every transient infra issue.
- T-003-07 only tests `400 invalid_grant` and labels the test "refresh failure marks tokens revoked" — the test name papers over the bug.
- **Impact**: a single Tidal infrastructure incident permanently boots the user out of the system until they manually re-do `/auth/tidal`. This is a real user-facing reliability hole.
- **Fix**: discriminate on response status + body, mirroring the Spotify path (`src/providers/spotify/oauth.ts:164-170`):
  ```typescript
  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    if (response.status === 400 && (errorData.error === "invalid_grant" || errorData.error === "invalid_request")) {
      await markRevoked(env, "tidal");
      throw new TidalReauthRequired();
    }
    throw new Error(`tidal refresh transient: ${response.status}`);
  }
  ```
  T-003-07 should keep its current assertion; add a new test "5xx does not mark revoked" that asserts `mockMarkRevoked` was NOT called when the refresh returns 503.

### M3. F-002 coverage gap is real, not tooling — `features.json` should record real numbers and the gap should be closed

- See "Coverage report" reconciliation table. The teammate's "Istanbul/Workers sandbox .tmp file write issue" claim is contradicted by F-003 measuring cleanly to 98.87% on the identical pipeline.
- Spotify `src/providers/spotify/oauth.ts` real coverage is **89.58% statements / 71.42% branches** — below the project's 95% gate per `CLAUDE.md` "Testing Standards: For harness projects: coverage >= 95% on code touched during the feature".
- After the per-line classification above, the gate is achievable with two one-line test additions (the `verify.ts` claim mismatch test and the `spotifyFetch` happy-path test) and one optional refactor (remove the L208/L235/L244 defensive throws or test them).
- **Recommend**: small fix wave for the F-002 teammate (or the lead, since the surface is small):
  1. Update `features.json` F-002 `coverage` field with the real numbers and the per-line classification.
  2. Add the two missing one-line tests.
  3. Decide on L208/L235 — keep as belt-and-braces (and add tests) or delete (and accept that a post-persist `loadTokens` returning null would crash the request at the `.accessToken` access).
  4. Re-run `npm run test:coverage` and confirm `oauth.ts` ≥ 95% statement.
  5. Revise `features.json` again with passing-gate numbers.

### M4. F-002/F-003 → F-004b integration is mock-tested only; no end-to-end path exercises the real `persistTokens`/`loadTokens`

- All four `tests/providers/spotify/oauth.test.ts`, `tests/providers/tidal/oauth.test.ts`, and the route-level tests use `vi.mock("../../../src/db/provider_tokens")` and `vi.mock("../../../src/db/oauth_state")`. The mocked implementations satisfy the type signatures but never round-trip through the real F-004b code.
- F-004b's own tests (`tests/db/provider_tokens.test.ts`) cover the real path with the Neon driver mocked.
- Net: the real composition `OAuth callback → handleCallback → persistTokens → encryptToken → neon UPSERT` has never been exercised together. If the F-004b function signatures or return shapes drift from what F-002/F-003 expect, no test catches it. The TypeScript compiler will catch signature-level drift, but not semantic drift (e.g., expiresAt converted Date↔string somewhere).
- This is **identical to** Sprint 1 D5 (Neon-branch integration test for /readyz). It already became a real bug class once.
- **Recommend**: Sprint 3 candidate, single integration test per provider:
  - Spin a Neon branch via `mcp__Neon__create_branch`
  - Apply `db/schema.sql`
  - Mock only outbound `fetch` to Spotify/Tidal; let everything else hit the real DB
  - Assert the row in `provider_tokens` decrypts back to the canary access/refresh token
  - `mcp__Neon__delete_branch`
- Cost: ~80 LOC. Payoff: this entire bug class never recurs.

### M5. `src/index.ts` route-pattern asymmetry between Spotify and Tidal

- `src/index.ts:18-19`:
  ```typescript
  app.route("/auth", spotifyAuthRoutes);       // sub-router has /spotify and /spotify/callback
  app.route("/auth/tidal", tidalAuthRoutes);   // sub-router has / and /callback
  ```
- Both work today (134/134 tests pass), but the asymmetry is a maintenance smell. Anyone adding a third provider has to choose a pattern and will inevitably guess wrong half the time.
- Looking at the sub-routers:
  - `src/routes/auth/spotify.ts:9` — `spotifyAuthRoutes.get("/spotify", ...)` (full sub-path)
  - `src/routes/auth/tidal.ts:7` — `tidalAuthRoutes.get("/", ...)` (root sub-path)
- F-001 spec, F-002 spec, F-003 spec all describe `/auth/spotify` and `/auth/tidal` as sibling paths — the convention should be consistent.
- **Recommend**: harmonize on one pattern. Either:
  - Option A (preferred — sub-router knows its provider name): make Tidal mirror Spotify.
    - `src/index.ts`: `app.route("/auth", tidalAuthRoutes);`
    - `src/routes/auth/tidal.ts`: `tidalAuthRoutes.get("/tidal", ...)` and `tidalAuthRoutes.get("/tidal/callback", ...)`
  - Option B (sub-router is provider-agnostic): make Spotify mirror Tidal.
    - `src/index.ts`: `app.route("/auth/spotify", spotifyAuthRoutes);`
    - `src/routes/auth/spotify.ts`: `spotifyAuthRoutes.get("/", ...)` and `spotifyAuthRoutes.get("/callback", ...)`
- Both are ~5-line edits. Pick A or B and document the convention in `context_summary.md` Patterns. Add a note for F-005..F-013 that any new provider/route module follows the chosen pattern.

---

## Minor issues (style, polish)

- **m1.** `src/providers/spotify/oauth.ts:165` — `await response.json().catch(() => ({})) as Record<string, unknown>` is fine but the `.catch(() => ({}))` makes the next line `errorData.error === "invalid_grant"` always false on a non-JSON response. That's the safe behaviour (don't revoke without confirmation), but it would be more honest to log the unparseable body once via a redacted summary so a Sprint-3 incident reviewer can see what Spotify returned.
- **m2.** `src/providers/tidal/scopes.ts:1-2` — TODO is placed correctly and surfaces clearly. It's also referenced in `features.json` F-003 notes ("Scopes in src/providers/tidal/scopes.ts need Ovidiu to verify against Tidal Developer Portal app config"). No reviewer action — Ovidiu is the right person to verify.
- **m3.** `src/providers/tidal/client.ts:60` — `if (contentType.includes(TIDAL_V2_ACCEPT.split(";")[0]))`. The literal `TIDAL_V2_ACCEPT` has no `;` so `.split(";")[0]` returns the whole string. Either drop the `.split(";")[0]` (it's a no-op) or document why it's there (defending against a future change to add `;charset=utf-8`).
- **m4.** `src/providers/tidal/client.ts:27` — `new URL(path)` requires `path` to be an absolute URL. Today's call sites pass full URLs (`https://openapi.tidal.com/v2/...`); F-006 callers might pass paths. Future-proof: accept a base URL via env or constant and `new URL(path, BASE)`. Not a Sprint-2 issue; flag for Sprint 3.
- **m5.** `src/db/provider_tokens.ts:39` — `Buffer.from(atCt)` etc. relies on the `Buffer` global, which works in Workers under `nodejs_compat` but is technically a Node.js polyfill. The `@neondatabase/serverless` driver expects `bytea` parameters as Buffer — this is the supported path per the Neon docs — but the next reviewer may flag it as "Node API contraband" without context. Worth a one-line inline comment `// neon driver requires Buffer for bytea params (nodejs_compat)`.
- **m6.** `src/middleware/secrets.ts:5,32-37` — module-level `let validated: boolean | null = null` cache. On a real deploy this is per-isolate; if Cloudflare evicts and re-spins the isolate, the secrets are re-validated on the next request. That's fine. The `resetSecretsCache()` export (L51) is purely for test isolation — keep it. Mild "test-only export in production module" smell, but acceptable.
- **m7.** `src/index.ts:9` — `AUTH_SKIP_PATHS = ["/healthz", "/readyz", "/auth/spotify/callback", "/auth/tidal/callback"]`. The list is correct per F-001-R6 + T-001-13. Hard-coding it in `index.ts` rather than in `src/middleware/auth.ts` keeps the middleware reusable but moves the security policy decision into the router file. Either is defensible. If F-005..F-013 add more callbacks, this list grows; a `Set` would be marginally cheaper than `Array.includes`. Defer.
- **m8.** `tests/providers/spotify/oauth.test.ts:280-300` — the comment block above the mock setup ("ensureFreshToken: 1st loadTokens = near-expiry → triggers refresh / doRefresh: 2nd loadTokens = still near-expiry / ensureFreshToken post-refresh: 3rd loadTokens = fresh token") documents internal call ordering that the test depends on. If `ensureFreshToken` is refactored, this test will break in a way that's hard to debug from the assertion alone. Worth replacing the call-count gymnastics with `mockImplementation((env, provider) => { /* return token based on test phase */ })` and a `let phase = "before-refresh"` flag.
- **m9.** Duplicate `mintToken` helper between `tests/auth/auth.test.ts:34-57` and `tests/routes/auth/tidal.test.ts:42-51`. Once a third route test wants a JWT, factor into `tests/_utils/mint.ts`. Not now.
- **m10.** `db/schema.sql:25` — `expires_at TIMESTAMPTZ` (nullable) on `provider_tokens`. The OAuth flows always set `expires_at = now() + expires_in*1000`, so it's never null in practice. Spec F-004 §"Database schema" shows it as `NOT NULL`. Schema and code are in soft drift; the schema.sql nullability is more permissive than what the code emits. Consider tightening to `NOT NULL` in the next migration on the empty table.

---

## Worker compatibility audit

- `import` statements: only `hono`, `jose`, `@neondatabase/serverless` (npm) and project-relative paths. **No `pg` driver, no `node:*` modules.**
- All crypto via `crypto.subtle` (SHA-256 digest in PKCE) and `crypto.getRandomValues` (state and verifier). Matches Sprint 1.
- `Buffer.from()` used in `src/db/provider_tokens.ts:39` for bytea binding — supported under `nodejs_compat` (already enabled).
- All tests pass under `@cloudflare/vitest-pool-workers@0.5.41`; no Node-only behaviour leaks.
- `npx tsc --noEmit` passes clean (exit code 0).
- 134/134 tests pass in 4.11s.

PASS on Worker compatibility.

---

## Security audit (per task brief item F)

| Check | Result |
|---|---|
| **No console.* leaks of tokens, codes, secrets, or code_verifier** in `src/providers/*` and `src/auth/*` | PASS — only two `console.*` calls in `src/`: `secrets.ts:36` (logs static reason string, no secret value) and `tidal/client.ts:61` (logs URL only). Verified by `grep -rn "console\." src/`. T-002-15 and T-001-11 canary tests both pass. |
| **PKCE S256 base64url** (no `+`, `/`, `=`) | PASS — `src/providers/spotify/oauth.ts:24-27`: `b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "")`. Tidal `oauth.ts:26-29` and `35-38` both apply the same replace chain. |
| **PKCE challenge = base64url(SHA-256(verifier))** | PASS — both providers use `crypto.subtle.digest("SHA-256", ...)` and base64url-encode. |
| **State entropy ≥ 256 bits from CSPRNG** | PASS — both providers call `crypto.getRandomValues(new Uint8Array(32))` (256 bits). T-002-02 and T-003-02 unit-assert. Note: Tidal uses hex-encoding instead of base64url (`oauth.ts:18-22`); also 256-bit entropy, just longer. Spec doesn't mandate encoding format, only entropy. |
| **State uniqueness** | PASS — T-002-03 asserts 100-of-100 distinct; Tidal route-test asserts 10-of-10. CSPRNG collision probability for 256-bit values is cryptographically negligible. |
| **Refresh coalescing key is provider-scoped, not global** | PASS for Tidal (`Map<string, Promise<void>>` with key `"tidal"`); PASS-WITH-BUG for Spotify (the Map is provider-scoped, but the 401 path bypasses the Map check — see M1). |
| **Only one refresh in flight per provider** | PASS for Tidal; PARTIAL for Spotify (M1). |
| **401-retry is one-shot, not unbounded** | PASS for both. Spotify `oauth.ts:227-242` has no inner retry loop; Tidal `client.ts:32-39` is also single-shot. |
| **Redirect URIs come from env vars (R9 / R10)** | PASS — `env.SPOTIFY_REDIRECT_URI` and `env.TIDAL_REDIRECT_URI`. Tests use the production value `https://portage.eovidiu.co.uk/auth/{provider}/callback`. |
| **`oauth_state` consumed atomically** | PASS — `src/db/oauth_state.ts:30-35` uses single `DELETE … RETURNING`, asserted by T-004b-05 (test asserts both `delete` and `returning` keywords in SQL). |
| **`oauth_state` purged of expired rows on every callback** | PASS — `src/providers/spotify/oauth.ts:90` calls `purgeExpiredOAuthState` first thing in `handleCallback`. **Tidal does NOT call it** — `src/providers/tidal/oauth.ts:exchangeCode` skips the purge. F-002-R4 mandates "The `oauth_state` table MUST be purged of expired rows on every callback handler invocation." F-003 has no parallel R4 explicitly, but it inherits the same `oauth_state` table and the spec is silent. The atomic `consumeOAuthState` (`oauth_state.ts:30-35`) only deletes the row if `expires_at > now()`, so expired rows for state values nobody is replaying just sit in the table forever. **Minor — not flagged as M because F-003 spec doesn't explicitly require it; arguably a Sprint-3 cleanup chore via a scheduled cron purge instead.** |
| **GCM IV separation** | PASS — F-004b `provider_tokens.ts:23-24` calls `encryptToken` twice; each call generates a fresh IV via `crypto.getRandomValues(new Uint8Array(12))`. T-004b-01 asserts `Buffer.compare(accessIv, refreshIv) !== 0`. |
| **Plaintext tokens not in any log** | PASS — verified via grep + T-002-15 canary + T-001-11 canary. The Tidal `client.ts:61` warning logs the URL; URLs may include query params but the implementation never puts the token in the URL — the access token only ever appears in the `Authorization` header. |

Overall: **PASS with one fixable logic bug (M1) and one minor consistency gap (Tidal callback doesn't purge expired state — see Tidal spec note above).**

---

## DB-vs-spec / schema audit

The task brief asked for `mcp__Neon__describe_table_schema` of `provider_tokens` and `oauth_state` against the live Neon project `square-wave-04443485`. The reviewer attempted this and was denied by the permission system as "scope escalation beyond the read-only review task" — Neon MCP is gated for this reviewer's role.

Falling back to `db/schema.sql` (lines 18-27 for `provider_tokens`, 97-102 for `oauth_state`), which carries the comment `-- Last applied to project square-wave-04443485 on 2026-04-25 (updated C1+C2 fix)` and was modified in commit `bd013a8` (the Sprint 1 C1+C2 fix wave). Comparing against the F-004 spec §"Database schema" (lines 73-84 of `docs/specs/F-004-token-encryption.md`):

| Column | F-004 spec | db/schema.sql | F-004b code (`provider_tokens.ts`) | Match |
|---|---|---|---|---|
| `provider` | `TEXT PRIMARY KEY` | `TEXT PRIMARY KEY` | uses as `$6` insert and `$1` lookup | yes |
| `access_token_ciphertext` | `BYTEA NOT NULL` | `BYTEA NOT NULL` | inserts `Buffer.from(atCt)` | yes |
| `access_token_iv` | `BYTEA NOT NULL` | `BYTEA NOT NULL` | inserts `Buffer.from(atIv)` | yes |
| `refresh_token_ciphertext` | `BYTEA NOT NULL` | `BYTEA NOT NULL` | inserts `Buffer.from(rtCt)` | yes |
| `refresh_token_iv` | `BYTEA NOT NULL` | `BYTEA NOT NULL` | inserts `Buffer.from(rtIv)` | yes |
| `expires_at` | `TIMESTAMPTZ NOT NULL` | `TIMESTAMPTZ` (nullable!) | always sets it | **soft drift — m10** |
| `status` | `TEXT NOT NULL DEFAULT 'active' CHECK (...)` | `TEXT NOT NULL DEFAULT 'active' CHECK (...)` | sets `'active'` on UPSERT, `'revoked'` on `markRevoked` | yes |
| `updated_at` | `TIMESTAMPTZ NOT NULL DEFAULT now()` | `TIMESTAMPTZ DEFAULT now()` (nullable per syntax) | sets via `now()` | minor schema relax |

`oauth_state` table (not in F-004 spec — defined per F-004b discovery; schema.sql lines 97-102):

| Column | schema.sql | code (`oauth_state.ts`) | Match |
|---|---|---|---|
| `state` | `TEXT PRIMARY KEY` | `$1` insert and lookup | yes |
| `code_verifier` | `TEXT NOT NULL` | `$2` insert | yes |
| `expires_at` | `TIMESTAMPTZ NOT NULL` | `$3` insert; `> now()` lookup | yes |
| `created_at` | `TIMESTAMPTZ NOT NULL DEFAULT now()` | not referenced (default applies) | yes |

Code↔schema match. Spec↔schema has only the `expires_at` and `updated_at` nullability soft drift noted in m10.

If Ovidiu wants the live-Neon confirmation that I couldn't run, the trivial check is one psql command: `\d provider_tokens` and `\d oauth_state` against `square-wave-04443485.production`. The schema.sql comment claims it was applied; the Sprint 1 close-out commit `b5841e1` lists this as resolved. I have no reason to believe the live schema diverges, but flagging this confirmation gap in case it matters for compliance.

---

## Spec coverage matrix

### F-001 (11 MUSTs)

| MUST | Test ID(s) | Covered? |
|---|---|---|
| F-001-R1  HS256 + JWT_SECRET signature validation | T-001-05 | yes |
| F-001-R2  Reject expired tokens | T-001-06 | yes |
| F-001-R3  Reject wrong issuer | T-001-07 | yes |
| F-001-R4  Reject sub not in allowlist `["owner"]` | T-001-08 | yes |
| F-001-R5  No JWT/secret in logs | T-001-11 | yes (canary) |
| F-001-R6  Single Hono `use()` middleware on all auth routes | `src/index.ts:14`, T-001-12, T-001-13 | yes (one `use` covers all; skip-list excludes /healthz, /readyz, /auth/{prov}/callback) |
| F-001-R7  Bootstrap script refuses < 32-byte secret | T-001-01 | yes |
| F-001-R8  Verification < 5 ms p95 | T-001-10 | **deferred** (Sprint-3 e2e harness — `features.json` notes this; consistent with `claude-progress.txt`) |
| F-001-R9  401 body is `{"error": <code>}` | covered across T-001-03..08 | yes |
| F-001-R10 `subject` attached to ctx | T-001-09 | yes |
| F-001-R11 Query-param tokens MUST NOT be accepted | T-001-14 | yes |

Plus secrets-validation tests (F-004-R5 absorbed per Sprint 1 D2): three additional tests in `auth.test.ts:286-331` cover JWT_SECRET length, TOKEN_ENCRYPTION_KEY length, and TOKEN_ENCRYPTION_KEY base64 validity. PASS.

Unmapped: R8 (deferred to e2e). PASS otherwise.

### F-002 (11 MUSTs)

| MUST | Test ID(s) | Covered? |
|---|---|---|
| F-002-R1  Authorization Code with PKCE (S256) | T-002-01 (asserts `code_challenge_method=S256`); PKCE-tests `oauth.test.ts:97-120` | yes |
| F-002-R2  Only `user-library-read` scope | T-002-01 (asserts `scope=user-library-read`) | yes |
| F-002-R3  State ≥ 256 bits CSPRNG | T-002-02 + T-002-03 (entropy + uniqueness) | yes |
| F-002-R4  Purge expired `oauth_state` on every callback | `oauth.test.ts:165-172` ("purges expired before checking") + route-test `spotify.test.ts:128-132` | yes |
| F-002-R5  No tokens/codes/verifier in logs | T-002-15 (multi-canary: SPSECRETCANARY, ATCANARY, RTCANARY, code_verifier) | yes |
| F-002-R6  Refresh when < 60 s remain | T-002-10 (30 s) + T-002-11 (7200 s no-refresh) | yes |
| F-002-R7  Concurrent refresh coalesced | T-002-12 (5 concurrent → 1 fetch) | partial — see M1 (401 path bypasses Map check) |
| F-002-R8  New refresh_token persisted if returned | covered implicitly by `oauth.ts:179` `data.refresh_token ?? tokens.refreshToken` and the route-test success path | yes (no dedicated test; the implicit assertion is "doRefresh sees the rotated token") |
| F-002-R9  redirect_uri matches Spotify dashboard | T-002-01 + route-test `spotify.test.ts:79-81` (asserts the literal value) | yes (test against env var, not against Spotify dashboard — the only way to verify the latter is OAuth handshake itself) |
| F-002-R10 All requests include `Authorization: Bearer <at>` and `User-Agent` | `spotifyFetch` sets both at `oauth.ts:222-223` and `239-240`. T-002-14 implicitly exercises (via 200 response). No direct header assertion. | partial — implementation has it; no test snapshots the User-Agent header value |
| F-002-R11 401 → one refresh + one retry | T-002-14 (asserts target endpoint hit exactly twice) | yes |

Unmapped/partial: R7 (M1), R10 (no User-Agent assertion). PASS otherwise.

### F-003 (11 MUSTs)

| MUST | Test ID(s) | Covered? |
|---|---|---|
| F-003-R1  Authorization Code with PKCE (S256) | T-003-01 ("includes code_challenge_method=S256"), `oauth.test.ts:111-115` | yes |
| F-003-R2  Scopes from Tidal Developer Portal, sourced from constants | TIDAL_SCOPES in `scopes.ts` (with TODO for Ovidiu); T-003-01 ("includes all configured scope strings") | partial — the TODO is properly placed; reviewer cannot verify against Tidal portal per task brief |
| F-003-R3  State ≥ 256 bits CSPRNG | T-003-02 (entropy: hex string ≥ 64 chars × 4 bits/char ≥ 256 bits) | yes |
| F-003-R4  No secrets/codes in logs | implicit — only console.warn in `client.ts:61` (URL, no token); no canary test exists for Tidal yet | partial — no direct T-003-15-equivalent canary test |
| F-003-R5  Refresh when < 60 s remain | T-003-05 (`needsRefresh` unit + `tidalFetch` proactive refresh test) | yes |
| F-003-R6  Concurrent refresh coalesced | T-003-06 (5 concurrent → 1 fetch) | yes (Tidal coalescing is correct in both paths, unlike Spotify) |
| F-003-R7  Required headers on Tidal API calls | T-003-04 (Authorization, accept v1+json, countryCode); `client.test.ts:317-338` (Content-Type for POST) | yes |
| F-003-R8  countryCode on every catalog request | T-003-04 + `client.test.ts:99-117` | yes (sourced from `env.TIDAL_COUNTRY_CODE` with fallback `"RO"`) |
| F-003-R9  401 → one refresh + one retry | T-003-09 | yes |
| F-003-R10 redirect_uri matches Tidal portal | route-test `tidal.test.ts:73-79` indirectly; not a runtime check | yes (against env var, not portal — same caveat as F-002-R9) |
| F-003-R11 v2 media-type tolerance: warn, don't crash | T-003-10 | yes |

Unmapped/partial: R2 (Ovidiu to verify scopes), R4 (no canary test — recommend mirroring T-002-15), and the bug in M2 (refresh failure semantics).

### F-004b (derived from amended F-004 §"Database schema" + acceptance criteria)

F-004 itself was amended per Sprint 1 D1: persistence helpers were moved to F-004b. F-004b's "MUSTs" derive from:

| Derived MUST | Test ID(s) | Covered? |
|---|---|---|
| Encrypt access + refresh tokens with separate IVs before INSERT | T-004b-01 (asserts IV byte-length 12 + IVs differ) | yes |
| UPSERT on `provider` PK | T-004b-01b (asserts SQL contains `on conflict`) | yes |
| Plaintext tokens MUST NOT be present in ciphertext bytes (I-003) | T-004b-01 (asserts `ciphertext.toString()` does not contain plaintext) | yes |
| `loadTokens` round-trips encrypted bytes back to plaintext | T-004b-02 | yes |
| `loadTokens` returns null when no row exists | T-004b-02b | yes |
| `loadTokens` returns row with `status='revoked'` (caller's job to handle) | T-004b-02c | yes |
| `markRevoked` sets `status='revoked'` for the correct provider | T-004b-03 | yes |
| `oauth_state` INSERT shape | T-004b-04 | yes |
| `oauth_state` consume is atomic (single `DELETE … RETURNING`) | T-004b-05 | yes |
| `oauth_state` returns null for unknown/expired state | T-004b-06 | yes |
| `purgeExpiredOAuthState` deletes only expired rows | T-004b-07 | yes |

PASS, all derived MUSTs covered. Test IDs follow the same `T-{spec}-{NN}` convention used in Sprint 1.

---

## Outstanding decisions for the lead

### D1. Sprint-3 fix wave for M1+M2+M3 vs roll into F-005/F-006 work?

- M1 (Spotify 401 R7 hole) and M2 (Tidal revoke-on-any-non-OK) are both ~10-line bug fixes scoped to `src/providers/{provider}/oauth.ts`.
- M3 (F-002 coverage gap) is two one-line tests and a `features.json` correction.
- **Recommendation**: dedicated 30-minute fix wave at the start of Sprint 3, before F-005 starts pulling Spotify tracks (which will exercise the refresh paths under load). Spawn the F-002 and F-003 teammates to fix their own bugs (per Sprint-1 Meta-Pattern: "reuse existing teammates for fix waves"). Lead reviews the diff and updates `features.json`.

### D2. Make M5 (route-pattern asymmetry) a fix-wave item or accept as-is?

- The asymmetry doesn't break anything today. Both subtrees have full test coverage at their declared paths.
- The cost of fixing now: 5-line edit, 0 test changes (route paths in tests are absolute, not router-relative).
- The cost of fixing later: doubles when F-005..F-013 add more route modules and reviewers have to keep checking which pattern this one uses.
- **Recommendation**: fix now in the same Sprint-3 fix wave. Pick option A (sub-router knows its provider name) so all `/auth/<provider>` mount points are uniform `app.route("/auth", providerAuthRoutes)`.

### D3. Replace mocked F-002/F-003 → F-004b integration with a Neon-branch integration test (M4)?

- Sprint 1 D5 is already on the docket for this. The need is now stronger because F-002 and F-003 both depend on F-004b at runtime, and no test exercises the real composition.
- Cost: ~80 LOC + 10s/test against a Neon branch (Neon MCP `create_branch` + `apply_schema` + `delete_branch` per test).
- Payoff: catches drift between F-002/F-003 expectations and F-004b implementation; closes the same bug class that produced Sprint 1 C1.
- **Recommendation**: Sprint 3, single ticket "F-Integ: integration test for Spotify+Tidal OAuth + F-004b". Co-located with F-005 since F-005 will need a similar integration shape.

### D4. T-003-04-equivalent canary test for Tidal (mirror T-002-15)?

- F-002 has T-002-15 (multi-canary "no secrets in logs"). F-003 does not. The grep audit shows there's nothing to leak today (only the URL warning), but as F-005..F-008 add features that consume Tidal tokens, this test is the canary for any regression.
- Cost: ~30 LOC, copy-and-modify from T-002-15.
- **Recommendation**: add it in the Sprint-3 fix wave alongside M1/M2/M3.

### D5. Live-schema verification against Neon `square-wave-04443485`?

- Reviewer was denied permission to run `mcp__Neon__describe_table_schema`. db/schema.sql claims it was applied; nothing in the commit history contradicts this; tests don't hit the live DB.
- If Ovidiu wants belt-and-braces confirmation, a one-time `\d provider_tokens` and `\d oauth_state` from psql settles it. No code change required either way; this is purely a verification gap.

### D6. Worktree isolation didn't materialize — is this a harness bug to file?

- Per task brief item D, all three Sprint-2 implementer teammates (`f004b`, `spotify`, `tidal`) reportedly spawned with `isolation: "worktree"` but `git worktree list` shows only the main worktree. All three landed commits directly on `main` with no merge step.
- Net effect was benign: each teammate stayed in its declared scope (verified — `src/db/`, `src/providers/spotify/` + `src/routes/auth/spotify.ts`, `src/providers/tidal/` + `src/routes/auth/tidal.ts`). No conflicts. No cross-touches.
- But the safety property worktree isolation was supposed to provide (mechanical scope enforcement, no contamination across teammates) didn't fire.
- **Recommendation**: file a harness issue ("worktree isolation flag silently ignored — all teammates ran on main"). Sprint 3 should either confirm worktree isolation actually works on a test team or stop requesting it in spawn prompts to avoid a false sense of security. **No Sprint-2 deliverable affected.**

### D7. Should `F-002` features.json status remain "passing" given the 89.58% coverage shortfall (< 95% gate)?

- CLAUDE.md "Testing Standards" is explicit: "For harness projects: coverage >= 95% on code touched during the feature. Features aren't done until features.json has status: 'passing', test_file points to a test, and coverage meets threshold."
- Strict reading: F-002 is **not** done; status should be `failed` or `in-progress` until the gate is met.
- Soft reading: every functional MUST is tested; the gap is on uncovered defensive code that can/should be removed under the "no defensive code that can't happen" rule. Total real test gap is 2 lines.
- **Recommendation**: keep status `passing` **only after** the M3 fix wave lands. If the lead doesn't want to gate this sprint on the fix wave, change status to `in-progress` and create a follow-up task. Either is defensible; silently leaving status at `passing` with a documented gate failure is not.

---

## Sprint 2 retrospective input

### What worked well

- **Wave-by-wave parallelism per Sprint-1 Meta-Pattern**: F-001 first (single teammate), then F-002 + F-003 + F-004b in parallel. F-001 unblocked the others by providing the middleware import surface. No teammate sat idle waiting for blockers.
- **Stub-then-replace pattern for F-002/F-003 dependence on F-004b**: Lead's pre-commit `7aaff41` (stub interfaces) let Spotify/Tidal teammates `import` and `vi.mock` the F-004b functions while F-004b implemented in parallel. Net: three teammates ran fully concurrent on three modules touching the same import graph. This is a reusable pattern — call it the "lead-stub interface" pattern in `context_summary.md` Patterns.
- **F-003 quality bar exceeded F-002**: same model (Sonnet), same sprint, same scope shape. F-003 hit 100% on `oauth.ts` and 100% on the route; F-002 hit 89.58% on `oauth.ts` and 92.85% on the route. The difference was rigor on test count (23 vs 21) and scope (Tidal added a deliberate `client.ts` separation that's easier to test in isolation; Spotify's `oauth.ts` mixes initiate/callback/refresh/spotifyFetch in one file). Worth a Meta-Pattern: **prefer one file per concern over one file per provider**.
- **No defensive console fallbacks for token leaks**: The grep audit found exactly two `console.*` calls in `src/`, both intentional and safe. The TDD canary tests (T-001-11, T-002-15) are mechanical guards, not just spec compliance.
- **F-004b atomic state consume** (`DELETE … RETURNING`) is exactly the right primitive for a CSRF-defense-grade state store. T-004b-05 asserts the SQL keywords directly so a refactor that splits SELECT-then-DELETE breaks the test. This is good test design for invariants that are easy to silently regress.

### What slowed teammates down (or should have)

- **F-002 teammate's coverage tooling claim**: The `features.json` notes blame the istanbul/Workers sandbox for the coverage gap, but F-003 ran on the same tooling and measured cleanly. This is the same class of error as Sprint 1's F-014 "coverage unmeasurable" claim, which Sprint 1 also caught. Two sprints in a row, the same incorrect-tooling-blame pattern. **Sprint-3 spawn prompts should require teammates to paste real coverage numbers (not "n/a" or "tooling unreliable") OR cite the exact istanbul error message that prevents measurement.** Treat "tooling problem" as a claim that must be proven, not accepted.
- **No T-003 secrets canary test**: Spotify has T-002-15. Tidal doesn't have T-003-15. The Tidal teammate's test count (23) and rigor were strong, but missed this one. Spawn prompts should explicitly enumerate which T-NNN tests are MUSTs and which are MAYs.
- **Worktree isolation false sense of security** (see D6): the lead asked for isolation, the harness silently dropped it, no teammate noticed because they all stayed in lane voluntarily. If a teammate had touched a shared file, this would have been a Sprint 2 blocker. We got lucky.
- **Spotify and Tidal made different OAuth-correctness choices** with no cross-team coordination: Spotify discriminates `400 invalid_grant` for revoke (correct); Tidal revokes on any non-OK (incorrect, M2). Both implementations passed their own tests. A 5-minute lead checkpoint between F-002 and F-003 implementations on "what does refresh-failure semantics look like" would have caught this. Worth adding to the spawn prompt for symmetric features ("read the sibling provider's implementation before finalizing yours").

### Recommendations for Sprint 3 spawn prompts

1. **Coverage gate is non-negotiable**: spawn prompt must require `coverage` field in features.json to be the literal istanbul output (not "n/a", not "tooling unreliable"). If the gate isn't met, the teammate must either close the gap or document each uncovered line per the classification table format used in this review.
2. **For symmetric features (e.g., F-005 Spotify-liked + future F-008 Tidal-write)**, spawn prompt must include "read the sibling provider's implementation in src/providers/{other}/ before finalizing yours" to catch correctness drift like M2.
3. **Always add a no-secrets-in-logs canary test for any feature that touches credentials.** Make it a checklist item in the spawn prompt template.
4. **Drop the worktree isolation flag from spawn prompts** until the harness bug is fixed (D6). Replace with explicit scope enforcement via `.claude/teammate-scope.txt` (per agent-teams-protocol.md "Mechanical Scope Enforcement").
5. **Lead-stub interface pattern** (today's `7aaff41`) is reusable; document it in `context_summary.md` Patterns section. When N teammates need the same interface module, the lead should pre-commit stubs rather than serializing or having one teammate own it.
6. **Add a per-sprint integration test gate**: Sprint 3 should ship F-Integ before any net-new feature, to close the F-002/F-003 → F-004b mock gap from M4.

---

## Summary for the lead (one paragraph)

Sprint 2 ships every applicable behavioural MUST across F-001/F-002/F-003/F-004b, with 134/134 tests passing, clean tsc, no secret leaks, no Node-API contraband, and correct PKCE/CSPRNG/coalescing primitives. Two real bugs need a Sprint-3-opening fix wave (M1: Spotify's 401 retry path silently bypasses the R7 refresh-coalescing Map check; M2: Tidal's refresh path marks tokens revoked on any non-OK response, including 5xx blips, which would punt users out of the system on transient infra issues). One process bug needs cleanup (M3: F-002's "coverage tooling unreliable" claim is wrong — F-003 measured cleanly on identical tooling — the real Spotify gap is 89.58% on oauth.ts and 92.85% on the route, fixable with two one-line tests). Two cleanups are owed (M4: Sprint-3 integration test for the OAuth ↔ persistence path, identical to Sprint 1 D5; M5: harmonize the route-pattern asymmetry in src/index.ts). The Tidal scope TODO is properly placed and surfaces clearly — Ovidiu owns the verification against the Tidal Developer Portal. Worktree isolation didn't fire (all teammates ran on main); no Sprint-2 deliverable was affected, but the harness should be debugged before Sprint 3 relies on isolation. Recommended action: 30-minute Sprint-3-opening fix wave (M1 + M2 + M3 + M5 + D4 canary), then proceed to F-005.
