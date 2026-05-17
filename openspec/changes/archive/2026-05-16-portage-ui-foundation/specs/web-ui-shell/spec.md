## ADDED Requirements

### Requirement: SPA repository scaffold

The `eovidiu/portage-ui` repository SHALL contain a Vite + React 19 + TypeScript
+ Tailwind CSS + shadcn/ui scaffold with TanStack Query, React Router v6,
Vitest, React Testing Library, MSW, and vitest-axe configured. The scaffold
MUST build (`npm run build`), lint clean (`npm run lint`), typecheck clean
(`npm run typecheck`), and test green (`npm test`) on a fresh clone.

#### Scenario: Fresh clone build
- **WHEN** a clean checkout of `eovidiu/portage-ui` runs `npm install &&
  npm run build`
- **THEN** the build succeeds with zero warnings and produces `dist/`

#### Scenario: All CI gates green on the empty scaffold
- **WHEN** the CI workflow runs on the initial scaffold commit
- **THEN** lint, typecheck, unit tests, a11y tests, dep audit, and gitleaks
  all pass

### Requirement: Fetch wrapper for authenticated API calls

The SPA SHALL provide a `lib/api.ts` module with a `request<T>(path, init)`
function that issues `fetch` calls with `credentials: "include"`, adds
`Content-Type: application/json` for JSON bodies, parses the response as JSON,
and throws a typed `ApiError` containing the HTTP status when the response
is not 2xx.

#### Scenario: 200 response with JSON body
- **WHEN** `request("/api/me")` is called and the Worker responds 200 with
  body `{ "email": "...", "kind": "user" }`
- **THEN** the function resolves to the parsed object

#### Scenario: 401 response
- **WHEN** any `request(...)` call receives a 401
- **THEN** the wrapper throws `ApiError` with `status === 401` and the
  AuthGate listener clears any cached identity and redirects the browser
  to the Cloudflare Access login URL

### Requirement: AuthGate component

The SPA SHALL render an `<AuthGate>` component at the route tree root that
calls `GET /api/me` once at mount; if the response is 401 or 302, the user
is redirected to the Cloudflare Access login flow; if the response is 200
the gated children render with the principal in context.

#### Scenario: Authenticated bootstrap
- **WHEN** the SPA loads and `GET /api/me` resolves 200 with a user
  principal
- **THEN** the gated children render and `useMe()` returns the principal

#### Scenario: Unauthenticated bootstrap
- **WHEN** the SPA loads and `GET /api/me` returns 401
- **THEN** the browser is redirected to
  `https://<team>.cloudflareaccess.com/cdn-cgi/access/login/<app-uuid>?kid=<>...`
  and the gated children do not render

### Requirement: Security headers on production deploys

The Pages production deployment SHALL serve `_headers` with at minimum:
`Content-Security-Policy` restricting `default-src` to `'self'` and
`connect-src` to `'self' https://portage.eovidiu.co.uk`,
`Strict-Transport-Security: max-age=31536000; includeSubDomains; preload`,
`Referrer-Policy: strict-origin-when-cross-origin`, and a
`Permissions-Policy` denying camera, microphone, geolocation, and payment.

#### Scenario: Production deploy serves headers
- **WHEN** a request reaches the production Pages URL
  `https://app.portage.eovidiu.co.uk/`
- **THEN** the response includes the headers above with the values above

### Requirement: CI quality gates

The repository SHALL include a GitHub Actions workflow that, on every push
and pull request, runs lint, typecheck, unit tests with coverage,
accessibility tests, `npm audit --production` (failing on `high` or above),
and `gitleaks detect`. A separate workflow deploys to Cloudflare Pages on
push to `main`.

#### Scenario: PR with high-severity dependency
- **WHEN** a pull request introduces a dependency with a known `high`
  severity advisory
- **THEN** the CI workflow fails before merge

#### Scenario: PR with a leaked secret
- **WHEN** a pull request introduces a string matching gitleaks rules
- **THEN** the CI workflow fails before merge
