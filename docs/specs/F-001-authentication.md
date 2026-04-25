# F-001: API authentication (JWT)

## Summary

All API routes except `/healthz` and OAuth callbacks MUST require a valid JWT, signed with HS256 using a 256-bit secret stored in Cloudflare Secrets. A single bootstrap token, valid for one year, is minted at deployment time. The auth middleware rejects missing, malformed, expired, or signature-invalid tokens with HTTP 401.

## Linked tests

[T-001](../tests/T-001-authentication.md)

## Dependencies

- Cloudflare Secrets (`JWT_SECRET` env binding)
- `jose` library (or equivalent) for JWT verification
- F-014 (`/healthz` is the only unauthenticated GET in the surface)

## Behavioural specification

### Bootstrap token issuance

- **Given** a fresh deployment with `JWT_SECRET` set
- **When** the operator runs the bootstrap script with subject `owner`
- **Then** the script outputs a JWT signed with HS256, expiry 365 days, claims `{ "sub": "owner", "iss": "spotify-roon-sync", "iat": <now>, "exp": <now+365d> }`

### Authenticated request, valid token

- **Given** a bootstrap JWT in the `Authorization: Bearer <jwt>` header
- **When** the client calls `GET /sync/status`
- **Then** the middleware validates signature, issuer, expiry, and subject
- **And** the request proceeds to the route handler with `ctx.subject = "owner"`

### Authenticated request, missing token

- **Given** no `Authorization` header
- **When** the client calls any authenticated route
- **Then** the response is HTTP 401 with body `{"error": "missing_token"}`

### Authenticated request, malformed token

- **Given** an `Authorization` header that does not parse as `Bearer <three-segment-token>`
- **When** the client calls any authenticated route
- **Then** the response is HTTP 401 with body `{"error": "malformed_token"}`

### Authenticated request, signature mismatch

- **Given** a JWT signed with a different secret
- **When** the client calls any authenticated route
- **Then** the response is HTTP 401 with body `{"error": "invalid_signature"}`

### Authenticated request, expired token

- **Given** a JWT with `exp` in the past
- **When** the client calls any authenticated route
- **Then** the response is HTTP 401 with body `{"error": "expired_token"}`

### Authenticated request, wrong issuer

- **Given** a JWT signed correctly but with `iss` other than `spotify-roon-sync`
- **When** the client calls any authenticated route
- **Then** the response is HTTP 401 with body `{"error": "invalid_issuer"}`

## Detailed requirements

| ID | Requirement |
|---|---|
| F-001-R1 | The system MUST validate JWT signature using HS256 and the `JWT_SECRET` env binding. |
| F-001-R2 | The system MUST reject any JWT whose `exp` claim is in the past relative to server time. |
| F-001-R3 | The system MUST reject any JWT whose `iss` claim is not `spotify-roon-sync`. |
| F-001-R4 | The system MUST reject any JWT whose `sub` claim is not in the configured allowlist (initially `["owner"]`). |
| F-001-R5 | The system MUST NOT log JWT contents or `JWT_SECRET` in any form. |
| F-001-R6 | The middleware MUST be applied as a single Hono `use()` call covering all authenticated routes. |
| F-001-R7 | The bootstrap script MUST refuse to mint a token if `JWT_SECRET` is shorter than 32 bytes. |
| F-001-R8 | Token verification MUST complete in under 5 ms per request on Cloudflare Workers. |
| F-001-R9 | The 401 response body MUST be a JSON object with a single `error` field whose value MUST be one of: `missing_token`, `malformed_token`, `invalid_signature`, `expired_token`, `invalid_issuer`, `invalid_subject`. |
| F-001-R10 | The middleware MUST attach the validated `subject` to the request context for downstream handlers. |
| F-001-R11 | The system MAY accept tokens via the `Authorization` header only; query-parameter tokens MUST NOT be accepted. |

## API contract

### Request

```
GET /sync/status
Authorization: Bearer eyJ...
```

### Response: success

```
HTTP/1.1 200 OK
Content-Type: application/json

{ ... feature-specific body ... }
```

### Response: failure

```
HTTP/1.1 401 Unauthorized
Content-Type: application/json
WWW-Authenticate: Bearer realm="spotify-roon-sync"

{ "error": "<error_code>" }
```

## Data effects

None. Auth is stateless beyond the secret in Cloudflare Secrets.

## Failure modes

| Mode | Cause | Recovery |
|---|---|---|
| All requests reject as `invalid_signature` | `JWT_SECRET` rotated without re-issuing tokens | Mint a new bootstrap token |
| Clock skew rejects valid tokens as expired | Worker clock drift (rare) | Allow a 30 s leeway in `exp` validation |
| Token leaked | Operator error or device compromise | Rotate `JWT_SECRET`, mint a new token, update all clients |

## Acceptance criteria

- All tests in T-001 pass
- A request with a valid bootstrap token to every authenticated route returns 200 (or the route's documented success status)
- A request with no token to every authenticated route returns 401
- The bootstrap script refuses to run with a weak secret
- No log line contains the literal token or the secret
