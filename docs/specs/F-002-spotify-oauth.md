# F-002: Spotify OAuth integration

## Summary

The system performs OAuth 2.0 Authorization Code with PKCE against Spotify, requesting the `user-library-read` scope. On success it stores the access and refresh tokens encrypted in the `provider_tokens` table (see F-004). It refreshes the access token on demand when fewer than 60 seconds remain on its lifetime.

## Linked tests

[T-002](../tests/T-002-spotify-oauth.md)

## Dependencies

- Cloudflare Secrets: `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`
- Cloudflare Vars: `SPOTIFY_REDIRECT_URI` (e.g. `https://sync.example.com/auth/spotify/callback`)
- F-004 (token encryption)
- F-001 (the `GET /auth/spotify` initiator route requires JWT; `/callback` is state-validated)

## Behavioural specification

### Initiate authorisation

- **Given** the operator's bootstrap JWT
- **When** the client calls `GET /auth/spotify`
- **Then** the system generates a 256-bit random `state` and a PKCE `code_verifier`/`code_challenge` pair
- **And** stores `{state, code_verifier, expires_at: now+10min}` in a transient store (Postgres table `oauth_state`)
- **And** responds with HTTP 302 to Spotify's authorize URL with `client_id`, `redirect_uri`, `scope=user-library-read`, `response_type=code`, `state`, `code_challenge`, `code_challenge_method=S256`

### Handle authorisation callback, success

- **Given** the user authorises the app on Spotify
- **When** Spotify redirects to `GET /auth/spotify/callback?code=<code>&state=<state>`
- **Then** the system looks up `state` in `oauth_state`
- **And** verifies it has not expired
- **And** exchanges `code` plus `code_verifier` for tokens at Spotify's token endpoint
- **And** persists the tokens via F-004 with `provider = 'spotify'`
- **And** deletes the `oauth_state` row
- **And** responds with HTTP 200 and body `{"status": "connected", "provider": "spotify"}`

### Handle authorisation callback, invalid state

- **Given** any callback whose `state` is missing, expired, or not in `oauth_state`
- **When** the system processes the callback
- **Then** the response is HTTP 400 with body `{"error": "invalid_state"}`
- **And** no token exchange is attempted

### Handle authorisation callback, user denied

- **Given** the user denies authorisation on Spotify
- **When** Spotify redirects with `?error=access_denied`
- **Then** the response is HTTP 400 with body `{"error": "user_denied"}`
- **And** any matching `oauth_state` row is deleted

### Refresh access token

- **Given** a stored Spotify access token with fewer than 60 seconds until expiry
- **When** any code path requires an authorised Spotify call
- **Then** the system exchanges the refresh token for a new access token
- **And** persists the new access token (and rotated refresh token if Spotify returned one)

### Handle refresh failure

- **Given** Spotify returns 400 with `invalid_grant` on refresh
- **When** the system attempts to refresh
- **Then** the system marks the token row as `revoked`
- **And** the calling code path returns an error indicating reauthorisation is required

## Detailed requirements

| ID | Requirement |
|---|---|
| F-002-R1 | The system MUST use Authorization Code with PKCE (S256). |
| F-002-R2 | The system MUST request only the `user-library-read` scope. |
| F-002-R3 | The `state` parameter MUST be at least 256 bits of entropy from a cryptographically secure RNG. |
| F-002-R4 | The `oauth_state` table MUST be purged of expired rows on every callback handler invocation. |
| F-002-R5 | Token exchange and refresh MUST NOT log the access token, refresh token, code, or `code_verifier`. |
| F-002-R6 | The refresh helper MUST refresh proactively when fewer than 60 seconds remain on the access token's lifetime. |
| F-002-R7 | Concurrent refresh attempts MUST be coalesced; only one refresh request may be in flight per provider at any time. |
| F-002-R8 | If Spotify returns a new refresh token in the refresh response, the system MUST persist it and discard the old one. |
| F-002-R9 | The `redirect_uri` sent to Spotify MUST exactly match the value registered in the Spotify developer dashboard. |
| F-002-R10 | All Spotify API requests MUST include `Authorization: Bearer <access_token>` and a `User-Agent` identifying this service. |
| F-002-R11 | On any 401 response from Spotify, the system MUST attempt one refresh and retry once before failing the operation. |

## API contract

### `GET /auth/spotify`

Auth: bootstrap JWT.

Response: HTTP 302 redirect to Spotify authorize URL.

### `GET /auth/spotify/callback`

Auth: none; state-validated.

Response on success:
```
HTTP/1.1 200 OK
Content-Type: application/json

{"status": "connected", "provider": "spotify"}
```

Response on failure: HTTP 400 with `{"error": "<reason>"}` where `<reason>` is one of `invalid_state`, `user_denied`, `token_exchange_failed`.

## Data effects

- Inserts into `oauth_state` on initiate, deletes on completion or rejection
- Inserts or updates `provider_tokens` row with `provider = 'spotify'` on success

## Failure modes

| Mode | Cause | Recovery |
|---|---|---|
| `invalid_state` | Replay, expired flow, or attack | User retries `GET /auth/spotify` |
| `token_exchange_failed` | Network blip, Spotify outage, clock skew | Retry the OAuth flow |
| Refresh returns `invalid_grant` | Refresh token revoked or expired | Re-run the OAuth flow |
| Spotify rate-limited (HTTP 429) | Excessive refresh attempts | Backoff per `Retry-After`; cap at 3 retries |

## Acceptance criteria

- All tests in T-002 pass
- A complete OAuth round trip results in a row in `provider_tokens` with `provider = 'spotify'` and non-null encrypted access and refresh tokens
- A subsequent `GET /sync/status` (after a sync run) demonstrates the system can use the stored tokens
- A token forced into expiry triggers a refresh on next use, without operator intervention
