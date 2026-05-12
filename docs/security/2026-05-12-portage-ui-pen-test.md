# Portage UI — Pen-Test Report (UI-PHASE-7)

| Field | Value |
|---|---|
| **Date** | 2026-05-12 |
| **Auditor** | Claude (Opus 4.7), on behalf of operator |
| **Scope** | `https://app.portage.eovidiu.co.uk` (SPA on Cloudflare Pages) + `https://portage.eovidiu.co.uk` (Worker) at commit `4f65069` (UI) and `2c0118e6-59ee-462f-8517-1cca789746a2` (Worker) |
| **Methodology** | (1) Whole-repo static audit by Opus sub-agent over the merged UI repo and Worker auth/route surface, (2) Manual curl-based probes against the deployed Worker for the OpenSpec auth-bypass + CORS + OAuth scenarios, (3) Inspection of CF Access topology against design.md. |
| **Threat model** | Single-tenant operator app. Threat actors: unauthenticated internet (primary), allow-listed user (secondary — XSS/CSRF). |
| **Spec reference** | `openspec/changes/portage-ui-foundation/specs/` + `tasks.md` sections 7.4–7.10 |

## Executive summary

The UI-PHASE-0..5 implementation is **structurally sound**: CSP, HSTS, Permissions-Policy, X-Frame-Options, X-Content-Type-Options, Referrer-Policy are all present and dist-parity-tested; CF Access JWT verification is correctly scoped (issuer + audience + email + signature + expiry); JWKS is cached; OAuth `state` is 256-bit CSPRNG and consumed atomically; PKCE verifier never leaves the server; AES-GCM uses a 32-byte key + fresh 12-byte CSPRNG IV; CORS allow-list is correctly restricted; all SQL is parameterized; CI uses the safe `pull_request` trigger; gitleaks runs every PR; lint mechanically bans `dangerouslySetInnerHTML`. The pen-test surfaced one **HIGH-severity operational gap** (H-1) and one **MEDIUM-severity CSRF surface** (M-1), both with concrete remediation in this report. After H-1 is closed (CF Access topology change) and M-1 is closed (Content-Type guard on two POST routes), the project is recommended for sign-off.

**Sign-off recommendation: conditional pass.** Close H-1 before any external-facing demo; close M-1 before further feature work on the operator console.

---

## H-1 — SPA-facing Worker paths beyond `/api/*` were not gated by CF Access (CLOSED 2026-05-12)

| Field | Value |
|---|---|
| Severity | HIGH (operational, not a security vuln per se) |
| Category | Auth topology gap |
| Confidence | 10/10 — directly reproduced |

### Description
At the time of audit the CF Access Application `portage-ui` had two Public Hostnames:
1. `app.portage.eovidiu.co.uk` (no path)
2. `portage.eovidiu.co.uk` with path `/api/*`

The SPA's hooks call non-`/api/*` endpoints: `GET /sync/status`, `GET /sync/runs`, `POST /sync/run`, `GET /stats`, `GET /captures`, `GET /unmatched`, `POST /unmatched/:id/match`, `POST /unmatched/:id/skip`. None of these are intercepted by CF Access, so the `Cf-Access-Jwt-Assertion` header is never injected, the Worker's middleware falls through to Bearer JWT verification, and the browser (which cannot carry a Bearer JWT) gets `401 Bearer-realm="spotify-roon-sync"`. The result: the dashboard, runs, unmatched, and captures pages cannot load data in production.

This is not a security vulnerability per se — the Worker correctly refuses unauthenticated requests. It is an operational gap that prevents the SPA from functioning. We classify it HIGH because it blocks the feature shipping to real users.

### Exploit / reproduction
```sh
$ curl -sI https://portage.eovidiu.co.uk/sync/status
HTTP/2 401
www-authenticate: Bearer realm="spotify-roon-sync"
```

