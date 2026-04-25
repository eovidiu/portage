# Sprint 1 Review (2026-04-25)

Reviewer: Opus, read-only, single deliverable.
Sprint scope: project scaffold, Neon schema, F-014 health endpoints, F-004 token encryption.
Commits in scope: `f00da29 .. e06e3a5` (6 commits on `main`).

---

## Verdict

**BLOCK-AND-FIX** — one critical correctness bug that will surface the moment OAuth tokens are minted, and one critical schema/spec divergence that affects both `/readyz` and the F-004 contract.

The cryptographic core (F-004) is genuinely excellent: clean Web Crypto usage, correct algorithm, IV handling, error model, and 100% real coverage. The /healthz endpoint is correct. /readyz is well-shaped but its database query references a column (`provider_tokens.status`) that does not exist in either the committed `db/schema.sql` or the live Neon database — at the first real call it will throw and the readiness probe will permanently report "database: false" until the schema is amended.

Once the schema is fixed and the F-004 spec is reconciled with the architecture diagram, this is shippable.

---

## Per-task verdict

- Task #1 — Worker scaffold:           **PASS-WITH-NOTES** (compat-date warning, two unused devDeps to prune later)
- Task #2 — Neon schema + db/schema.sql: **FAIL** (missing `provider_tokens.status` column; missing per-token IVs per F-004-R8)
- Task #3 — F-014 /healthz + /readyz:    **PASS-WITH-NOTES** (logic correct, but depends on the missing `status` column → runtime failure once exercised against live DB)
- Task #4 — F-004 token encryption:      **PASS-WITH-NOTES** (helpers are correct and well-tested; spec-mandated `persistTokens` / `loadTokens` are intentionally deferred — see Outstanding decisions)

---

## Coverage report

`npm run test:coverage` runs cleanly under `@cloudflare/vitest-pool-workers@0.5.41` with the `istanbul` provider. Output:

```
Test Files  4 passed (4)
     Tests  27 passed (27)

% Coverage report from istanbul
-------------------|---------|----------|---------|---------|
File               | % Stmts | % Branch | % Funcs | % Lines |
-------------------|---------|----------|---------|---------|
All files          |   98.84 |       92 |   93.84 |   99.59 |
 src               |      75 |      100 |       0 |     100 |
  index.ts         |      75 |      100 |       0 |     100 |
 src/crypto        |     100 |      100 |     100 |     100 |
  decrypt.ts       |     100 |      100 |     100 |     100 |
  encrypt.ts       |     100 |      100 |     100 |     100 |
  key.ts           |     100 |      100 |     100 |     100 |
 src/routes        |   97.43 |    94.11 |   85.71 |   97.22 |
  health.ts        |   97.43 |    94.11 |   85.71 |   97.22 |  (line 57 uncovered)
-------------------|---------|----------|---------|---------|
```

Reconciliation with `features.json`:

