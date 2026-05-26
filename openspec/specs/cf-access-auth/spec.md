# cf-access-auth Specification

## Purpose
TBD - promoted from archived change portage-ui-foundation (2026-05-16). Update Purpose after promotion.
## Requirements
### Requirement: Verify Cloudflare Access JWT against team JWKS

The Worker SHALL verify the `Cf-Access-Jwt-Assertion` header on every
authenticated request by retrieving the team's public JWKS, validating the
JWT's signature, audience (`aud` matches the configured `CF_ACCESS_AUD`),
issuer (`iss` matches `https://<team>.cloudflareaccess.com`), and expiry.

#### Scenario: Valid Cf-Access JWT with correct audience and operator email
- **WHEN** a request includes a `Cf-Access-Jwt-Assertion` header signed by the
  team JWKS, with `aud == CF_ACCESS_AUD` and `email == OPERATOR_EMAIL`
- **THEN** the middleware sets `c.var.principal = { kind: "user", email }`
  and the handler executes normally

#### Scenario: Cf-Access JWT signed by a different key
- **WHEN** a request includes a `Cf-Access-Jwt-Assertion` header whose
  signature does not verify against the team JWKS
- **THEN** the middleware responds with `401 Unauthorized` and a JSON body
  `{ "error": "invalid_cf_access_jwt" }`, without leaking the offending
  token in the response or logs

#### Scenario: Cf-Access JWT with email that does not match the allow rule
- **WHEN** a request includes a valid Cf-Access JWT but the `email` claim
  is anything other than the configured `OPERATOR_EMAIL`
- **THEN** the middleware responds with `403 Forbidden` and the request does
  not reach the handler

### Requirement: Coexist with existing Bearer JWT path

The Worker SHALL accept either a Cloudflare Access JWT or a Bearer JWT signed
by `JWT_SECRET` as valid authentication. Cron and iOS clients continue to
authenticate via the Bearer path.

#### Scenario: Bearer JWT only, no Cf-Access header
- **WHEN** a request includes only `Authorization: Bearer <jwt>` signed by
  `JWT_SECRET` with the expected subject `owner`
- **THEN** the middleware sets `c.var.principal = { kind: "service" }` and
  the handler executes normally

#### Scenario: Both Cf-Access JWT and Bearer JWT present
- **WHEN** a request includes both `Cf-Access-Jwt-Assertion` and
  `Authorization: Bearer <jwt>` headers
- **THEN** the middleware verifies the Cf-Access JWT first; if it is valid
  the request is treated as `kind: "user"`; if the Cf-Access JWT is invalid
  the middleware does not fall back to the Bearer path and responds 401

#### Scenario: Neither auth source present
- **WHEN** a request includes neither `Cf-Access-Jwt-Assertion` nor
  `Authorization: Bearer ...` and the route is not in the public skip list
  (`/healthz`, `/auth/*/callback`)
- **THEN** the middleware responds with `401 Unauthorized`

### Requirement: Cache the team JWKS to avoid per-request fetches

The middleware SHALL cache the team JWKS in module scope with a TTL of at
least 10 minutes. Subsequent requests within the TTL MUST NOT trigger a
network fetch.

#### Scenario: Two requests inside the cache TTL
- **WHEN** two authenticated requests arrive within 60 seconds of each other
- **THEN** the JWKS endpoint is fetched at most once across the two requests

#### Scenario: JWKS endpoint unreachable
- **WHEN** the JWKS fetch fails (network error or non-2xx response)
- **THEN** the middleware responds with `503 Service Unavailable` and a
  structured log line is emitted with `error_code: "jwks_fetch_failed"`

### Requirement: CORS allows the SPA origin

The Worker SHALL respond to CORS preflight requests by allowing the origins
`https://<UI_ORIGIN>` and `http://localhost:5173`, the methods
`GET`, `POST`, `OPTIONS`, and the headers `Authorization` and `Content-Type`,
with `Access-Control-Allow-Credentials: true`.

#### Scenario: SPA origin preflight
- **WHEN** an `OPTIONS` request arrives with `Origin: https://<UI_ORIGIN>`
- **THEN** the response is `204 No Content` with the matching
  `Access-Control-Allow-*` headers

#### Scenario: Disallowed origin
- **WHEN** an `OPTIONS` request arrives with `Origin: https://evil.example`
- **THEN** the response omits `Access-Control-Allow-Origin`
