# F-014: Health and status endpoints

## Summary

Two unauthenticated endpoints expose system health: `GET /healthz` for liveness and `GET /readyz` for readiness (database reachable, secrets present, OAuth tokens present and not revoked). Both return concise responses suitable for uptime monitoring.

## Linked tests

[T-014](../tests/T-014-health-status.md)

## Dependencies

- Neon database connectivity for readyz
- F-002, F-003, F-004 (provider tokens checked for readyz)

## Behavioural specification

### Liveness

- **Given** the Worker is responding
- **When** the client calls `GET /healthz`
- **Then** the response is HTTP 200 with body `{"status": "ok"}`
- **And** no database query is executed

### Readiness, all green

- **Given** Neon is reachable, all secrets are present, both providers have non-revoked tokens
- **When** the client calls `GET /readyz`
- **Then** the response is HTTP 200 with detailed status

### Readiness, database down

- **Given** Neon is unreachable
- **When** the client calls `GET /readyz`
- **Then** the response is HTTP 503 with `database: false` in the body

### Readiness, provider token revoked

- **Given** Spotify or Tidal `provider_tokens.status = 'revoked'`
- **When** the client calls `GET /readyz`
- **Then** the response is HTTP 503 with `tokens.<provider> = "revoked"` in the body

### Readiness, secrets missing

- **Given** any required secret is missing or zero-length
- **When** the client calls `GET /readyz`
- **Then** the response is HTTP 503 with `secrets.<name> = false`
- **And** the secret value MUST NOT appear in the response

## Detailed requirements

| ID | Requirement |
|---|---|
| F-014-R1 | `GET /healthz` MUST NOT touch the database. |
| F-014-R2 | `GET /healthz` MUST NOT require authentication. |
| F-014-R3 | `GET /readyz` MUST execute a `SELECT 1` against the database with a 2-second timeout. |
| F-014-R4 | `GET /readyz` MUST check the presence of all required secrets listed in architecture §9.4. |
| F-014-R5 | `GET /readyz` MUST check `provider_tokens.status` for both `spotify` and `tidal`. |
| F-014-R6 | `GET /readyz` MUST return HTTP 200 only when database, secrets, and tokens are all green. |
| F-014-R7 | `GET /readyz` MUST return HTTP 503 with a JSON body explaining which checks failed when not green. |
| F-014-R8 | Neither endpoint MUST exceed a 3-second response time. |
| F-014-R9 | The response body of `/readyz` MUST NOT contain any secret value, ciphertext, IV, plaintext token, or database connection string. |
| F-014-R10 | Both endpoints MUST work even when the JWT secret is misconfigured (they MUST NOT depend on auth middleware). |

## API contract

### `GET /healthz`

```
HTTP/1.1 200 OK
Content-Type: application/json

{ "status": "ok" }
```

### `GET /readyz`, all green

```
HTTP/1.1 200 OK
Content-Type: application/json

{
  "status": "ready",
  "database": true,
  "secrets": {
    "JWT_SECRET": true,
    "TOKEN_ENCRYPTION_KEY": true,
    "SPOTIFY_CLIENT_ID": true,
    "SPOTIFY_CLIENT_SECRET": true,
    "TIDAL_CLIENT_ID": true,
    "TIDAL_CLIENT_SECRET": true,
    "DATABASE_URL": true
  },
  "tokens": {
    "spotify": "active",
    "tidal": "active"
  }
}
```

### `GET /readyz`, database down

```
HTTP/1.1 503 Service Unavailable
Content-Type: application/json

{
  "status": "unready",
  "database": false,
  "secrets": { ... },
  "tokens": { ... }
}
```

## Data effects

Read-only on `provider_tokens`.

## Failure modes

| Mode | Cause | Recovery |
|---|---|---|
| Database query times out | Neon cold-starting from scale-to-zero | Operator retries; first wake takes longer |
| All secrets missing | First deployment | Configure secrets via `wrangler secret put`; redeploy |
| Both tokens revoked | New deployment, no OAuth completed | Run OAuth flows for both providers |

## Acceptance criteria

- All tests in T-014 pass
- `/healthz` returns 200 in under 50 ms when the Worker is running
- `/readyz` correctly reports each component's status and only returns 200 when everything is green
- The `/readyz` body contains no secret values under any condition
