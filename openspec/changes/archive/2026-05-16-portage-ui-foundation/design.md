## Context

Portage is a single-tenant Cloudflare Worker (`portage.eovidiu.co.uk`) running
Hono + Neon Postgres. Cron triggers a sync twice daily, and a JSON API surface
exposes status, runs, stats, unmatched queue, captures, and OAuth flows for
Spotify and Tidal. The Worker enforces auth via a single bootstrap JWT
(HS256, year-long, subject `owner`); cron and the planned iOS companion both
use that token via `Authorization: Bearer`. The Cloudflare Workers Free tier
caps each invocation at 50 subrequests, which already shapes the orchestrator
(see F-015 bounded-invocation refactor). 19 of 22 features pass; multi-
playlist work (F-016/017/018) is mid-build.

There is no UI today. Operator tasks (resolving unmatched tracks, configuring
multi-playlist support, watching sync state) require `curl` or `wrangler tail`.
We need an operator-facing web UI that surfaces sync state in real time, lets
the operator act on the unmatched queue and the multi-playlist registry, and
onboards Spotify + Tidal OAuth — all without growing the Worker's surface area
or touching its 50-subrequest budget.

## Goals / Non-Goals

**Goals:**

- Ship a web UI covering the full operator pyramid: onboarding, dashboard,
  operator console, multi-playlist console, captures viewer.
- Keep UI code physically separate from Worker code (different repo, different
  CI, different deploy pipeline).
- Use **Sign-in-with-Google** as the human auth path, with no auth code in the
  SPA.
- Preserve the existing Bearer JWT path so cron and iOS keep working unchanged.
- Make every phase independently testable by a testing agent — disjoint file
  scopes, MSW-mocked Worker API, no cross-phase test fixtures.
- Make phases parallelizable so multiple Agent Teams teammates can work
  concurrently after the foundation phase lands.
- Treat security and accessibility as a named verification phase with a
  written deliverable, not a code-review side note.
- Stay on the Cloudflare free tier.

**Non-Goals:**

- Multi-user / RBAC. Single-tenant remains the contract per ADR-005.
- Real-time updates over websockets. TanStack Query polling at 30 s is enough
  for a 2x/day cron.
- Mobile-native UI. The iOS companion (driven by F-013 captures) is a separate
  project line.
- Hostinger deployment. Cloudflare-native end to end.
- In-app Google OAuth implementation. Cloudflare Access provides this.
- A track browser (full search across Liked + matched). Sketched as Phase 6
  for future work; not part of this change.
- i18n. English only.
- Telemetry beyond Cloudflare Logs (already on per `wrangler.toml`).

## Decisions

### D1. Separate repository for the SPA

**Decision:** Create `eovidiu/portage-ui` as a new private GitHub repo. Do not
colocate the UI under `ui/` in the existing Worker repo.

**Rationale:** Independent CI (no Worker test pollution), independent
deployment (`wrangler pages deploy` driven from the UI repo), independent
versioning. The existing Worker repo's testing harness (vitest-pool-workers,
istanbul, schema-drift hooks) is tuned for Workers; mixing in a Vite/RTL/MSW
stack in the same `package.json` would fight for shared config.

**Alternatives considered:**

- *Monorepo with pnpm workspaces:* lower onboarding friction, but the Worker
  repo already has a complex hook chain (`verify-task-quality.sh`,
  `check-schema-drift.py`, `enforce-scope.sh`) that would need per-package
  scoping. Cost > benefit for a single-tenant tool.
- *Worker-served HTML (Hono `c.html` + HTMX):* tightest coupling, no separate
  build, but UI rendering would share the 50-subrequest invocation budget any
  time the page makes server-side API calls.

### D2. Cloudflare Access (Google IdP) for browser auth

**Decision:** Enable Cloudflare Zero Trust on the account, configure Google
as an Identity Provider, and create one Access Application named `portage-ui`
covering both `app.portage.eovidiu.co.uk` and the `portage.eovidiu.co.uk/api/*`
paths. Allow rule: `email is eovidiu@gmail.com`. Bypass rule:
`Service Auth (token-based)` for the existing Bearer JWT clients.

**Rationale:**

- Zero auth code in the SPA. The browser is redirected to Cloudflare's hosted
  login → Google. After consent, CF Access sets a cookie on the
  `eovidiu.co.uk` domain and forwards a signed `Cf-Access-Jwt-Assertion`
  header to origins.
