# T-003: Tidal OAuth tests

Covers F-003.

---

## T-003-01: Initiate redirects to Tidal with required params

**Type**: assertion

**Setup**: Worker deployed; valid bootstrap JWT; configured scope set in constants.

**Action**: `GET /auth/tidal` with the JWT.

**Assertion**: Response status is 302 AND `Location` matches `^https://login\.tidal\.com/authorize\?` AND the URL contains `client_id`, `redirect_uri`, `scope` (containing all configured scope strings), `response_type=code`, `state`, `code_challenge`, `code_challenge_method=S256`.

**Pass**: TRUE if all conditions hold.

---

## T-003-02: State entropy is at least 256 bits

**Type**: metric

**Setup**: Worker deployed.

**Action**: Initiate `/auth/tidal` 100 times; parse `state` parameters.

**Measurement**: Minimum bit-length of decoded `state` across the 100 samples.

**Pass**: metric value MUST be ≥ 256.

---

## T-003-03: Successful exchange persists tokens

**Type**: assertion

**Setup**: Mock Tidal token endpoint to return `{access_token: "AT", refresh_token: "RT", expires_in: 3600, token_type: "Bearer"}`. Insert valid `oauth_state` row with state `S`.

**Action**: `GET /auth/tidal/callback?state=S&code=fakecode`.

**Assertion**: A row in `provider_tokens` with `provider = 'tidal'` exists; ciphertexts non-null; `expires_at` within ±10 s of `now() + 3600s`; `oauth_state` row deleted.

**Pass**: TRUE if all conditions hold.

---

## T-003-04: Tidal API calls include required headers

**Type**: assertion

**Setup**: Persist valid Tidal tokens. Spy on outbound HTTP calls.

**Action**: Trigger any Tidal API call (e.g., F-006 ISRC lookup against a mock server).

**Assertion**: The outbound request includes all of: `Authorization: Bearer <decrypted_access_token>`, `accept: application/vnd.tidal.v1+json`, and a `countryCode` query parameter equal to the configured value.

**Pass**: TRUE if all three present.

---

## T-003-05: Refresh occurs within 60s of expiry

**Type**: assertion

**Setup**: Persist Tidal tokens with `expires_at = now() + 30s`. Mock refresh endpoint to return a new token with canary `TIDALREFRESHED`.

**Action**: Trigger a Tidal API call.

**Assertion**: The outbound request's `Authorization` header decrypts to a token equal to the canary value.

**Pass**: TRUE if equal.

---

## T-003-06: Concurrent Tidal refresh is coalesced

**Type**: metric

**Setup**: Persist tokens with `expires_at = now() + 30s`. Instrument refresh endpoint to count calls; 200 ms latency in mock.

**Action**: Trigger 5 concurrent Tidal API calls.

**Measurement**: Number of refresh endpoint calls.

**Pass**: metric value MUST equal 1.

---

## T-003-07: Refresh failure marks tokens revoked

**Type**: assertion

**Setup**: Persist Tidal tokens; mock refresh endpoint to return HTTP 400 with an OAuth error indicating expiry.

**Action**: Trigger a Tidal API call requiring refresh.

**Assertion**: `provider_tokens.status` for `tidal` equals `'revoked'`.

**Pass**: TRUE if equal.

---

## T-003-08: Refresh failure ends sync run with correct error

**Type**: assertion

**Setup**: Same as T-003-07. A sync run is in progress.

**Action**: Same as T-003-07; observe the `sync_runs` row.

**Assertion**: The `sync_runs` row reaches a terminal state with `status = 'failed'` AND `error_code = 'tidal_reauth_required'`.

**Pass**: TRUE if both hold.

---

## T-003-09: Tidal 401 triggers one refresh and one retry

**Type**: metric

**Setup**: Persist tokens with plenty of remaining lifetime. Mock Tidal API to return 401 on first call, 200 on subsequent. Instrument target endpoint.

**Action**: Trigger one Tidal API call.

**Measurement**: Number of target-endpoint calls.

**Pass**: metric value MUST equal 2.

---

## T-003-10: Unknown media type returns warning, not crash

**Type**: assertion

**Setup**: Mock Tidal API to return a successful response with `Content-Type: application/vnd.tidal.v2+json`. Capture log output.

**Action**: Trigger any Tidal API call.

**Assertion**: The call completes without throwing AND the captured log contains a warning entry mentioning `vnd.tidal.v2`.

**Pass**: TRUE if both hold.

---

## T-003-11: Callback with invalid state returns 400

**Type**: assertion

**Setup**: `oauth_state` empty.

**Action**: `GET /auth/tidal/callback?state=bogus&code=x`.

**Assertion**: Response status is 400 AND body equals `{"error": "invalid_state"}`.

**Pass**: TRUE if both hold.

---

## T-003-12: 5xx from Tidal triggers backoff and retry

**Type**: metric

**Setup**: Persist tokens. Mock Tidal API to return 503 three times then 200. Capture timestamps of each retry.

**Action**: Trigger one Tidal API call.

**Measurement**: Number of attempts before success (call this `N`); also record the timestamp delta between attempts 1 and 2 in ms.

**Pass**: metric `N` MUST be ≤ 4 AND the delta MUST be ≥ 500 ms (basic backoff observable).

---

## T-003-13: Tidal token is encrypted at rest

**Type**: assertion

**Setup**: Persist Tidal tokens with access token plaintext containing canary `TIDAL_PLAINTEXT_CANARY`.

**Action**: Read the `provider_tokens.access_token_ciphertext` column directly via SQL.

**Assertion**: The byte representation of the column does NOT contain the canary substring.

**Pass**: TRUE if substring not found.
