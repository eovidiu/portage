## 0. Execution model

This plan is designed to run as **two concurrent Claude Code sessions**, one
per repo, each driving its own harness:

- **Session A — Worker (rooted in `portage/`).** Runs `/harness-continue` to
  pick up F-019 + F-020 (Phase 0, no deps, parallelizable as Agent Teams
  teammates). Later picks up F-021 + F-022 once F-016b ships.
- **Session B — UI (rooted in `portage-ui/`).** Bootstrapped during task 1.13
  by Session A: `gh repo create` → `cd ../portage-ui` → `/harness-init` →
  register UI-PHASE-{1,2,3,4,5,7} as features in the new repo's
  `.harness/features.json`. Then `/harness-continue` spawns 4 Sonnet
  teammates for Phases 1+2+3+5 in parallel. Phase 4 holds until Session A
  ships F-021/F-022. Phase 7 runs from either session after merges.

Cross-repo dependencies (e.g., UI Phase 0 needs Worker F-020 deployed) are
synchronized via merged PRs — each repo's harness only knows about its own
features.

## 1. Phase 0 — Foundation: Worker auth + UI scaffold

### 1A. Worker repo (`portage`)

- [ ] 1.1 Add `F-019 cf-access` entry to `.harness/features.json` with `scope: ["src/middleware/cf_access.ts","src/index.ts","tests/middleware/cf_access.test.ts"]`, `depends_on: []`, `priority: 14`.
- [ ] 1.2 Author `docs/specs/F-019-cf-access.md` and `docs/specs/T-019-cf-access.md` with requirements mirrored from `openspec/changes/portage-ui-foundation/specs/cf-access-auth/spec.md`.
- [ ] 1.3 TDD: write failing tests in `tests/middleware/cf_access.test.ts` covering valid JWT + correct email → 200; bad signature → 401; non-allowed email → 403; JWKS fetch error → 503; cached JWKS hit; Bearer-only request → kind:"service"; no auth → 401.
- [ ] 1.4 Implement `src/middleware/cf_access.ts` (jose `createRemoteJWKSet` for the team JWKS, module-level cache with TTL ≥10 min, `c.var.principal` setter).
- [ ] 1.5 Wire `cfAccessMiddleware` into `src/index.ts` ahead of `jwtMiddleware`. Confirm 5-stage TaskCompleted hook green (smoke, full, coverage-claim, schema-drift, TODO markers).
- [ ] 1.6 Add `hono/cors` middleware to `src/index.ts` allowing `https://app.portage.eovidiu.co.uk` and `http://localhost:5173`, methods `GET POST OPTIONS`, headers `Authorization Content-Type`, `credentials: true`. Add CORS preflight tests.
- [ ] 1.7 Add `F-020 api-me` entry to `.harness/features.json`. Author `docs/specs/F-020-api-me.md` and `T-020-api-me.md`.
- [ ] 1.8 TDD: write failing tests in `tests/routes/me.test.ts` for the three scenarios in `specs/api-me/spec.md`.
- [ ] 1.9 Implement `src/routes/me.ts` returning principal data; mount in `src/index.ts`.
- [ ] 1.10 Update `src/env.ts` with `CF_ACCESS_TEAM`, `CF_ACCESS_AUD` optional bindings; add to `.dev.vars.example`.
- [ ] 1.11 Run integration test (Neon branch) confirming a request with neither auth source returns 401, with Bearer succeeds, with Cf-Access JWT (mocked JWKS) succeeds.
- [ ] 1.12 Open and merge PR `feat(F-019,F-020): cf-access middleware + /api/me`. Confirm `wrangler deploy` succeeds; production smoke `curl /healthz` still 200.

### 1B. UI repo (`eovidiu/portage-ui`)

