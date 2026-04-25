# T-002: Spotify OAuth tests

Covers F-002.

---

## T-002-01: Initiate redirects to Spotify with required params

**Type**: assertion

**Setup**: Worker deployed; valid bootstrap JWT.

**Action**: `GET /auth/spotify` with the JWT.

**Assertion**: Response status is 302 AND `Location` header matches `^https://accounts\.spotify\.com/authorize\?` AND the URL contains all of `client_id`, `redirect_uri`, `scope=user-library-read`, `response_type=code`, `state`, `code_challenge`, `code_challenge_method=S256`.

**Pass**: TRUE if all conditions hold.

---

## T-002-02: State entropy is at least 256 bits

**Type**: metric

**Setup**: Worker deployed.

**Action**: Initiate `/auth/spotify` 100 times; for each, parse the `state` parameter from the redirect URL.

**Measurement**: For each `state`, compute its byte length after base64url decoding; report the minimum length across the 100 samples, in bits (length * 8).

**Pass**: metric value MUST be ≥ 256.

---

## T-002-03: State is unique per initiation

**Type**: assertion

**Setup**: Worker deployed.

**Action**: Initiate `/auth/spotify` 1000 times; collect the `state` parameter each time.

**Assertion**: All 1000 state values are distinct.

**Pass**: TRUE if `len(set(states)) == 1000`.

---

## T-002-04: oauth_state row is created on initiate

**Type**: assertion

**Setup**: Truncate `oauth_state` table.

**Action**: Initiate `/auth/spotify`.

**Assertion**: Exactly one row exists in `oauth_state` with `provider = 'spotify'` and `expires_at` 10 minutes ahead within ±5 s.

**Pass**: TRUE if all conditions hold.

---

## T-002-05: Callback with unknown state returns 400

**Type**: assertion

**Setup**: `oauth_state` table empty.

**Action**: `GET /auth/spotify/callback?state=unknown&code=anything`.

**Assertion**: Response status is 400 AND body equals `{"error": "invalid_state"}`.

**Pass**: TRUE if both hold.

---

## T-002-06: Callback with expired state returns 400

**Type**: assertion

**Setup**: Insert `oauth_state` row with `expires_at` 1 hour in the past.

**Action**: Call callback with that state.

**Assertion**: Response status is 400 AND body equals `{"error": "invalid_state"}`.

**Pass**: TRUE if both hold.

---

## T-002-07: Callback with user_denied error returns 400

**Type**: assertion

**Setup**: Insert valid `oauth_state` row.

**Action**: `GET /auth/spotify/callback?state=<state>&error=access_denied`.

**Assertion**: Response status is 400 AND body equals `{"error": "user_denied"}`.

**Pass**: TRUE if both hold.

---

## T-002-08: Successful exchange persists tokens

**Type**: assertion

**Setup**: Mock Spotify token endpoint to return `{access_token: "AT", refresh_token: "RT", expires_in: 3600, token_type: "Bearer"}`. Insert valid `oauth_state` row with state `S`.

**Action**: `GET /auth/spotify/callback?state=S&code=fakecode`.

**Assertion**: A row in `provider_tokens` with `provider = 'spotify'` exists; both ciphertexts are non-null; `expires_at` is within ±10 s of `now() + 3600s`; the `oauth_state` row is gone.

**Pass**: TRUE if all conditions hold.

---

## T-002-09: Successful exchange returns connected status

**Type**: assertion

**Setup**: Same as T-002-08.

**Action**: Same as T-002-08.

**Assertion**: Response status is 200 AND body equals `{"status": "connected", "provider": "spotify"}`.

**Pass**: TRUE if both hold.

---

## T-002-10: Refresh occurs when token within 60s of expiry

**Type**: assertion

**Setup**: Persist a `provider_tokens` row with `expires_at = now() + 30s`. Mock the Spotify refresh endpoint to return a new access token containing the canary string `REFRESHED_AT`.

**Action**: Call any code path that requires a Spotify access token (e.g., trigger F-005).

**Assertion**: The Spotify API call uses an access token that, on decryption, equals the value provided by the mocked refresh.

**Pass**: TRUE if equal.

---

## T-002-11: No refresh when token has plenty of time

**Type**: assertion

**Setup**: Persist tokens with `expires_at = now() + 7200s`. Instrument refresh endpoint to count calls.

**Action**: Trigger 10 Spotify API calls.

**Assertion**: Refresh endpoint call count is 0.

**Pass**: TRUE if count == 0.

---

## T-002-12: Concurrent refresh is coalesced

**Type**: metric

**Setup**: Persist tokens with `expires_at = now() + 30s`. Instrument refresh endpoint to count calls; introduce 200 ms latency in the mock.

**Action**: Trigger 5 concurrent Spotify API calls.

**Measurement**: Number of refresh endpoint calls observed.

**Pass**: metric value MUST equal 1.

---

## T-002-13: Invalid_grant on refresh marks tokens revoked

**Type**: assertion

**Setup**: Persist tokens; mock refresh endpoint to return HTTP 400 with `{"error": "invalid_grant"}`.

**Action**: Trigger a Spotify API call requiring refresh.

**Assertion**: `provider_tokens.status` for `spotify` equals `'revoked'`.

**Pass**: TRUE if equal.

---

## T-002-14: 401 from Spotify triggers one refresh and one retry

**Type**: metric

**Setup**: Persist tokens with `expires_at = now() + 7200s` (so no proactive refresh). Mock Spotify API to return 401 on the first call and 200 on subsequent calls. Instrument refresh and target endpoints.

**Action**: Trigger one Spotify API call.

**Measurement**: Total number of calls made to the Spotify target endpoint (not counting refresh).

**Pass**: metric value MUST equal 2.

---

## T-002-15: No secrets in logs

**Type**: assertion

**Setup**: Configure `SPOTIFY_CLIENT_SECRET` to contain canary string `SPSECRETCANARY`. Configure tokens with canaries `ATCANARY` and `RTCANARY`.

**Action**: Run a complete OAuth round trip and one refresh.

**Assertion**: No log line in the captured output contains any of: `SPSECRETCANARY`, `ATCANARY`, `RTCANARY`, `code_verifier`.

**Pass**: TRUE if no matches found.
