# F-003: Tidal OAuth integration

## Summary

The system performs OAuth 2.1 Authorization Code with PKCE against Tidal's Open API, requesting scopes sufficient for catalog read and user playlist write. Tokens are persisted encrypted via F-004. Refresh follows the same pattern as Spotify (F-002), with provider-specific endpoints and error semantics.

## Linked tests

[T-003](../tests/T-003-tidal-oauth.md)

## Dependencies

- Cloudflare Secrets: `TIDAL_CLIENT_ID`, `TIDAL_CLIENT_SECRET`
- Cloudflare Vars: `TIDAL_REDIRECT_URI` (e.g. `https://sync.example.com/auth/tidal/callback`)
- F-004 (token encryption)
- F-001 (the `GET /auth/tidal` initiator route requires JWT; `/callback` is state-validated)

## Behavioural specification

### Initiate authorisation

- **Given** the operator's bootstrap JWT
- **When** the client calls `GET /auth/tidal`
- **Then** the system generates a 256-bit `state` and a PKCE pair (S256)
- **And** stores `{state, code_verifier, expires_at: now+10min}` in `oauth_state`
- **And** responds HTTP 302 to `https://login.tidal.com/authorize` with `client_id`, `redirect_uri`, the configured scope set, `response_type=code`, `state`, `code_challenge`, `code_challenge_method=S256`

### Handle authorisation callback, success

- **Given** Tidal redirects to `GET /auth/tidal/callback?code=<code>&state=<state>`
- **When** the system processes the callback
- **Then** it validates `state` exactly as Spotify (F-002)
- **And** exchanges `code` + `code_verifier` at `https://auth.tidal.com/v1/oauth2/token`
- **And** persists tokens via F-004 with `provider = 'tidal'`
- **And** deletes the `oauth_state` row
- **And** responds HTTP 200 with `{"status": "connected", "provider": "tidal"}`

### Refresh access token

- **Given** a stored Tidal access token within 60 seconds of expiry
- **When** any sync code path requires a Tidal call
- **Then** the system POSTs `grant_type=refresh_token` with the stored refresh token to `https://auth.tidal.com/v1/oauth2/token`
- **And** persists the new access token

### Handle refresh failure

- **Given** Tidal returns an OAuth error indicating an expired or revoked refresh token
- **When** the refresh attempt completes
- **Then** the system marks the `provider_tokens` row as `revoked`
- **And** the sync run that triggered the refresh terminates with status `failed` and reason `tidal_reauth_required`

## Detailed requirements

| ID | Requirement |
|---|---|
| F-003-R1 | The system MUST use Authorization Code with PKCE (S256). |
| F-003-R2 | The requested scopes MUST include all scopes required to: read catalog by ISRC, search catalog, read user playlists, create user playlists, modify user playlists. The exact scope strings MUST be sourced from the Tidal Developer Portal at implementation time and committed to a constants file. |
| F-003-R3 | The `state` parameter MUST be at least 256 bits of CSPRNG entropy. |
| F-003-R4 | Token exchange and refresh MUST NOT log secrets or codes. |
| F-003-R5 | The system MUST refresh proactively when fewer than 60 seconds remain on the access token's lifetime. |
| F-003-R6 | Concurrent refresh attempts MUST be coalesced. |
| F-003-R7 | All Tidal API requests MUST include `Authorization: Bearer <access_token>`, `accept: application/vnd.tidal.v1+json`, `Content-Type: application/vnd.tidal.v1+json` (where applicable). |
| F-003-R8 | The `countryCode` query parameter MUST be set on every catalog API request, sourced from a configuration constant (default `RO` for Romania). |
| F-003-R9 | On HTTP 401 from Tidal, the system MUST attempt one refresh and retry once before failing. |
| F-003-R10 | The `redirect_uri` sent to Tidal MUST exactly match the value registered in the Tidal Developer Portal application. |
| F-003-R11 | The system MUST tolerate Tidal's API returning newer media types (`application/vnd.tidal.v2+json`) without crashing; it MUST log a warning and proceed. |

## API contract

### `GET /auth/tidal`

Auth: bootstrap JWT.

Response: HTTP 302 redirect to `https://login.tidal.com/authorize`.

### `GET /auth/tidal/callback`

Auth: none; state-validated.

Response on success:
```
HTTP/1.1 200 OK
Content-Type: application/json

{"status": "connected", "provider": "tidal"}
```

Response on failure: HTTP 400 with `{"error": "<reason>"}` where `<reason>` is one of `invalid_state`, `user_denied`, `token_exchange_failed`.

## Data effects

- Inserts into `oauth_state` on initiate, deletes on completion or rejection
- Inserts or updates `provider_tokens` row with `provider = 'tidal'` on success

## Failure modes

| Mode | Cause | Recovery |
|---|---|---|
| `invalid_state` | Replay or expired flow | User retries `GET /auth/tidal` |
| `token_exchange_failed` | Tidal outage, network blip, clock skew | Retry OAuth flow |
| Refresh fails permanently | User revoked, app removed from Tidal account | Re-run OAuth flow |
| Tidal returns 5xx repeatedly | Tidal infrastructure issue | Backoff with jitter, retry within run; abort run after 3 failures |

## Acceptance criteria

- All tests in T-003 pass
- A complete OAuth round trip results in a `provider_tokens` row with `provider = 'tidal'`
- A token forced into expiry triggers refresh on next use without operator intervention
- A subsequent ISRC search (F-006) succeeds against the Tidal Open API using the stored credentials