- [ ] 1.13 Run `gh repo create eovidiu/portage-ui --private --description "Portage UI"` then `git clone` it next to `portage/` (sibling). Set `git config user.email eovidiu@gmail.com` in the new clone.
- [ ] 1.13a Open a new Claude Code session rooted in `portage-ui/`. From that session, run `/harness-init` to bootstrap `.harness/{features.json,context_summary.md,init.sh,claude-progress.txt}` for the UI repo. Register UI-PHASE-1, UI-PHASE-2, UI-PHASE-3, UI-PHASE-4, UI-PHASE-5, UI-PHASE-7 as `pending` features with the scopes implied by Phases 2–7 below. Set UI-PHASE-4's `depends_on` to the equivalent of "F-021 and F-022 merged on Worker side" (use a `notes` field — cross-repo deps cannot be enforced mechanically).
- [ ] 1.13b Copy this OpenSpec change directory's contents into `portage-ui/openspec/changes/portage-ui-foundation/` so the UI session has the canonical specs locally; commit as `docs: import portage-ui-foundation OpenSpec`.
- [ ] 1.14 Scaffold Vite + React 19 + TS: `npm create vite@latest . -- --template react-ts`. Commit "chore: vite scaffold".
- [ ] 1.15 Add Tailwind: `npm install -D tailwindcss postcss autoprefixer && npx tailwindcss init -p`. Commit "chore: tailwind".
- [ ] 1.16 Init shadcn/ui: `npx shadcn-ui@latest init` with neutral palette + Inter font. Add `Button`, `Card`, `Badge`, `Skeleton`, `Toast`, `Alert` primitives. Commit.
- [ ] 1.17 Install runtime deps: `react-router-dom@6 @tanstack/react-query`. Commit.
- [ ] 1.18 Install test deps: `vitest @vitejs/plugin-react jsdom @testing-library/react @testing-library/user-event @testing-library/jest-dom msw vitest-axe @axe-core/react`. Commit.
- [ ] 1.19 Add `vite.config.ts` test config, `tests/setup.ts` (MSW server boot, jest-dom matchers, axe).
- [ ] 1.20 Implement `src/lib/api.ts` per `specs/web-ui-shell/spec.md` (fetch wrapper, `credentials: "include"`, `ApiError`). Tests in `tests/lib/api.test.ts`.
- [ ] 1.21 Implement `src/components/AuthGate.tsx` per spec (calls `/api/me`, redirects to CF Access on 401). MSW-based tests in `tests/components/AuthGate.test.tsx`.
- [ ] 1.22 Implement base layout (`src/components/Layout.tsx`) with persistent nav slots; pre-commit Phase 1/2/3/5 route stubs in `src/App.tsx` (lead-stub pattern).
- [ ] 1.23 Author `_headers` file at repo root with CSP, HSTS, Referrer-Policy, Permissions-Policy per spec. Test asserts presence in built artifact.
- [ ] 1.24 Author `.github/workflows/ci.yml`: lint → typecheck → unit → a11y → `npm audit --production` (fail on `high+`) → `gitleaks detect`.
- [ ] 1.25 Author `.github/workflows/deploy.yml`: on push to `main`, run `npm run build` and `wrangler pages deploy dist --project-name portage-ui` using a `CLOUDFLARE_API_TOKEN` secret.
- [ ] 1.26 Run `wrangler pages project create portage-ui --production-branch main` and `wrangler pages domain add portage-ui app.portage.eovidiu.co.uk`. Confirm DNS record auto-provisioned.
- [ ] 1.27 First production deploy via `git push origin main`; confirm CF Access redirects an unauthenticated browser to Google sign-in and returns to `/api/me` with the operator email after consent.

### 1C. Phase 0 security checklist

- [ ] 1.28 `npm audit --production` clean above `moderate` (block on `high+` in CI).
- [ ] 1.29 `gitleaks detect --source .` clean.
- [ ] 1.30 Test asserts production `_headers` has the full CSP, HSTS, Referrer-Policy, Permissions-Policy values.
- [ ] 1.31 Test asserts `lib/api.ts` rejects responses with no `Set-Cookie`/CF-Access cookie when authentication is expected.
- [ ] 1.32 Confirm Bearer-JWT path on Worker still passes original auth tests post-merge.