| Feature | Claim                                | Actual                                  | Verdict |
|---------|--------------------------------------|-----------------------------------------|---------|
| F-004   | `coverage: 100`                      | crypto/* exactly 100/100/100/100        | match   |
| F-014   | `coverage: "n/a — pool does not support coverage"` | health.ts 97.43 stmts / 94.11 branch / 85.71 funcs / 97.22 lines, fully measurable | **mismatch — F-014's coverage claim is wrong** |

The F-014 teammate either ran the wrong command or hit the v8-vs-istanbul provider issue and concluded the gate was unsupported. With the istanbul provider already in `vitest.config.ts`, coverage works for both features. The coverage tooling discrepancy flagged in `context_summary.md` is **resolved**: the gate is operational; F-014 should record the actual numbers above. Both features clear the 95% statement gate; F-014's `% Funcs` (85.71) is below 95% but is an artifact of istanbul counting Hono's anonymous handler factories — every functional path is exercised. Recommend recording `97.43% stmt / 94.11% branch / 97.22% line` for F-014 and treating the function-count metric as informational.

The `index.ts` 75% statement number is also an istanbul artifact (the `scheduled` handler exists but is not exercised by Sprint 1 tests — it is the F-010 implementation hook). Acceptable for now; will rise once F-010 lands.

The single uncovered line in `health.ts` (line 57) is the second `controller.signal.addEventListener` rejection branch — a defensive race-condition guard on the token-fetch query that the unit tests cannot trigger because `mockSql` resolves synchronously. Acceptable; could be removed under the "no defensive code that can't happen" rule, but harmless.

`@vitest/coverage-v8` in `devDependencies` can be safely removed — the istanbul provider is in use and v8 is incompatible with the Workers sandbox (it imports `node:inspector`). One commit, one line change.

---

## Critical issues (must fix before next sprint)

### C1. `provider_tokens` is missing the `status` column required by `/readyz`
- `src/routes/health.ts:54` issues: `SELECT provider, status FROM provider_tokens WHERE provider IN ('spotify', 'tidal')`
- Live Neon schema (verified via `mcp__Neon__describe_table_schema`): columns are `provider, access_token_ciphertext, refresh_token_ciphertext, iv, expires_at, updated_at`. No `status`.
- Committed `db/schema.sql:16-23`: same omission.
- F-014-R5 mandates `/readyz` MUST check `provider_tokens.status` for both providers; F-004 spec §"Database schema" defines `status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked'))`.
- Why the unit tests don't catch it: `tests/routes/health.test.ts` mocks `@neondatabase/serverless` and feeds back `[{provider:'spotify',status:'active'},...]` directly, bypassing the real query. The mock contract was authored against the spec; the code matches the mock; the schema does not match either.
- **Impact**: at the first real call the `SELECT` throws (`column "status" does not exist`), the catch block sets `dbOk = false`, /readyz permanently reports `{database:false}` even when the database is fine. The bug is silent under tests, fatal in production.
- **Fix**: add `status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked'))` to `provider_tokens` in both `db/schema.sql` and the live DB; or temporarily remove the `status` filter from the readiness query and document it as deferred until F-002/F-003 land. The first option is correct per spec.

### C2. `provider_tokens` IV columns do not match F-004-R8
- F-004-R8: "The Postgres columns for ciphertext and IV MUST be `bytea`" — and the F-004 behavioural spec ("Persist tokens") explicitly lists separate columns `access_token_iv` and `refresh_token_iv`, with the rationale that each encryption operation generates a fresh IV (F-004-R3) and the two tokens must be encrypted **independently**.
- `db/schema.sql:20` and live DB collapse them into a single `iv BYTEA` column.
- This contradicts both the F-004 feature spec and the F-004 acceptance criteria ("encrypts each token independently (separate IVs)").
- Note: `docs/architecture.md:140-147` ER diagram also shows a single `iv` — so the **specs themselves disagree**. F-004 is the authoritative feature spec; architecture.md is wrong here. Per project rule "Spec-first: deviations from `docs/` require updating the spec before code", the architecture diagram should be updated to match F-004 (separate columns), and the schema brought in line.
- **Impact**: as soon as F-002/F-003 ship, the persist code will either (a) reuse one IV across both tokens — **a security bug, since GCM IV reuse with the same key is catastrophic**, or (b) need a second column added under emergency. Best to fix now.
- **Fix**: rename `iv` → drop it; add `access_token_iv BYTEA NOT NULL` and `refresh_token_iv BYTEA NOT NULL`. Update architecture.md ER diagram in the same commit. Apply via Neon MCP migration (table is empty).

---

## Major issues (should fix soon)

### M1. F-014 coverage claim in `features.json` is inaccurate
- `features.json` records `"coverage": "n/a — @cloudflare/vitest-pool-workers does not support coverage instrumentation"`.
- This is false — see Coverage report above. Recommend updating to the real numbers (97.43 stmts, 97.22 lines, 94.11 branch).

### M2. `/readyz` returns 200 in the bootstrap state when no tokens exist
- `src/routes/health.ts:75`: `tokensOk = tokens.spotify !== "revoked" && tokens.tidal !== "revoked"` — the missing/empty case is treated as ready.
- Test `tests/routes/health.test.ts:222` ("returns 200 when no provider_tokens rows exist") asserts this behavior intentionally as the bootstrap state.
- F-014's behavioural spec section "Readiness, all green" says ready requires "**both providers have non-revoked tokens**" — strict reading: missing ≠ active, so ready should be 503 with `tokens.spotify = "missing"`.
- This is a **judgment call** the implementer made to keep `/readyz` green during bootstrap (otherwise the very first deploy reports unready forever, breaking uptime monitoring during initial OAuth setup). Reasonable, but it diverges from the literal spec and is not documented.
- **Recommend**: pick one — (a) tighten the code and add a `?bootstrap=true` query escape hatch, or (b) keep the lenient behaviour and amend the F-014 spec to add a "Readiness, bootstrap" case. Document the choice in `context_summary.md`.

### M3. `/readyz` lacks an explicit `SELECT 1` with the documented 2-second timeout
- F-014-R3 mandates `/readyz` MUST execute a `SELECT 1` against the database with a 2-second timeout.
- Implementation does run `sql\`SELECT 1\`` (`health.ts:44`) and races it against an `AbortController` timer set to `DB_TIMEOUT_MS = 2000`. Good.
- However the `AbortController` is never wired into the `neon` driver — `controller.abort()` does not actually cancel the in-flight HTTP request to Neon, it just causes the race-Promise to reject. The pending DB call leaks until Neon responds. Not a correctness bug for /readyz (the response goes out on time), but it's a resource leak per request when the DB is slow, and the `controller.signal.addEventListener` pattern is misleading: it suggests cancellation that does not happen.
- **Recommend**: simplify to `Promise.race([sql\`SELECT 1\`, new Promise((_, r) => setTimeout(() => r(new Error("DB timeout")), DB_TIMEOUT_MS))])`. Drop the `AbortController` plumbing; document that the leaked promise is discarded.

### M4. F-004 module exports a `loadKey` alias for `importKey`
- `src/crypto/index.ts:4`: `export { IntegrityError, importKey as loadKey } from "./key";`
- F-004-R10: "The helper module MUST expose only four functions: `encryptToken`, `decryptToken`, `persistTokens(provider, ...)`, `loadTokens(provider)`. **No other token-handling functions.**"
- `loadKey` is an internal helper that has no business being part of the module's public surface. It is also not used anywhere outside `encrypt.ts`/`decrypt.ts`.
- **Recommend**: remove the `loadKey` re-export. `IntegrityError` re-export is fine — callers need the type to catch it.

### M5. Test mock contract drifted from real schema
- The `health.test.ts` mock returns `[{provider:'spotify',status:'active'}]`-shaped rows. That mock was built from the spec, not the schema, and the divergence between spec and schema is precisely what hid C1.
- This is a process issue, not a code issue — but it's worth flagging as a gotcha in `context_summary.md`: **mocks built from specs can mask schema/spec mismatches**. Recommend an integration test that runs against a Neon branch (Neon MCP `create_branch` → apply schema → run readyz against real DB → delete branch) once F-002/F-003 land. Listed under "Outstanding decisions" so it doesn't block Sprint 1.

---

## Minor issues (style, polish)

- **m1.** `package.json:23-24`: both `@vitest/coverage-v8` and `@vitest/coverage-istanbul` listed. v8 is unused and incompatible with Workers (per `context_summary.md` Gotchas). Drop v8.
- **m2.** `wrangler.toml:3` requests `compatibility_date = "2026-04-25"`; installed wrangler 3.99.0 caps at `2024-12-30` and warns on every test run. Either pin to `2024-12-30` until wrangler is upgraded, or upgrade wrangler. Production deploys honour the requested date, so it's only a local-dev annoyance — but the four warning lines on every `npm test` are noise. Pin date is the lower-risk fix.
- **m3.** `src/routes/health.ts:54`: the `as unknown as Promise<TokenRow[]>` double cast is a smell. Once the Neon driver is wrapped in a thin typed helper (later sprint), this disappears; for now it's the cleanest available workaround for the driver's dynamic return type.
- **m4.** `src/index.ts:13`: `_event`, `_env`, `_ctx` underscored params for the (empty) scheduled handler. CLAUDE.md says "avoid backwards-compatibility hacks like renaming unused _vars". These are placeholders for F-010, not vestigial — the underscore prefix is the right convention here. Mild rule-tension; no change needed.
- **m5.** `src/crypto/encrypt.ts` and `decrypt.ts` each call `importKey` per operation. For 10,000 round-trips that's 20,000 key imports. The performance test still passes (T-004-14, < 5s for 10k round-trips), so this is "fine" — but caching the imported `CryptoKey` per `keyB64` would be a 2x speedup. Defer until perf becomes an issue.
- **m6.** `db/schema.sql` lacks the `status` column on `provider_tokens` (see C1) and the per-token IV split (see C2). Beyond that, the schema looks well-thought-out: I-001/I-004/I-005 are documented inline, indexes are sensible, FKs are correct.
- **m7.** `db/schema.sql` ER diagram contradiction with `docs/architecture.md` was caught above; the schema for `tracks`, `matches`, `unmatched`, `sync_runs`, `sync_state`, `captures` matches the architecture ER diagram cleanly.

---

## Worker compatibility audit

- No `pg` driver imports anywhere in `src/` or `tests/` — verified by grep.
- No `node:*` imports anywhere in `src/` or `tests/` — verified by grep.
- All crypto via `crypto.subtle` and `crypto.getRandomValues` (Web Crypto, available in Workers).
- DB access via `@neondatabase/serverless` (per ADR-001).
- `nodejs_compat` flag set in `wrangler.toml` (required by `vitest-pool-workers`, per gotcha in `context_summary.md`).
- `npx tsc --noEmit` passes clean.

PASS on Worker compatibility.

---

## Spec coverage matrix

### F-014 (10 MUSTs)

| MUST clause                                              | Test ID(s)        | Covered? |
|----------------------------------------------------------|-------------------|----------|
| F-014-R1  /healthz MUST NOT touch DB                     | T-014-02          | yes (mock-asserted)
| F-014-R2  /healthz MUST NOT require auth                 | T-014-01, T-014-10| yes (no Authorization header set)
| F-014-R3  /readyz MUST run SELECT 1 with 2s timeout      | T-014-09          | partial — timeout asserted; the literal `SELECT 1` is asserted only by reading the source (no test snapshots the SQL)
| F-014-R4  /readyz MUST check all secrets in §9.4         | T-014-04, T-014-07| yes (all 7 secrets enumerated in test fixture)
| F-014-R5  /readyz MUST check provider_tokens.status      | T-014-04, T-014-06| yes in test (mocked) — **fails in production**, see C1
| F-014-R6  /readyz returns 200 only when all green        | T-014-04          | yes
| F-014-R7  /readyz returns 503 + JSON body of failures    | T-014-05/06/07    | yes
| F-014-R8  Neither endpoint exceeds 3s                    | T-014-09 (proxy)  | yes for /readyz under DB hang; /healthz never queries DB so trivially under 3s; T-014-03 wall-clock /healthz <50ms is **deferred** (see Outstanding decisions)
| F-014-R9  /readyz body MUST NOT contain secret/ciphertext| T-014-08          | yes (canary substring assertion)
| F-014-R10 Both endpoints work with broken JWT_SECRET     | T-014-10          | yes

Unmapped MUSTs: none (all 10 covered, with one runtime hole — R5 — covered in test but broken in prod due to schema gap).

Deferred (wall-clock, can't be expressed as vitest units): T-014-03 (p95 /healthz < 50 ms), T-014-11 (max response time < 3 s across 50 mixed requests). Tracked for QA.

### F-004 (11 MUSTs)

| MUST clause                                                   | Test ID(s)      | Covered? |
|---------------------------------------------------------------|-----------------|----------|
| F-004-R1  Cipher MUST be AES-256-GCM                          | T-004-15        | yes (algorithm name + key length asserted)
| F-004-R2  IV MUST be 96 bits (12 bytes)                       | T-004-04        | yes
| F-004-R3  IV MUST be fresh from CSPRNG per encrypt            | T-004-05        | yes (1000 distinct IVs)
| F-004-R4  Key from TOKEN_ENCRYPTION_KEY, 32 bytes after b64   | T-004-10        | yes (16-byte rejection); also exercised by every passing test using a 32-byte key
| F-004-R5  System MUST refuse to start if key missing/wrong    | T-004-09, T-004-10 | partial — `encryptToken("","")` rejection is asserted, but the *startup-time* check (which would prevent the Worker from booting) is not implemented. Today the failure is per-call, not per-boot. Acceptable for v1 since every call validates, but **F-004-R5 literally says "MUST refuse to start"** — a startup-side check (e.g., import-time `loadKey()`) would close the gap. See Outstanding decisions.
| F-004-R6  Plaintext tokens MUST NOT appear in any log         | T-004-13        | **not covered** — T-004-13 is an end-to-end log canary test that requires F-005..F-008 to exist. No log lines are emitted by F-004 today (no `console.log` in `src/crypto/*`), so the invariant holds vacuously. Track for revisit when F-002/F-005 ship.
| F-004-R7  Decrypt failures report generic `token_integrity_failure` | T-004-06/07/08 | yes — `IntegrityError("decryption failed: token_integrity_failure")` thrown in all three failure paths; no IV/ciphertext bytes in the message
| F-004-R8  Postgres columns for ciphertext + IV MUST be bytea  | (schema check)  | partial — bytea yes, but **schema collapses two IV columns into one**, see C2
| F-004-R9  Encryption MUST authenticate (GCM tag verification) | T-004-06        | yes
| F-004-R10 Module MUST expose only the four named functions    | (source check)  | **violated** — `loadKey` is exported (see M4); also `persistTokens`/`loadTokens` are intentionally absent (see Outstanding decisions)
| F-004-R11 Key rotation out of scope for v1                    | (n/a)           | n/a

Unmapped/partial MUSTs: R5 (startup-time check), R6 (vacuous until logging exists), R8 (schema mismatch — see C2), R10 (extra export + missing helpers).

---

## Outstanding decisions for the lead

### D1. Are `persistTokens` and `loadTokens` part of F-004 or deferred to F-002/F-003?
- F-004 spec §"Persist tokens" and §"Read tokens for use" describe these helpers and F-004-R10 lists them in the four required exports.
- The teammate intentionally shipped only `encryptToken` / `decryptToken` and deferred persistence to F-002/F-003 (per `features.json` notes for F-004: *"Pure helper. Web Crypto API is built into Workers; no external library."*).
- **Tradeoff**: persistence requires a live DB connection and the `provider_tokens` table; ergonomically that pairs with the OAuth flows in F-002/F-003. But the feature is not "done" per spec until R10's four functions exist.
- **Recommendation**: keep the deferral but **amend F-004 spec** to scope it as "encryption primitives only", and create a new feature `F-004b: token persistence helpers` (assigned to F-002/F-003 dependencies) that implements `persistTokens` + `loadTokens` and meets the rest of R10. This brings spec and code into alignment per the project's "spec-first" rule. Alternatively, amend F-004 in place to mark the persistence helpers as deferred to a follow-on feature, and add the `F-004b` entry to `features.json`.

### D2. Promote F-004-R5 to a real startup-time check?
- Today: `importKey` is called per encrypt/decrypt, so a missing/wrong-length key causes the *first* token operation to fail, not Worker boot.
- For Sprint 2: add an import-side check (e.g., a module that runs `loadKey(env.TOKEN_ENCRYPTION_KEY)` during Worker init and throws if invalid). The Hono `app.use()` middleware is the cleanest place, gated to run once.
- **Recommendation**: defer to F-001 (auth middleware) — both rely on a startup-time secret-validation pass, so unify them.

### D3. T-014-03 / T-014-11 wall-clock metrics
- Three options on the table: (a) manual QA checklist feature, (b) wrangler-dev-based e2e harness, (c) document as known gap.
- **Recommendation**: (b) for production confidence, but not before Sprint 2 ships F-001/F-002/F-003. Create a feature `F-Q1: e2e harness against wrangler dev` for Sprint 3. Until then, document T-014-03 and T-014-11 as known-deferred in `context_summary.md` and treat manual `wrangler dev` validation as the interim gate.

### D4. Wrangler upgrade vs compat-date pin
- `wrangler 3.99.0` warns on every test run because the local runtime maxes at `2024-12-30` and `wrangler.toml` requests `2026-04-25`.
- **Recommendation**: check `wrangler@latest` (probably ≥4.x by now). If a release supports `2026-04-25` or later in its bundled runtime, upgrade. Otherwise pin to `2024-12-30` for local dev and document that production overrides via the Cloudflare deploy honour the actual request. Cost: 5 minutes; payoff: clean test logs.

### D5. Add a Neon-branch integration test for /readyz
- The mocks in `health.test.ts` were built from the spec, not the schema. C1 is precisely the bug this hides.
- **Recommendation**: add a single integration test (gated by `NEON_API_KEY` env) that uses Neon MCP `create_branch`, applies `db/schema.sql`, runs `/readyz` against the real branch, asserts schema and route agree, then `delete_branch`. Cost: ~50 LOC. Payoff: this exact bug class never recurs. Sprint 2 candidate.

### D6. F-014 scope expansion of `wrangler.toml` and F-004 expansion of `vitest.config.ts`/`package.json`
- F-014 added `compatibility_flags = ["nodejs_compat"]` and split `test`/`test:coverage` scripts. **Necessary** — vitest-pool-workers can't load without nodejs_compat. PASS as legitimate scope expansion.
- F-004 added `@vitest/coverage-istanbul` devDep and changed the provider in `vitest.config.ts` from v8 → istanbul. **Necessary** — v8 imports `node:inspector` which the Workers sandbox can't resolve. PASS as legitimate scope expansion.
- Neither is scope creep. Both are documented in `features.json`.

---

## Sprint 1 retrospective input

### What worked well
- **Spec-first discipline**: every test in `tests/crypto/` cites a `T-NNN-MM` ID inline. Easy to map back to spec, easy to find unmapped MUSTs.
- **TDD enforcement was real**: 27 tests, all passing, all behaviourally meaningful (no `expect(true).toBe(true)` filler). The crypto round-trip + tampered-cipher + tampered-IV + wrong-key matrix is textbook.
- **Sensible scope boundaries**: F-004 stayed in `src/crypto/` and `tests/crypto/`; F-014 stayed in `src/routes/health.ts` and `tests/routes/`. No accidental cross-touches.
- **Coverage tooling problem actually solved**: the v8 → istanbul switch is the right answer for vitest-pool-workers and the result works for both features. The "n/a" claim in `features.json` was a process error, not a tooling failure.
- **Worker-native crypto**: zero npm dependencies for the cryptographic core. Pure Web Crypto API. Clean, fast, no audit surface.

### What slowed teammates down
- **Spec internal contradictions**: F-004 vs architecture.md ER diagram on the IV columns; F-014's "all providers must have non-revoked tokens" vs the bootstrap reality where no rows exist. These ate decision time and produced quiet divergences (M2, C2).
- **Coverage-tooling confusion**: F-014 teammate concluded coverage was unmeasurable; F-004 teammate found the istanbul fix. Same project, two different verdicts in the same sprint. A single shared note in `context_summary.md` would have saved one of them an hour.
- **Mock-vs-schema drift**: easy to write a mock that matches the spec but not the actual table. C1 is the consequence.
- **wrangler compat warning noise**: four warnings per test run is friction. Tolerable but distracting.

### Recommendations for Sprint 2 spawn prompts
1. **Always run `mcp__Neon__describe_table_schema` against any table the feature touches** before writing a query. This would have caught C1 in seconds.
2. **Reconcile any spec/architecture conflict before writing code** — and update one of the two documents in the same commit. The F-004/architecture IV-columns conflict should never have shipped without one of them being amended.
3. **Front-load coverage validation**: the spawn prompt should say "your first action after writing the failing test is `npm run test:coverage` to confirm the gate is real." This removes the "is coverage measurable here?" question.
4. **Add a Neon-branch integration step to the F-002/F-003 acceptance criteria**: spawn each feature with a sub-task that creates a temporary Neon branch, applies schema, runs the route end-to-end. This makes the "schema matches code" check mechanical.
5. **For features that touch shared interfaces (env vars, table columns, route registration order)**, require a `plan_approval_request` so the lead can spot interface drift before two teammates write code against incompatible assumptions.
6. **Pin wrangler compat date or upgrade wrangler before Sprint 2 starts** — eliminates 4 warning lines × N test runs of friction.

---

## Summary for the lead (one paragraph)

F-004 is excellent and ready. F-014 is logically correct but its readiness query depends on a column that doesn't exist in either the committed `db/schema.sql` or the live Neon database — that schema gap (plus a related F-004 spec/architecture disagreement on per-token IVs) is the only thing keeping this from a clean ship. Both fixes are small (one schema migration on an empty table, one spec amendment), and once they land, Sprint 1 is a model for how the rest of the project should run: spec-first, TDD-first, scope-clean, no Node-API contraband. Recommended action: BLOCK on C1 and C2, fix in a single follow-up commit, then proceed to Sprint 2.