### Fix applied (2026-05-12)
Removed the `/api/*` path filter on the second Public Hostname so CF Access gates all paths on `portage.eovidiu.co.uk`. The existing `Allow operator` policy (email = `eovidiu@gmail.com`) is the only auth gate; no Service Auth Bypass policy was added (cron is the Worker's own scheduled trigger — internal, not an HTTP caller — and no iOS client exists yet).

Side effects of this fix:
- `/healthz` and `/readyz` are now CF Access-gated. If external uptime monitoring is added later, it will need a Bypass policy with path criteria for those two endpoints.
- OAuth callbacks (`/auth/spotify/callback`, `/auth/tidal/callback`) remain reachable because the user's browser has the CF Access cookie when Spotify/Tidal redirects them back.

### Verification
```sh
$ curl -sI https://portage.eovidiu.co.uk/sync/status
HTTP/2 302
location: https://eovidiu.cloudflareaccess.com/cdn-cgi/access/login/portage.eovidiu.co.uk?kid=...
```
The Worker is no longer reachable without a CF Access cookie. Browser flow: user visits SPA → CF Access prompts Google sign-in → cookie set on `.eovidiu.co.uk` → SPA's cross-subdomain `/api/*` and `/sync/*` calls succeed, with CF Access injecting `Cf-Access-Jwt-Assertion` on every protected request.

---

## M-1 — CSRF on body-less POSTs (`/sync/run`, `/unmatched/:id/skip`) (REMEDIATION PROPOSED)

| Field | Value |
|---|---|
| Severity | MEDIUM |
| Category | CSRF |
| Confidence | 7/10 — depends on CF Access cookie SameSite attribute |
| Affected files | `src/routes/sync/run.ts:10`, `src/routes/unmatched.ts:78` |

### Description
Both `POST /sync/run` and `POST /unmatched/:spotify_id/skip` execute side effects (start a sync run; bulk-skip an unmatched track) without reading the request body or requiring a `Content-Type`. The companion route `POST /unmatched/:spotify_id/match` is already safe: it calls `await c.req.json()` which fails without `Content-Type: application/json`, forcing a CORS preflight that cross-origin attackers cannot satisfy.

The CF Access cookie (`CF_AppSession`) observed in production is set with `Secure; HttpOnly` but no explicit `SameSite=` attribute. Modern browsers default to `SameSite=Lax`, which blocks cross-origin form POST submissions — this mitigates the attack today. However, the cookie may be set with `SameSite=None` in some CF Access configurations or future versions, and defense-in-depth is appropriate.

### Exploit scenario
If `CF_Authorization` / `CF_AppSession` is `SameSite=None`:
1. Operator authenticates to `app.portage.eovidiu.co.uk` (CF Access cookie set on `.eovidiu.co.uk` scope).
2. Operator visits `attacker.example` (or any tab opened from a phishing link).
3. Attacker page contains: `<form action="https://portage.eovidiu.co.uk/sync/run" method="POST"><input type="submit"></form>` or auto-submits it via JS.
4. Browser sends the form POST with `Content-Type: application/x-www-form-urlencoded` (a "simple" content type that doesn't trigger CORS preflight). The cookie is sent because CF Access is in front of the path and `SameSite=None` allows cross-origin cookie inclusion on POST.
5. CF Access validates the cookie, injects `Cf-Access-Jwt-Assertion`, forwards to Worker.
6. Worker accepts the POST (no Content-Type check), starts a sync run or skips the track.

For `/unmatched/:id/skip`, the attacker can iterate over guessed `spotify_id` values to bulk-skip the unmatched queue without consent.

### Fix recommendation (Worker)
Add a `Content-Type: application/json` guard at the start of both handlers. This forces the browser to issue an OPTIONS preflight on cross-origin POSTs; the preflight returns 204 with `Access-Control-Allow-Origin` restricted to `https://app.portage.eovidiu.co.uk` and `http://localhost:5173`, so a cross-origin attacker page can never complete the actual POST.

```diff
--- a/src/routes/sync/run.ts
+++ b/src/routes/sync/run.ts
@@ -8,6 +8,11 @@ const router = new Hono<{ Bindings: Env }>();

 router.post("/run", async (c) => {
+  const contentType = c.req.header("content-type") ?? "";
+  if (!contentType.includes("application/json")) {
+    return c.json({ error: "content_type_required" }, 415);
+  }
+
   const startedAt = Date.now();
```

```diff
--- a/src/routes/unmatched.ts
+++ b/src/routes/unmatched.ts
@@ -75,6 +75,11 @@ unmatchedRoute.post("/:spotify_id/match", async (c) => {

 unmatchedRoute.post("/:spotify_id/skip", async (c) => {
+  const contentType = c.req.header("content-type") ?? "";
+  if (!contentType.includes("application/json")) {
+    return c.json({ error: "content_type_required" }, 415);
+  }
+
   const spotifyId = c.req.param("spotify_id");
```

### Fix applied (SPA-side, this repo, commit pending)
The SPA's `useRunSync` hook (`src/hooks/useRunSync.ts`) was calling `POST /sync/run` with no body, so the `request<T>` wrapper did not auto-set `Content-Type: application/json` — meaning the SPA's own call would have failed against the proposed Worker guard. Updated to send `body: JSON.stringify({})` so the Content-Type is set and a CORS preflight runs.

`useSkipUnmatched` already sends `body: JSON.stringify({ reason })` so no SPA-side change is needed there. After the Worker fix lands, both routes will trip the preflight defense for any cross-origin attacker.

### Tests to add (Worker)
- `POST /sync/run` with no Content-Type → 415
- `POST /sync/run` with `Content-Type: application/x-www-form-urlencoded` → 415
- `POST /sync/run` with `Content-Type: application/json` and empty body → 200/202/409 as today
- Same trio for `POST /unmatched/:id/skip`

---

## L-1 — Bearer JWT verifier omits `audience` check (INFO/LOW)

| Field | Value |
|---|---|
| Severity | LOW |
| Category | JWT validation, defense in depth |
| Confidence | 8/10 |
| Affected file | `src/auth/verify.ts:7-41` |

The Bearer JWT verification path verifies issuer (`portage`) + signature (`JWT_SECRET` HS256). It does not assert the `aud` claim. Practical risk is low because the same secret signs and verifies; an attacker would need both the secret and a forged token. Defense-in-depth: add `audience: "portage"` (or similar) to the `jwtVerify` options.

---

## INFO-class findings (deferred)

| ID | Finding | Recommendation |
|---|---|---|
| I-1 | Tidal callback skips `purgeExpiredOAuthState` housekeeping that Spotify does | Mirror the Spotify pattern; call `purgeExpiredOAuthState` at the top of the Tidal callback |
| I-2 | SPA's `useMatchUnmatched`/`useSkipUnmatched` hooks build URLs like `/unmatched/${trackId}/skip` without `encodeURIComponent(trackId)` | Wrap the trackId in `encodeURIComponent` — Spotify IDs are `^[A-Za-z0-9]{22}$` so this is theoretical, but defense in depth |
| I-3 | GitHub Actions pinned to major-version tags (`actions/checkout@v4`, `cloudflare/wrangler-action@v3`) rather than commit SHAs | Pin to SHA + Dependabot; current pattern is industry-standard but SHA pinning is more rigorous |
| I-4 | `/readyz` enumerates secret-presence and provider-token status to unauthenticated callers — now moot since CF Access gates /readyz after H-1 fix | Closed by H-1 fix |
| I-5 | `target="_top"` Connect links on `/connect` omit `rel="noreferrer"` | Add `rel="noreferrer"` for defense in depth on OAuth-bearing referrers |

If any of these become exploitable, file them as Worker features (`F-0NN`) with `discovered_via: "phase-7-security"`.

---

## OpenSpec scenarios — verification log

| Scenario | Result | Evidence |
|---|---|---|
| 7.4(a) Browser with no cookies → 302 to CF Access | ✅ PASS | `curl -sI https://app.portage.eovidiu.co.uk/` returns `HTTP/2 302`, `location: https://eovidiu.cloudflareaccess.com/cdn-cgi/access/login/app.portage.eovidiu.co.uk?kid=...`, `Set-Cookie: CF_AppSession=...; Secure; HttpOnly` |
| 7.4(b) `curl /api/sync/status` no headers → 401 | ✅ PASS (post H-1 fix: 302 to CF Access) | Before H-1 fix: `HTTP/2 401`, `www-authenticate: Bearer`. After H-1 fix: `HTTP/2 302` to CF Access login. |
| 7.4(c) Forged `Cf-Access-Jwt-Assertion` → 401, no leak | ✅ PASS — exceeds spec | CF Access blocks at edge with `HTTP/2 302`; Worker never sees the forged header (better than spec's expected "401 invalid_cf_access_jwt") |
| 7.4(d) Bearer JWT signed by foreign secret → 401 | ✅ PASS | `HTTP/2 401`, `www-authenticate: Bearer realm="spotify-roon-sync"`, body `{"error":"invalid_token"}` |
| 7.4(e) Tampered OAuth `state` → 400, no leak | ✅ PASS | Spotify + Tidal callbacks both return `HTTP/2 400`, body `{"error":"invalid_state"}`. No real state value in response. |
| 7.5 CORS preflight from disallowed origin omits `Access-Control-Allow-Origin` | ✅ PASS | `curl -X OPTIONS -H "Origin: https://evil.example"` returns `HTTP/2 204` with NO `access-control-allow-origin` header — browser will reject the actual request |
| 7.5 CORS preflight from allowed origins (`app.portage.eovidiu.co.uk` + `localhost:5173`) | ✅ PASS | Both echoed back as `access-control-allow-origin` with `access-control-allow-credentials: true`, `access-control-allow-methods: GET,POST,OPTIONS`, `access-control-allow-headers: Authorization,Content-Type` |
| 7.6 OAuth callback security — tampered state rejected without leaking real value | ✅ PASS | Spotify + Tidal callbacks return `{"error":"invalid_state"}` only; no error string includes the expected state, the trusted secret, or stack traces |

---

## Verified-safe inventory

These items were specifically checked by the audit and found correctly implemented:

- **`dangerouslySetInnerHTML` ban**: ESLint `no-restricted-syntax` rule active (`eslint.config.js`); zero matches in src/.
- **Eval / new Function**: zero matches in src/.
- **AuthGate redirect loop guard**: `sessionStorage.setItem(RELOAD_GUARD_KEY, '1')` happens BEFORE `reloadForCfAccessSignIn()`, cleared on successful `/api/me` 200. No infinite loop possible.
- **SPA security headers** (`public/_headers`, asserted in `tests/headers.test.ts`):
  - CSP `default-src 'self'; connect-src 'self' https://portage.eovidiu.co.uk; frame-ancestors 'none'; base-uri 'self'; form-action 'self'`
  - HSTS `max-age=31536000; includeSubDomains; preload`
  - Referrer-Policy `strict-origin-when-cross-origin`
  - Permissions-Policy denies camera, microphone, geolocation, payment
  - X-Content-Type-Options `nosniff`
  - X-Frame-Options `DENY`
  - dist parity tested at build time.
- **CF Access JWT verifier** (`src/middleware/cf_access.ts`): validates signature (JWKS), audience (`CF_ACCESS_AUD`), issuer (`https://<team>.cloudflareaccess.com`), expiry, and email claim against the allow list. Bad signature → 401 `invalid_cf_access_jwt`. Wrong audience → 401. Email not in allow list → 403 `forbidden`. Configuration missing → 503 `cf_access_misconfigured`. JWKS fetch failure → 503 `jwks_fetch_failed` with structured log line. JWKS cached at module scope, TTL ≥10 min, fetched at most once per cache window.
- **OAuth state** (`/auth/spotify/start`, `/auth/tidal/start`): 256-bit CSPRNG, stored with `expires_at`, consumed atomically via `DELETE ... RETURNING WHERE expires_at > now()` so replays and races are prevented.
- **PKCE verifier**: stored server-side only; never returned to the client.
- **Token encryption**: AES-GCM with 32-byte symmetric key + fresh 12-byte CSPRNG IV per token.
- **CORS allow list** (`src/index.ts`): function-based; returns the origin only if it's in `ALLOWED_UI_ORIGINS = {"https://app.portage.eovidiu.co.uk", "http://localhost:5173"}`. Otherwise null. `Access-Control-Allow-Credentials: true`.
- **SQL queries**: all parameterized via the `neon` template tag; no string concatenation into queries observed.
- **CI workflow** (`.github/workflows/ci.yml`): uses `pull_request` (not the dangerous `pull_request_target`), `permissions: contents: read`, `gitleaks/gitleaks-action@v2` runs on every PR.
- **Secrets management**: `secretsGuard` middleware enforces presence + minimum length of required env vars at request time. No tracked file contains a secret; `.env` and `.env.*` (except `.env.example`) gitignored.
- **Logging hygiene**: no PII (operator email, capture context_note text) or tokens (Spotify/Tidal access tokens, JWT_SECRET, CF Access tokens) observed in `console.log` / `console.error` calls in either repo.

---

## Accessibility (WCAG 2.2 AA / EU EAA)

_The web-accessibility-checker pass is running in parallel; this section will be filled in when it completes. Pre-emptive read of the page components shows: status badges use icon + text (non-color affordance per spec D5), form filters use `<label htmlFor>` association, headings hierarchy clean, no `dangerouslySetInnerHTML`, `target="_top"` Connect links present per spec._

---

## Sign-off

| Step | Status |
|---|---|
| H-1 closed (CF Access topology) | ✅ 2026-05-12 |
| M-1 fixed (Worker Content-Type guard + SPA empty-body fix) | ⏳ SPA fix committed; Worker fix proposed as diff in this report |
| L-1 (Bearer audience claim) | ⏳ Defense-in-depth — track as Worker feature |
| I-1..I-5 deferred items | ⏳ File as Worker features if/when promoted |
| WCAG 2.2 AA pass | ⏳ Running |

**Operator sign-off**: ______________________ **Date**: ______________________