## 2. Phase 1 — Onboarding & Health (parallel after Phase 0)

- [ ] 2.1 Add MSW handler set `tests/mocks/onboarding.ts` for `GET /readyz` (all states) and `GET /api/me`.
- [ ] 2.2 TDD: write failing tests in `tests/pages/ConnectPage.test.tsx` for both-connected, Spotify-missing, DB-down scenarios per spec.
- [ ] 2.3 TDD: write failing tests asserting Spotify "Connect" button is `<a target="_top">` with the correct `href`.
- [ ] 2.4 Implement `src/pages/ConnectPage.tsx`, `src/components/ProviderCard.tsx`, `src/components/HealthPills.tsx`.
- [ ] 2.5 Implement `src/hooks/useReadyz.ts` (TanStack Query, 60s stale time).
- [ ] 2.6 Wire `/connect` route in `src/App.tsx`. Add to nav.
- [ ] 2.7 Phase 1 a11y: vitest-axe assertions on `ConnectPage` render (no violations); manual keyboard pass documented.
- [ ] 2.8 Phase 1 security checklist: deep-link href limited to Worker domain (no open redirect); `target="_top"` test passes; no PII rendered other than the operator email.
- [ ] 2.9 Open PR `feat(ui): phase 1 onboarding & health`. Testing agent runs vitest on the phase scope only.

## 3. Phase 2 — Dashboard & Manual Sync (parallel after Phase 0)

- [ ] 3.1 Add MSW handler set `tests/mocks/dashboard.ts` for `GET /sync/status` (all status branches incl. each `error_code`), `GET /stats`, `POST /sync/run` (200, 202, 409).
- [ ] 3.2 TDD: write failing tests in `tests/pages/DashboardPage.test.tsx` covering succeeded badge color, failed badge with `error_code` label + CTA, stats tile formatting (4-sig match rate, 1-decimal lag).
- [ ] 3.3 TDD: write failing tests for "Run sync now" button: 200→green toast, 202→blue toast + polling starts, 409→yellow toast with `current_run_id`.
- [ ] 3.4 TDD: write failing test for status transition `running → succeeded` triggering refetch and stopping the 30s interval.
- [ ] 3.5 Implement `src/pages/DashboardPage.tsx`, `src/components/RunSummary.tsx`, `src/components/StatsTiles.tsx`, `src/components/RunNowButton.tsx`.
- [ ] 3.6 Implement hooks `src/hooks/useSyncStatus.ts` (polling 30s while `running`), `useStats.ts`, `useRunSync.ts` (mutation).
- [ ] 3.7 Wire `/dashboard` route. Make it the default landed page after AuthGate.
- [ ] 3.8 Phase 2 a11y: vitest-axe on DashboardPage; status badges have non-color affordance (icon + text label).
- [ ] 3.9 Phase 2 security checklist: confirm `POST /sync/run` 401s when sent without CF Access cookie or Bearer; client never logs response bodies of auth-protected endpoints.
- [ ] 3.10 Open PR `feat(ui): phase 2 dashboard & manual sync`.

## 4. Phase 3 — Operator Console (parallel after Phase 0)

