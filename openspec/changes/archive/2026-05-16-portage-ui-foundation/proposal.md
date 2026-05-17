## Why

Portage runs as a headless Cloudflare Worker today: scheduled cron syncs Spotify
Liked Songs into a Tidal playlist, with a JSON API for status and operator
actions. There is no UI, so observability lives in `wrangler tail` and operator
intervention (resolving unmatched tracks, configuring multi-playlist support
under F-016/017/018) is impossible without `curl`. We need a single-tenant web
UI that surfaces sync state, lets the operator act on it, and onboards Spotify
+ Tidal OAuth — without coupling the Worker to UI concerns or burning its
50-subrequest free-tier budget.

## What Changes

- Stand up a **new private GitHub repository `eovidiu/portage-ui`** for the
  React 19 + Vite SPA. Code is physically separated from the Worker repo;
  independent CI, independent deploy.
- Deploy the SPA to **Cloudflare Pages** at `app.portage.eovidiu.co.uk` (custom
  domain on the existing zone).
- Adopt **Cloudflare Access (Google IdP)** as the SPA's authentication layer.
  Identity is enforced at the edge before requests reach the Worker, with no
  auth code in the SPA.
- Add Worker-side support for the new browser auth path: Cloudflare Access JWT
  verification middleware that coexists with the existing Bearer JWT path used
  by cron + iOS (cron and iOS continue to authenticate via a CF Access service-
  token bypass).
- Add a `GET /api/me` endpoint so the SPA can identify the authenticated user.
- Add `GET /api/playlists` and `POST /api/playlists` endpoints to expose the
  multi-playlist registry (F-016) to the operator console. **Gated on F-016b
  shipping** — the orchestrator wiring must land before these endpoints have
  meaningful behavior.
- Build the SPA in independently-testable, parallelizable phases:
  Phase 0 (foundation), Phase 1 (onboarding & health), Phase 2 (dashboard &
  manual sync), Phase 3 (operator console), Phase 4 (multi-playlist console),
  Phase 5 (captures viewer), Phase 7 (security & accessibility hardening).
  Phase 6 (track browser) is sketched as future work, not in scope.
- Drop Hostinger from the deployment options. Cloudflare-native.

This is a **non-breaking** addition. The Worker's existing endpoints, cron
schedule, OAuth flows, and Bearer JWT auth path all continue to function
unchanged. The CF Access middleware is added as a second valid auth source,
not a replacement.

## Capabilities

### New Capabilities

- `cf-access-auth`: Cloudflare Access JWT verification middleware on the
  Worker. Validates `Cf-Access-Jwt-Assertion` headers against the team's
  public JWKS, accepts when `email == eovidiu@gmail.com`, populates
  `c.var.principal`. Coexists with existing Bearer JWT middleware via a
  service-token bypass policy on the CF Access application.
- `api-me`: `GET /api/me` endpoint that returns
  `{ email: string, kind: "user" | "service" }` from the request principal.
  Used by the SPA `AuthGate` to confirm authentication and display the
  signed-in identity.
- `playlists-list`: `GET /api/playlists` endpoint that returns the rows of
  `playlist_configs` (the registry seeded by F-016) so the operator console
  can render per-playlist status cards.
- `playlists-add`: `POST /api/playlists` endpoint that appends a Spotify
  playlist id to the configured set. Validates the id format
  (`^[A-Za-z0-9]{22}$`), calls `fetchSpotifyPlaylistName` to populate the
  display name, and persists via the F-016 DB helpers.
- `web-ui-shell`: Cloudflare Pages SPA scaffold — Vite + React 19 + Tailwind
  + shadcn/ui + TanStack Query + React Router v6, with `lib/api.ts` fetch
  wrapper, `AuthGate` component, base layout, CI workflow (lint, typecheck,
  unit, a11y, security audit, deploy), and `_headers` for CSP / HSTS /
  referrer-policy / permissions-policy.
- `web-ui-onboarding`: `/connect` route — Spotify card, Tidal card, and
  health pills sourced from `/readyz` and `/api/me`. OAuth deep links to the
  Worker's existing `/auth/spotify/start` and `/auth/tidal/start`.
- `web-ui-dashboard`: `/dashboard` route — latest run summary, stats tiles
  (match rate, runs in last 7d, lag hours), and a "Run sync now" button that
  posts to `/sync/run` and handles 200/202/409 distinctly. Polls every 30s
  while a run is `running`.
- `web-ui-operator`: `/runs` route (paginated history, filterable by status
  and `error_code`) and `/unmatched` route (queue with manual match / skip,
  graceful fallback to manual Tidal id paste while F-012 R3/R4 candidates
  remain `[]`).
- `web-ui-multiplaylist`: `/playlists` route — list of `playlist_configs`,
  per-playlist status cards, and an "Add Spotify playlist by ID" form that
  posts to `/api/playlists`. Gated on F-016b shipping.
- `web-ui-captures`: `/captures` route — paginated read of `/captures` with
  filters by `source` (siri/share_sheet/shortcut/manual) and `match_status`
  (matched/unmatched/pending).

### Modified Capabilities

None. This is the first OpenSpec change in this project; existing Worker
features (F-001..F-018) live under `docs/specs/` and are not duplicated as
OpenSpec capabilities.

## Impact

- **New repo:** `eovidiu/portage-ui` (private). Independent CI / deploy
  pipeline.
- **Worker code:** `src/middleware/cf_access.ts` (new), `src/index.ts`
  (CORS + middleware wiring), `src/routes/me.ts` (new),
  `src/routes/playlists.ts` (new for Phase 4), `src/db/playlist_configs.ts`
  (extend with `listAll`).
- **Worker tests:** new unit tests for cf-access middleware, /api/me,
  /api/playlists. Maintains the existing 95% coverage gate via the harness's
  TaskCompleted hook.
- **Worker features.json:** adds F-019 (cf-access), F-020 (api-me), F-021
  (playlists-list), F-022 (playlists-add).
- **External dependencies (Worker):** none new (uses `jose` already on the
  dependency tree for JWKS verification).
- **External dependencies (UI):** React 19, Vite, Tailwind, shadcn/ui,
  TanStack Query, React Router, Vitest, RTL, MSW, Playwright, vitest-axe.
  No `dangerouslySetInnerHTML` permitted; eslint rule enforces.
- **Cloudflare account:** Zero Trust enabled (free tier), Google IdP
  configured, one Access Application (`portage-ui`) covering
  `app.portage.eovidiu.co.uk` and `portage.eovidiu.co.uk/api/*` with allow +
  service-token bypass policies.
- **Google Cloud:** one new OAuth Client ID + Secret used only by Cloudflare
  Access. Authorized redirect URI:
  `https://<team>.cloudflareaccess.com/cdn-cgi/access/callback`.
- **Subrequest budget:** unchanged. The SPA is static assets served by Pages;
  it does not contribute to the Worker's 50-subrequest invocation cap.
- **Security surface:** new auth boundary at the Cloudflare edge. Phase 7
  exercises it with a documented pen-test plan; findings flow back into the
  Worker spec as new features (F-0NN) if exploitable.
- **Operational impact:** twice-daily cron, OAuth flows, advisory locks, and
  the Bearer JWT path for iOS are unchanged. CF Access bypass tokens are
  scoped narrowly to the existing service callers.