- Free for ≤50 users on the Cloudflare free plan.
- Identity is enforced at the edge before requests reach the Worker — fewer
  bytes of attack surface than an in-app OAuth handler.
- The Bearer JWT path already in production stays unchanged; cron and iOS
  authenticate by presenting a CF Access service token alongside the existing
  `Authorization: Bearer …`.

**Alternatives considered:**

- *In-app Google OAuth (`@react-oauth/google` + custom session on Worker):*
  pure-code path, no Zero Trust required. Cost: a custom session/cookie/
  refresh layer on the Worker, an OAuth callback endpoint, plus the audit
  surface that comes with rolling auth code. Rejected because CF Access does
  the same job with no code.
- *Auth.js / next-auth:* mature, but framework-heavy. Would require Pages
  Functions or a Node server for the auth backend. Mismatch with the
  Workers-only runtime philosophy.

### D3. Worker auth contract: Cf-Access JWT verification AND existing Bearer

**Decision:** Add `src/middleware/cf_access.ts` that verifies
`Cf-Access-Jwt-Assertion` against the team's public JWKS (cached). The
`jwtMiddleware` chain becomes:

```
on every gated request:
  if Cf-Access-Jwt-Assertion present:
    verify against JWKS, accept if email == eovidiu@gmail.com
    set c.var.principal = { kind: "user", email }
  else if Authorization: Bearer <jwt> present:
    existing jose.jwtVerify path
    set c.var.principal = { kind: "service" }
  else:
    401
```

**Rationale:** Two distinct auth audiences (browser users vs. machine
clients) need two distinct verification paths. CF Access JWTs are signed by
Cloudflare's team JWKS; the existing Bearer JWTs are signed by `JWT_SECRET`.
A single middleware that tries both keeps `c.var.principal` populated
uniformly for downstream handlers.

**Alternatives considered:**

- *Trust CF Access only and decommission Bearer:* would break cron + iOS.
- *Rotate the CF Access JWKS verification into the existing `jwtMiddleware`
  file:* tempting, but the two crypto paths are different enough (JWKS
  rotation, audience claim, email policy) that splitting into a dedicated
  middleware is clearer.

### D4. Subdomain `app.portage.eovidiu.co.uk` for the SPA

**Decision:** SPA on `app.portage.eovidiu.co.uk`. Worker stays on
`portage.eovidiu.co.uk`. Cookies set by CF Access apply to the `eovidiu.co.uk`
registrable domain, so cross-origin between the two subdomains is seamless.
CORS on the Worker explicitly allows the SPA origin and `localhost:5173` for
dev.

**Alternatives considered:**

- *`portage.eovidiu.co.uk/app/*`:* would require Worker fall-through routing
  to Pages, which is brittle. Splits routing across two products.
- *`portage-ui.eovidiu.co.uk`:* equivalent to the chosen path; just a name
  preference.

### D5. Stack: React 19 + Vite + Tailwind + shadcn/ui + TanStack Query + React Router v6

**Decision:** Standard SPA stack. shadcn/ui as the component primitive layer
(copy-paste, not vendored as a library). TanStack Query for all data
fetching with `refetchInterval: 30000` while polling. React Router v6 for
client-side routing.

**Rationale:** Matches the `fullstack-dev` skill defaults. shadcn primitives
keep us in control of every component and avoid bundle bloat. TanStack Query
handles staleness, retries, and cache invalidation declaratively, which
eliminates the kind of state-management code that tends to grow bugs.

**Alternatives considered:**

- *Next.js App Router (server-first):* SSR would be wasted given a single
  user; CF Pages Functions adds runtime complexity for no win.
- *SolidJS or Svelte:* solid choices but weaker shadcn parity and less
  testing-tool ecosystem (RTL).

### D6. Per-phase MSW mocks for testing-agent isolation

**Decision:** Each phase has its own `tests/mocks/<phase>.ts` MSW handler
file. Phase X's tests import only Phase X's mocks. The base test setup at
`tests/setup.ts` initializes a single MSW server but adds handlers per
describe block.

**Rationale:** The constraint was "each phase must be independently testable
by a testing agent." If Phase 1 tests import Phase 2's mocks (or vice versa),
a testing agent verifying Phase 1 must understand Phase 2 to run the suite —
defeating the isolation. Per-phase mocks keep each phase's test surface
self-contained.

### D7. Phase 4 gated on F-016b shipping