- [ ] 4.1 Add MSW handler set `tests/mocks/operator.ts` for `GET /sync/runs` (with status + error_code filters), `GET /unmatched`, `POST /unmatched/:id/match`, `POST /unmatched/:id/skip`.
- [ ] 4.2 TDD: write failing tests in `tests/pages/RunsPage.test.tsx` for default load, status filter, error_code filter, URL sync.
- [ ] 4.3 TDD: write failing tests in `tests/pages/UnmatchedPage.test.tsx` for empty queue, queue with rows, optimistic match success + rollback on 400, optimistic skip, candidates-empty fallback note.
- [ ] 4.4 TDD: write failing test for client-side Tidal id format validation (don't POST on invalid).
- [ ] 4.5 Implement `src/pages/RunsPage.tsx`, `src/components/RunsTable.tsx`, filter components.
- [ ] 4.6 Implement `src/pages/UnmatchedPage.tsx`, `src/components/UnmatchedRow.tsx` with manual-match input + skip control.
- [ ] 4.7 Implement hooks `src/hooks/useRuns.ts`, `useUnmatched.ts`, `useMatchUnmatched.ts`, `useSkipUnmatched.ts` (with optimistic update + rollback).
- [ ] 4.8 Wire `/runs` and `/unmatched` routes. Add to nav.
- [ ] 4.9 Phase 3 a11y: vitest-axe on both pages; large tables have row focus and screen-reader summaries.
- [ ] 4.10 Phase 3 security checklist: control characters stripped from any free-text submit (forward-looking; no free-text in Phase 3 yet); Tidal id format validated client-side; no `dangerouslySetInnerHTML`.
- [ ] 4.11 Open PR `feat(ui): phase 3 operator console`.

## 5. Phase 5 — Captures Viewer (parallel after Phase 0)

- [ ] 5.1 Add MSW handler set `tests/mocks/captures.ts` for `GET /captures` covering pagination, source filter, status filter, empty list.
- [ ] 5.2 TDD: write failing tests in `tests/pages/CapturesPage.test.tsx` for empty state, pagination, source filter URL sync, status filter URL sync, XSS-safe `context_note` rendering (`<script>` rendered as text).
- [ ] 5.3 Implement `src/pages/CapturesPage.tsx`, `src/components/CapturesTable.tsx`, filter dropdowns.
- [ ] 5.4 Implement `src/hooks/useCaptures.ts`.
- [ ] 5.5 Wire `/captures` route. Add to nav.
- [ ] 5.6 Phase 5 a11y: vitest-axe; filter dropdowns labeled.
- [ ] 5.7 Phase 5 security checklist: `dangerouslySetInnerHTML` ESLint rule active; truncation to 500 chars matches Worker enforcement; XSS test passes.
- [ ] 5.8 Open PR `feat(ui): phase 5 captures viewer`.

## 6. Phase 4 — Multi-Playlist Console (gated on F-016b shipping)

### 6A. Worker repo (`portage`)

- [ ] 6.1 Confirm F-016b has shipped to main with passing tests; if not, mark this phase blocked and proceed with Phase 7.
- [ ] 6.2 Add `F-021 playlists-list` entry to `.harness/features.json`. Author `docs/specs/F-021-playlists-list.md` and `T-021`.
- [ ] 6.3 TDD: write failing tests in `tests/routes/playlists.test.ts` for liked-only, liked+extras, unauth → 401.
- [ ] 6.4 Implement `src/routes/playlists.ts` GET handler. Extend `src/db/playlist_configs.ts` with `listAll` if missing.
- [ ] 6.5 Add `F-022 playlists-add` entry to `.harness/features.json`. Author `docs/specs/F-022-playlists-add.md` and `T-022`.
- [ ] 6.6 TDD: write failing tests for valid id (201), malformed id (400), duplicate (200 idempotent), Spotify 404 (404), unauth (401).
- [ ] 6.7 Implement POST handler — call `fetchSpotifyPlaylistName` (F-016), persist via DB helpers.
- [ ] 6.8 Mount `playlistsRoute` in `src/index.ts` under `/api/playlists`. Confirm 5-stage hook green.
- [ ] 6.9 Open PR `feat(F-021,F-022): /api/playlists endpoints`.

### 6B. UI repo (`eovidiu/portage-ui`)

- [ ] 6.10 Add MSW handler set `tests/mocks/playlists.ts` for `GET /api/playlists` and `POST /api/playlists` (all branches).
- [ ] 6.11 TDD: write failing tests in `tests/pages/PlaylistsPage.test.tsx` for liked-only render, liked+extras render with `__liked__` first, add-form valid/invalid id, duplicate idempotent, Spotify-404 inline error, gating banner when membership empty.
- [ ] 6.12 Implement `src/pages/PlaylistsPage.tsx`, `src/components/PlaylistCard.tsx`, `src/components/AddPlaylistForm.tsx`.
- [ ] 6.13 Implement hooks `src/hooks/usePlaylists.ts`, `useAddPlaylist.ts`.
- [ ] 6.14 Wire `/playlists` route; do NOT add to navigation yet (per spec — gated until F-016b orchestrator wiring runs successfully). Add to nav after smoke verification.
- [ ] 6.15 Phase 4 a11y: vitest-axe on PlaylistsPage; AddPlaylistForm has labelled input + error region.
- [ ] 6.16 Phase 4 security checklist: client-side `^[A-Za-z0-9]{22}$` validation; server-side validation in F-022 is the source of truth; no XSS vector in playlist `display_name` rendering (default escaping only).
- [ ] 6.17 Open PR `feat(ui): phase 4 multi-playlist console`.

## 7. Phase 7 — Security & Accessibility Hardening Pass

- [ ] 7.1 Run `Skill(skill-security-analyzer)` over the merged `eovidiu/portage-ui` repo. Capture findings + resolutions.
- [ ] 7.2 Run `Skill(web-accessibility-checker)` against the deployed `https://app.portage.eovidiu.co.uk` covering `/connect`, `/dashboard`, `/runs`, `/unmatched`, `/captures`, `/playlists` (if Phase 4 shipped).
- [ ] 7.3 Run `Agent(pr-review-toolkit:silent-failure-hunter)` over `src/middleware/cf_access.ts` and `src/lib/api.ts` (UI fetch wrapper).
- [ ] 7.4 Manual auth bypass tests: (a) browser with no cookies → 302 to CF Access; (b) `curl /api/sync/status` no headers → 401; (c) forged `Cf-Access-Jwt-Assertion` → 401, no token leakage; (d) Bearer JWT signed by foreign secret → 401; (e) tampered OAuth `state` → 400, no token written.
- [ ] 7.5 CORS preflight tests: confirm `OPTIONS` from disallowed origin omits `Access-Control-Allow-Origin`.
- [ ] 7.6 OAuth callback security: confirm `/auth/spotify/callback` and `/auth/tidal/callback` reject tampered `state` without leaking the real value.
- [ ] 7.7 Author `docs/security/2026-MM-DD-portage-ui-pen-test.md` in the Worker repo. Include: scope, methodology, findings (severity + remediation), sign-off line for Ovidiu.
- [ ] 7.8 File any exploitable findings as Worker features (F-0NN) in `.harness/features.json` with priority and `discovered_via: "phase-7-security"`.
- [ ] 7.9 Run `Skill(web-accessibility-checker)` final pass after security findings remediated; confirm WCAG 2.2 AA compliance on all pages.
- [ ] 7.10 Phase 7 deliverable review: Ovidiu reads pen-test report and signs off before merge.

## 8. Cross-cutting verification (every phase, before PR merge)

- [ ] 8.1 `npm test` green; coverage ≥95% on touched files (gate matches Worker harness).
- [ ] 8.2 `npm run typecheck` clean.
- [ ] 8.3 `npm run lint` zero warnings.
- [ ] 8.4 `npm run test:a11y` (vitest-axe) passes.
- [ ] 8.5 `npm audit --production` clean above `moderate`.
- [ ] 8.6 `npm run build` succeeds with no warnings.
- [ ] 8.7 Local end-to-end: `wrangler dev` (Worker) + `npm run dev` (Vite) — phase's primary user flow works against the local Worker.
- [ ] 8.8 Pages preview deploy clicks through without errors on the phase's pages.
- [ ] 8.9 Full vitest suite green (no regressions in earlier phases).
- [ ] 8.10 PR description references the OpenSpec change at `openspec/changes/portage-ui-foundation/` and the relevant capability spec(s).
