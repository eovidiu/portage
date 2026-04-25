# Context Summary

Persistent record of architectural decisions, discovered patterns, gotchas, and active context.
This file is referenced in CLAUDE.md and loaded every session.

## Active Context
- Sprint 2 COMPLETE — F001 + F002 + F003 + F004b all passing; 16 commits on main; 148/148 tests; coverage cleared 95% gate everywhere (src/crypto 100%, src/db 100%, src/routes/auth/* 100%, src/providers/spotify 98.9%, src/providers/tidal 98.92%, src/auth 95.83%, src/middleware 97.5%); Sprint 2 review found 1 logic bug + 1 spec-correctness bug + 1 process bug, all fixed in a 30-min reuse-existing-teammates fix wave
- F-Integ + F-Q1 added as discovered Sprint 3 candidates (Neon-branch integration test for OAuth↔F-004b round-trip; wall-clock e2e harness)
- Wave structure refined: F-001 first (plan-approval gate), then 3-way parallel (F-002 + F-003 + F-004b with stub-then-replace interface pattern), then Opus reviewer, then 2-way parallel fix wave (spotify + tidal independently)
- Next sprint (Sprint 3): F-Integ first (closes the mock-only OAuth integration gap), then F-005 (Spotify Liked Songs fetch); F-Q1 in parallel as time permits
- Specs authoritative; multiple amendments through Sprint 1+2 captured under each feature in features.json notes
- Mode: Agent Teams, max-parallelization
- Worker domain (production): `portage.eovidiu.co.uk` (architecture spec's `sync.example.com` was placeholder)
- Tidal playlist title (target): `Spotify Liked` (from `.env` `TIDAL_PLAYLIST_TITLE`)
- Tidal country code: `RO` (from `.env` `TIDAL_COUNTRY_CODE`)

## Available Credentials (names only — values in `.env`, never committed)
- **Spotify**: `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`
- **Tidal**: `TIDAL_CLIENT_ID`, `TIDAL_CLIENT_SECRET`, `TIDAL_COUNTRY_CODE`, `TIDAL_PLAYLIST_TITLE`
- **Cloudflare**: `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_ZONE_ID`, `CLOUDFLARE_API_TOKEN`, `WORKER_DOMAIN`
- **Neon**: `DATABASE_URL`, `NEON_API_KEY`
- **Worker runtime secrets** (to be minted, not in `.env`): `JWT_SECRET` (32+ bytes), `TOKEN_ENCRYPTION_KEY` (32 bytes base64), `SPOTIFY_REDIRECT_URI`, `TIDAL_REDIRECT_URI`

The Neon MCP server is available — `NEON_API_KEY` enables programmatic project/branch/schema management. Prefer Neon MCP over manual SQL for schema setup.

## Cross-Cutting Concerns
- **Stack**: TypeScript, Cloudflare Workers, Hono, @neondatabase/serverless, vitest, wrangler
- **Architecture**: stateless Worker; all state in Neon Postgres; `pg` driver does NOT work in Workers (per ADR-001) — must use `@neondatabase/serverless` for Postgres-over-HTTP/WebSocket
- **Single-tenant by design** (ADR-005): no tenant column, no RLS, any valid JWT has full access
- **No silent failures** (per spec conventions): every error path produces a structured log line with `run_id`, `feature`, `stage`, `error_code`, `message`
- **Spec-first**: deviations from `docs/` require updating the spec before code. Reference `F-NNN` in commits and PRs.
- **TDD with vitest**: every feature has a matching `T-NNN` test spec; coverage gate is 95% on touched code

## Domain: spotify-roon-sync

### Decisions
- TypeScript / Cloudflare Workers / Hono / Neon stack chosen per ADRs 001-003 (2026-04-25)
- ISRC-first matching with fuzzy fallback per ADR-004 (F-006 before F-007)
- Single named Tidal playlist as sync target per ADR-006 (not Tidal favourites)
- Bootstrap JWT pattern: 1-year HS256, single subject `owner` (F-001) — iOS Sign-in-with-Apple deferred

### Patterns
- All authenticated routes use a single `Hono.use()` middleware call (F-001-R6) — no per-route wrapping
- Tokens: encrypted with AES-256-GCM, 96-bit IV per encrypt, key from `TOKEN_ENCRYPTION_KEY` secret (F-004)
- DB invariants enforced at the application layer (no DB CHECKs in spec) — see I-001 to I-005 in `docs/architecture.md`
- Cursor advance for Spotify fetch MUST be atomic with page persist (I-005, F-005)

### Gotchas
- **Bootstrap cycle F-001 ↔ F-014**: F-001 spec lists F-014 as dep ("/healthz is the only unauthenticated GET"); F-014's `/readyz` lists F-002/F-003/F-004 as deps. Resolution: implement F-014 `/healthz` first (zero deps), then F-001 wires `/healthz` as the public exception. F-014 `/readyz` enhancements layer in after providers ship. `features.json` records F-001 → F-014 only; the F-014 → providers relationship is documented but NOT a hard dep.
- **Co-implementation F-009 ↔ F-011**: F-009 spec lists F-011 (logging consumes orchestrator output); F-011 lists F-009 (orchestrator owns sync_runs row writes). Resolution: ship F-011 read endpoints first against an empty `sync_runs` table, then F-009 starts writing rows. `features.json` records F-009 → F-011 (hard dep), F-011 → F-001 only.
- **`pg` driver DOES NOT work in Workers** (ADR-001 consequence): always import from `@neondatabase/serverless`
- **Plaintext tokens MUST NOT appear in any log line** (I-003, F-001-R5, 9.3) — log redaction is a code review checkpoint
- **README/SPEC_INDEX broken links**: both `docs/README.md` and `docs/specs/SPEC_INDEX.md` reference `docs/features/` and `docs/tests/`, but the actual layout is flat under `docs/specs/` (`F-NNN-*.md` and `T-NNN-*.md` side-by-side). Cosmetic; flagged for cleanup.
- **`.env` `DATABASE_URL` is commented out inside the quotes**: the value starts with `# postgresql://...` — that leading `#` is INSIDE the quoted string, so any code reading the env var will get a literal `#` prefix and the URL will not parse. Fix before F004/F005 ship: strip the `#` and the leading space. The Neon MCP server can fetch a fresh connection string via `get_connection_string` if needed.
- **Spec uses `sync.example.com` as Worker domain placeholder**; real domain from `.env` `WORKER_DOMAIN` is `portage.eovidiu.co.uk`. Use the real value in `wrangler.toml` and OAuth redirect URIs (`https://portage.eovidiu.co.uk/auth/spotify/callback`, `https://portage.eovidiu.co.uk/auth/tidal/callback`).
- **vitest-pool-workers needs `nodejs_compat` flag in `wrangler.toml`** — without it, the pool fails to load. Already added (Sprint 1, F014 teammate).
- **Coverage tooling discrepancy** (Sprint 1, unresolved — reviewer to investigate): `@cloudflare/vitest-pool-workers@0.5.41` does not surface coverage instrumentation cleanly. F004 (`crypto`) reported 100% via istanbul provider; F014 (`health`) reported "cannot measure" with the same provider. Either the difference is real (some test layouts work and others don't) or one teammate ran the wrong command. Reviewer is asked to reconcile and either (a) confirm both are measurable or (b) declare the coverage gate as a known tooling gap and create a follow-up feature to enable it. Until resolved, treat coverage % values in `features.json` as best-effort, not authoritative.
- **`@vitest/coverage-v8` is incompatible with the Workers sandbox** — it imports `node:inspector`. Sprint 1 switched to `@vitest/coverage-istanbul`. Both deps are currently in `package.json`; the v8 dep can be removed once the istanbul path is fully validated.
- **Default Neon branch is `production`** (id `br-sparkling-star-al5g4fzf`), not `main`. Use `mcp__Neon__describe_project` if a teammate needs the branch ID.
- **wrangler 3.99.0 only supports compat dates up to `2024-12-30`** — wrangler.toml asks for `2026-04-25` and the local Workers runtime warns + falls back. Production Cloudflare deploy will honor the requested date. Upgrade wrangler when the upstream supports current dates, or pin compat date to `2024-12-30` to silence local warnings.
- **T-014-03 and T-014-11 are wall-clock metric tests** (response time thresholds). They require a running `wrangler dev` and cannot be expressed as vitest unit tests. F014 unit tests cover the functional assertions; the timing metrics are deferred to manual/e2e QA. Track explicitly when a QA feature is added.

## Meta-Patterns
<!-- Coordination insights that apply across features — NOT domain-specific.
     Populated by the retrospective step at session end.
     These transfer to new projects: harness-init can import them as starting context. -->
- **Always describe-table the schema before writing a query**: Sprint 1 C1 (the missing `status` column) hid behind a mock built from the spec, not the schema. Adding `mcp__Neon__describe_table_schema` (or equivalent for non-Neon DBs) as the first action of any feature touching a DB column would have caught it pre-implementation. Reviewer recommendation now baked into the standard spawn prompt template for DB-touching work.
- **Reconcile spec contradictions in a single commit, before code**: F-004 said "separate IVs", architecture.md ER diagram showed one. Each teammate read one source and silently chose. Front-load contradiction reconciliation as a teammate's first sub-task when the work spans two specs.
- **Mocks built from specs hide schema/spec drift**: integration tests against a real (or branch-isolated) DB catch this class of bug. Worth investing one Neon-branch-per-feature integration step for any feature touching a DB column. Sprint 2 candidate.
- **Two coverage providers in package.json simultaneously is a smell**: Sprint 1 had `@vitest/coverage-v8` + `@vitest/coverage-istanbul` because two teammates independently encountered the v8/node-inspector incompatibility and both added a workaround. One shared note in `context_summary.md` ("v8 doesn't work in Workers; use istanbul") would have prevented the duplicate dep. Lesson: when a teammate solves an infra blocker, broadcast it via SendMessage type "broadcast" to other concurrent teammates same sprint.
- **Coverage measurement question deserves a 30-second front-loaded check**: F-014 teammate concluded coverage was unmeasurable; F-004 teammate found the istanbul fix; net result was a false "n/a" claim that the reviewer caught. Spawn prompts should now include "your first action after writing the failing test is to confirm `npm run test:coverage` produces a real coverage report."
- **Reuse-existing-teammate vs spawn-fresh for fix waves**: reusing the four Sprint 1 teammates for the four review-fix tasks worked cleanly — they already had project context loaded, no fresh-spawn token cost. Pattern: when a fix wave maps 1:1 to original implementers, SendMessage them new tasks rather than spawning new agents.
- **Plan teammate roles to leave room for shared-config touch-ups**: F-014 had to add `nodejs_compat` to wrangler.toml (scaffolder's scope); F-004 had to switch coverage provider (vitest.config.ts in scaffolder's scope). Both were necessary scope expansions, but if anticipated, the scaffolder spawn prompt could front-load them. Lesson: ask "what shared-config touchups will this feature trigger?" during sprint planning.

## Meta-Session 2026-04-25
- **Scope accuracy**: F-014 had 3 scope expansions (wrangler.toml nodejs_compat, package.json script split, vitest.config.ts threshold removal); F-004 had 2 (vitest.config.ts provider switch, package.json istanbul devDep). Both were tooling/infra blockers, not feature creep. Initial spawn prompts didn't anticipate the vitest-pool-workers compat needs. Future tooling-heavy first features should front-load infra discovery in the scaffolder.
- **Model calibration**: All implementers Sonnet, reviewer Opus. Worked well — no correction cycles on Sonnet implementers (the schema bug was a spec-vs-schema mismatch that no model would catch without a DB describe; not a Sonnet competence gap). Reviewer Opus produced a thorough, accurate review that caught both critical bugs in one pass. Cost-effective.
- **Discovery lineage**: F-004b discovered via F-004 review (depth 1). The discovery is healthy — the persistence helpers genuinely belong with the OAuth flows, not the encryption primitives. Lesson confirmed: when a "feature" naturally splits into "primitive" + "DB-coupled wrapper", split them in features.json from the start.
- **Approach patterns**: TDD strict + per-spec test ID citation (T-NNN-MM in test names) made the spec-coverage matrix mechanical for the reviewer. Continue this pattern. Web Crypto + @neondatabase/serverless + Hono stack worked frictionlessly in Workers — no Node-API contraband caught by review.
- **Plan approval**: not used in Sprint 1. For Sprint 2's F-001 (auth + secrets validation, security-sensitive, touches middleware that all later routes depend on), `require_plan_approval: true` is justified. F-002/F-003/F-004b can proceed without it.
- **Wave-by-wave parallelism beat all-at-once**: spawning blocked teammates eagerly would have burned Sonnet tokens spinning. Two-wave (scaffolder+db-init → health+crypto) plus a fix-wave reuse pattern was the right cadence.

## Meta-Session 2026-04-25 (Sprint 2)
- **Scope accuracy**: ZERO scope_expansions across F-001/F-002/F-003/F-004b. Sprint 1's lessons paid off — pre-thought scope boundaries plus the lead-stub interface pattern eliminated the contention point that would otherwise have forced expansions in src/index.ts and src/db/.
- **Model calibration**: All implementers Sonnet, lead+reviewer Opus. F-002 had 1 correction_cycle from the review fix wave; everyone else 0. The correction was a real coverage gap + R7 spec bug, not a Sonnet competence issue. F-001 used `require_plan_approval=true` and the plan was approved with 2 small refinements — the round-trip prevented the kind of misalignment that would have eaten 3-4 correction cycles.
- **Discovery lineage**: F-Integ discovered via F-004b (the mock-only integration gap surfaced by reviewer); F-Q1 discovered via F-014 (the deferred wall-clock metrics piling up across sprints). Both are healthy — they emerge from real test gaps, not architectural surprises.
- **Approach patterns**: PKCE S256 via crypto.subtle.digest + crypto.getRandomValues → base64url worked first-time for both providers. Module-level Map<string, Promise<void>> for refresh coalescing — universal pattern, both providers use it (after the M1 fix). vi.mock for F-004b stubs — let F-002/F-003 ship without F-004b's real bodies. Stub-then-replace was the key enabler for true 3-way parallel implementation.
- **Plan approval value**: For F-001, yes. The round-trip caught (a) the secretsGuard /healthz exemption decision, (b) the bootstrap script invocation strategy (test the function, not the CLI), (c) the jose error discrimination approach. For F-002/F-003/F-004b, no plan_approval was used — these were well-scoped pattern matches against existing code. Calibration: require plan approval for foundational/security-sensitive features that everything else depends on; skip for symmetric implementations of an existing pattern.

## Meta-Patterns appended (Sprint 2)
- **Lead-stub interface pattern**: When N teammates need the same interface module, lead pre-commits a stub file with function signatures + `throw "not implemented"` bodies. F-2/F-3/F-4b ran fully concurrent because of `7aaff41` (stub for src/db/provider_tokens.ts and src/db/oauth_state.ts). Cost: 60 sec of lead work + one tiny commit. Payoff: replaces serial dependency with parallel implementation. Reusable for any feature triple where one provides the interface and others consume it.
- **Worktree isolation flag is currently a no-op**: `isolation: "worktree"` in the harness Task() spawn does NOT actually create worktrees. All 3 Sprint-2 implementers reported their "worktree" was main; `git worktree list` confirms only the primary tree. No deliverable was affected because each teammate stayed in lane voluntarily, but the safety property the flag promises doesn't fire. Drop the flag from spawn prompts; rely on explicit scope discipline + the .claude/teammate-scope.txt enforcement hook (when configured).
- **"Tooling unreliable" claims must be proven**: F-014 (Sprint 1) and F-002 (Sprint 2) both blamed coverage tooling for what turned out to be process errors. Same-sprint sibling features (F-004 in S1, F-003 in S2) ran cleanly on identical pipelines. Spawn prompts now require: paste the literal istanbul output, don't summarize as "n/a" or "tooling broken"; cite the exact error message if measurement truly fails.
- **One file per concern beats one file per provider**: F-003 split out src/providers/tidal/client.ts from oauth.ts — easier to test in isolation, easier to reason about. F-002 kept it monolithic — harder to test, hit the coverage gate gap. For F-005+ (Spotify Liked Songs, Tidal Search, etc.), encourage the split-by-concern pattern.
- **Symmetric features need a 5-min cross-team consistency checkpoint**: F-002 and F-003 are mirror implementations of OAuth. They independently chose different revoke-error semantics (Spotify discriminated; Tidal indiscriminate). Both passed their own tests; the divergence was a spec-vs-code gap that only the reviewer caught. Pattern for Sprint 3: when spawning two symmetric features, include "read your sibling's implementation before finalizing yours" in the spawn prompt.
- **Harness fix-wave pattern (reuse existing teammates)**: Sprint 1 used it (4 teammates → 4 fix tasks). Sprint 2 used it (2 teammates → 2 fix tasks). Pattern: review identifies issues by feature; lead creates one task per feature's fix bundle; SendMessage to the original implementer (still alive, project context loaded) with the task ID. Cost: 2 SendMessage round-trips. Payoff: fast turnaround, no fresh-spawn token cost, original author owns their fix.