**Decision:** Phase 4 (multi-playlist console + the `/api/playlists`
endpoints) is paused, not abandoned, until F-016b (orchestrator wiring for
multi-playlist sync) lands.

**Rationale:** Until F-016b runs, `playlist_configs` rows other than
`__liked__` have no orchestrator behavior. Shipping a UI that lets the
operator add rows that do nothing is misleading. Phase 4 starts the day
F-016b's PR merges.

**Alternatives considered:**

- *Ship Phase 4 read-only first (list-only, no add):* would let the operator
  see the seeded `__liked__` row but offers no real value. Rejected.

### D8. Security and accessibility as Phase 7

**Decision:** A dedicated Phase 7 runs `skill-security-analyzer`,
`web-accessibility-checker`, and `pr-review-toolkit:silent-failure-hunter`
over the merged Phases 0–5. Deliverable: a markdown pen-test report
committed under `docs/security/2026-MM-DD-portage-ui-pen-test.md` in the
Worker repo (so it lives alongside the spec). Findings exploitable on the
Worker become new feature entries (F-0NN). Per-phase checklists are also
enforced in CI: `npm audit` gate, gitleaks, CSP review, vitest-axe.

**Rationale:** Security work that isn't a phase becomes implicit and
optional. Naming it as Phase 7 with a deliverable and a sign-off gate
matches how the rest of the project's features ship.

### D9. Worker features F-019..F-022, in `features.json`

**Decision:** Each Worker capability gets a feature entry in
`.harness/features.json` with `depends_on`, `scope`, and `coverage` fields,
matching the existing harness convention. F-019 (cf-access middleware +
CORS) is Phase 0 work. F-020 (`GET /api/me`) is Phase 0 work. F-021/F-022
(`GET`/`POST /api/playlists`) are Phase 4 work.

**Rationale:** The harness's TaskCompleted hook (5 stages: smoke, full,
coverage-claim, schema-drift, TODO markers) gives us TDD + 95% coverage
mechanically. Adding the new features to `features.json` puts them inside
that gate.

## Risks / Trade-offs

- **CF Access vendor lock-in** → Mitigation: the auth contract is a JWT
  header, replaceable by any IdP that signs equivalent claims. If we ever
  migrate, the middleware shape stays identical; only the JWKS source
  changes. Non-blocking for v1.
- **Service-token bypass too permissive** → Mitigation: scope the bypass
  policy to a single token, and rotate the existing JWT_SECRET in the same
  rotation cadence. Phase 0 acceptance criteria include a test that confirms
  a request with neither CF Access JWT nor a valid Bearer is rejected.
- **Pages CSP too strict for shadcn / Tailwind dev tooling** → Mitigation:
  Pages preview deploys can ship a relaxed CSP; the production CSP is
  restored at merge. CI test asserts the production `_headers` file has the
  full CSP.
- **Phase parallelization collides on `App.tsx` router table** → Mitigation:
  the lead pre-commits route stubs in App.tsx during Phase 0 (lead-stub
  pattern from the Worker's Sprint 2 retrospective in
  `.harness/context_summary.md`), so each phase only registers its own
  route component.
- **MSW handler explosion as phases pile up** → Mitigation: per-phase mock
  files keep blast radius bounded. A handler that needs to evolve (say,
  `/sync/status` adding a new field) is a Phase 0 contract change, not a
  per-phase worry.
- **Cloudflare team-name dependency on the JWKS URL** → Mitigation: read
  team name from the `CF_ACCESS_TEAM` env var, default to discovery via the
  Cf-Access-Jwt-Assertion's `iss` claim. Phase 0 ships a `wrangler.toml`
  binding plus a test that the middleware honors both paths.
- **F-016b slips, Phase 4 stays paused indefinitely** → Mitigation: this is
  acceptable. Phase 4 is independently scheduled. The dashboard, operator
  console, captures, and onboarding all ship without Phase 4.
- **Ovidiu performs the Zero Trust + Google Cloud setup once and forgets the
  detail** → Mitigation: the setup steps are documented at the bottom of
  this design document and again in `tasks.md` so Phase 0 can replay them
  if needed.

## Migration Plan

This is an additive change. There is no production cutover.

1. **Phase 0 deploys first.** Worker repo merges F-019 (cf-access middleware
   behind a feature flag — request-level toggle so production is unaffected
   until policies are configured) and F-020 (`GET /api/me`). UI repo gets
   created with scaffold + AuthGate + CI green.
