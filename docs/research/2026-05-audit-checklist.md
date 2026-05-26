# Phase 1 Audit Checklist — Open-Source Pre-Publication

Generated: 2026-05-26
Inputs: `/tmp/portage-audit-secrets.md`, `/tmp/portage-audit-identifiers.md`
Parent plan: [2026-05-open-source-plan.md](2026-05-open-source-plan.md)

## Verdict: GREEN — proceed to Phase 2

- **No real secrets in git history.** Gitleaks ran against all 110 commits
  via `--log-opts="--all"` and the project's `.gitleaks.toml`. All 41
  findings are false positives: 39 are the synthetic
  `TOKEN_ENCRYPTION_KEY` test fixture (decodes to literal strings like
  `test-encryption-key-32bytes-long`), 1 is the intentionally-public
  `CF_ACCESS_AUD` (the wrangler.toml comment explains it appears in every
  CF Access JWT's `aud` claim by design), 1 is `sprint-3.md` quoting the
  same test fixture.
- **All local secret-bearing files correctly gitignored.** `.env` and
  `.dev.vars` are tracked-clean. `.dev.vars.example` is committed with
  placeholders only — exactly as it should be.
- **History rewrite is for cosmetics, not for security.** Phase 4.5
  filter-repo is about a clean public face (no Claude session prose,
  no production Version IDs in `git log -p`), not about secret remediation.

## New finding to add to Phase 2 (not in the original plan)

**`src/middleware/cf_access.ts:7` hard-codes `eovidiu@gmail.com`** as
the single-tenant operator allowlist. This is runtime code, not config
— Phase 2 must env-var-ize it (e.g. `env.OPERATOR_EMAIL`) and update
`.dev.vars.example` + `wrangler.toml.example` + the cf_access test
fixtures accordingly. Adds ~15 min to Phase 2.

## Phase 2 action list (grouped by intended commit)

### Commit (a) — `feat: retire F-013 captures (dead iOS-companion endpoint)`

Already specified in the parent plan, unchanged. Touches:

- `src/routes/captures.ts` (delete)
- `src/db/captures.ts` (delete)
- `tests/routes/captures.test.ts` (delete)
- `tests/db/captures.test.ts` (delete)
- `src/index.ts` (remove F-013 import + `app.route("/", capturesRoute)` line)
- `db/schema.sql` (remove `captures` table + 2 indices)
- `docs/specs/F-013-captures-api.md` → `docs/specs/retired/`
- `docs/specs/T-013-captures-api.md` → `docs/specs/retired/`
- `docs/specs/SPEC_INDEX.md` (update F-013 reference)

Out-of-scope (local-only follow-up): mark F-013 retired in
`.harness/features.json`, update test-count comments in
`.harness/context_summary.md`. Those files are about to be untracked
anyway.

Cross-repo follow-up: `portage-ui` has a matching `Captures` section
that must be removed in a parallel PR before the public push so
`app.portage.eovidiu.co.uk` doesn't render a broken section.

Prod follow-up after public push: `DROP TABLE captures;` against the
production Neon project. Not publication-blocking.

### Commit (b) — `chore: exclude local-dev tooling + strip personal data`

**B1. Template `wrangler.toml`**
- Copy current `wrangler.toml` → `wrangler.toml.example`
- In the `.example` version, replace with placeholders / comments:
  - `account_id = "dc223a5a0db5a99a0ba194aff0c98c58"` → `account_id = "<YOUR_CLOUDFLARE_ACCOUNT_ID>"`
  - `routes = [{ pattern = "portage.eovidiu.co.uk", custom_domain = true }]` → templated example + comment
  - `SPOTIFY_REDIRECT_URI = "https://portage.eovidiu.co.uk/auth/spotify/callback"` → templated
  - `TIDAL_REDIRECT_URI = "https://portage.eovidiu.co.uk/auth/tidal/callback"` → templated
  - `CF_ACCESS_TEAM = "eovidiu"` → templated
  - `CF_ACCESS_AUD = "56f972bf34c35729e737048ba533d1444ba7951cbd4795d3d59f20167daabd6c"` → templated
  - `OPERATOR_EMAIL = "<YOUR_EMAIL>"` (new — paired with B4)

**B2. Update `.dev.vars.example`** to include `OPERATOR_EMAIL` placeholder.

**B3. Update `.gitignore`** to add (currently absent, confirmed by Agent 2):
- `.harness/`
- `.claude/`
- `wrangler.toml`

(Existing entries are already adequate per Agent 2's Part A audit. The
`.harness/diagnostics/` concern raised by Agent 1 is subsumed by
`.harness/`.)

**B4. `git rm -r --cached`** for the three newly-ignored paths:
- `.harness/`
- `.claude/`
- `wrangler.toml`

**B5. Env-var-ize operator allowlist** (new finding):
- `src/middleware/cf_access.ts:7` — replace hardcoded
  `"eovidiu@gmail.com"` with `env.OPERATOR_EMAIL`
- `src/env.ts` — add `OPERATOR_EMAIL` to the Env type
- `tests/middleware/cf_access.test.ts` — update fixtures to inject
  `OPERATOR_EMAIL` via test env
- Confirm test suite still green

**B6. Test fixture scrub (27 files)** — global find/replace within `tests/`:
- `https://portage.eovidiu.co.uk/auth/spotify/callback` → `https://example.com/auth/spotify/callback`
- `https://portage.eovidiu.co.uk/auth/tidal/callback` → `https://example.com/auth/tidal/callback`
- Run full test suite after to confirm no regressions

**B7. Absolute-path scrub** (3 spots, the only `fameftimie` matches):
- `docs/operations/pre-deploy-checklist.md` — replace 3× `cd /Users/fameftimie/work/portage` with `cd <PORTAGE_REPO_ROOT>` or remove the `cd` entirely if context is obvious
- `openspec/changes/archive/2026-05-15-f-024-tidal-catalog-search/tasks.md:65` — replace the absolute path in the `diff` command

**B8. Live OpenSpec spec templating** (only the live specs, not the archives):
- `openspec/specs/api-me/spec.md` — template `eovidiu` references
- `openspec/specs/cf-access-auth/spec.md` — template `eovidiu` references
- `openspec/changes/archive/**` — **DO NOT TOUCH**. Archived changes are
  immutable historical artifacts; templating them defeats the purpose.
  Anyone reading those will understand they're early-project snapshots.
- `docs/specs/*.md` — leave (Agent 2's audit shows these references are
  mostly to the production domain in deployment notes; fine to leave
  as historical anchor)

### After both commits — Phase 3 (docs), Phase 4 (smoke test), Phase 4.5 (history scrub), Phase 5 (publish)

No changes to the parent plan for these phases. Phase 4.5 filter-repo
scope confirmed as **path-based only**:
```
git filter-repo --invert-paths --path .harness/ --path .claude/ --force
```
We are NOT doing text-based history rewriting (e.g. replacing
`eovidiu.co.uk` strings in old commits via `--replace-text`). That
would be fragile and the historical commits are all clearly
pre-public-release-prep — readers will understand. The 30 commits
already on `main` will retain whatever `eovidiu.co.uk` / personal
references they had at the time they were written.

## Quantitative summary

| Bucket | Files | Notes |
|---|---|---|
| Code (runtime) | 1 | `src/middleware/cf_access.ts` (new finding) |
| Code (tests) | 27 | redirect-URI test fixtures, global find/replace |
| Config | 1 | `wrangler.toml` → `.example` + gitignore |
| Dev docs | 2 | `docs/operations/pre-deploy-checklist.md` (3 paths), one openspec tasks.md (1 path) |
| Live specs | 2 | `openspec/specs/api-me`, `openspec/specs/cf-access-auth` |
| Spec archives | 19 | LEAVE — historical fidelity |
| Harness/Claude tooling | 16 | excluded entirely via gitignore + cached removal |
| **Total touched in Phase 2** | **~33** | |

## Open decisions surfaced by the audit

None requiring Ovidiu input — the `cf_access.ts` finding has an obvious
fix (env var), and the history-text-scrub option has been answered with
"path-only" by default. If Ovidiu disagrees with path-only, say so
before Phase 4.5.