2. **Cloudflare Zero Trust + Google IdP configured** (operator UI work, ~5
   minutes). Setup walkthrough below.
3. **First end-to-end smoke** through `app.portage.eovidiu.co.uk` →
   `app.portage.eovidiu.co.uk/api/me` resolves to the operator's Google
   email. Bearer JWT path verified unchanged via existing Worker tests.
4. **Phases 1, 2, 3, 5 ship in parallel** as Agent Teams teammates. Each
   merges as its own PR.
5. **F-016b ships in the Worker repo.** Phase 4 unpauses; F-021 + F-022 land
   in the Worker, multi-playlist console lands in the UI repo.
6. **Phase 7 runs.** Pen-test report committed; findings filed.
7. **Rollback strategy:** Remove the CF Access policy on
   `portage.eovidiu.co.uk/api/*` to fall back to Bearer-only auth. Disable
   the Pages deployment to take the SPA down. Worker continues to serve cron
   and iOS unchanged. Total time to rollback: minutes.

## Cloudflare Zero Trust + Google IdP setup walkthrough (operator)

These are the only inputs needed from Ovidiu before Phase 0 can deploy.

1. **Cloudflare dashboard → Zero Trust:**
   - If prompted to create a Zero Trust account, choose the free plan.
   - Take note of the team name (e.g., `eovidiu` → `https://eovidiu.cloudflareaccess.com`).
2. **Zero Trust → Settings → Authentication → Login methods → Add new → Google:**
   - App ID: paste the Google OAuth Client ID (created below).
   - Client secret: paste the Google OAuth Client Secret (created below).
   - Save.
3. **Google Cloud Console → APIs & Services → Credentials → Create
   credentials → OAuth client ID:**
   - Application type: Web application.
   - Name: `portage-ui-cf-access`.
   - Authorized redirect URI:
     `https://<team>.cloudflareaccess.com/cdn-cgi/access/callback`.
   - Save. Copy Client ID and Secret to step 2 above.
4. **Zero Trust → Access → Applications → Add an application → Self-hosted:**
   - Application name: `portage-ui`.
   - Session duration: 24 hours.
   - Application domain: add two entries:
     - `app.portage.eovidiu.co.uk`
     - `portage.eovidiu.co.uk` with path `/api/*`
   - Identity providers: select Google (and any defaults like One-time PIN if
     desired as backup; recommended off for a single-tenant tool).
   - Continue.
5. **Policies for the application:**
   - Policy 1 — `Allow operator`:
     - Action: Allow
     - Include: Emails → `eovidiu@gmail.com`
   - Policy 2 — `Bypass service tokens`:
     - Action: Bypass
     - Include: Service Auth → (create a new service token named
       `portage-cron-ios`, copy the Client ID + Secret to a secure store; add
       to Worker secrets as `CF_ACCESS_SERVICE_TOKEN_ID` and
       `CF_ACCESS_SERVICE_TOKEN_SECRET`).
   - Save.
6. **Update Worker secrets and `wrangler.toml`:**
   - `wrangler secret put CF_ACCESS_TEAM` (team name from step 1).
   - `wrangler secret put CF_ACCESS_AUD` (Application Audience tag from the
     application's Overview tab).
   - For cron / iOS that need to bypass, set Worker secret
     `CF_ACCESS_SERVICE_TOKEN_ID` and `CF_ACCESS_SERVICE_TOKEN_SECRET` from
     step 5.
7. **Smoke test:** open `https://app.portage.eovidiu.co.uk` → expect a
   redirect to Google sign-in → expect to land on the SPA after consent →
   `GET /api/me` returns `{ email: "eovidiu@gmail.com", kind: "user" }`.

## Open Questions

- **Subdomain locked in?** Default proceeds with `app.portage.eovidiu.co.uk`.
  Easy to change at Phase 0 time if Ovidiu prefers a different name.
- **Service-token rotation cadence?** The CF Access service token used by
  cron + iOS has no expiry by default. Recommend annual rotation aligned
  with the existing JWT bootstrap rotation. Filed as a Phase 7 follow-up,
  not blocking.
- **Pages preview environment policy?** Decision deferred: Phase 0 ships
  with preview deploys public (no CF Access) so the testing agent can hit
  preview URLs. Production is fully gated.
- **iOS app's CF Access integration timing?** The iOS app does not exist
  yet. When it ships, the captures POST path needs the service-token
  headers. Captured as a forward-looking note; not blocking.
