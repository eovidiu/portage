# T-014: Health and status endpoint tests

Covers F-014.

---

## T-014-01: GET /healthz returns 200

**Type**: assertion

**Setup**: Worker deployed and running.

**Action**: `GET /healthz` with no `Authorization` header.

**Assertion**: Response status is 200 AND body equals `{"status": "ok"}`.

**Pass**: TRUE if both hold.

---

## T-014-02: GET /healthz does not query the database

**Type**: metric

**Setup**: Instrument the database client to count queries.

**Action**: `GET /healthz` 100 times.

**Measurement**: Total database queries observed across the 100 requests.

**Pass**: metric value MUST equal 0.

---

## T-014-03: GET /healthz response time

**Type**: metric

**Setup**: Worker deployed locally with `wrangler dev`.

**Action**: Issue 100 sequential `GET /healthz` requests; record per-request response time.

**Measurement**: p95 of response times, in milliseconds.

**Pass**: metric value MUST be < 50 ms.

---

## T-014-04: GET /readyz returns 200 when all green

**Type**: assertion

**Setup**: Database reachable; all 7 secrets configured; both `provider_tokens` rows present with `status = 'active'`.

**Action**: `GET /readyz`.

**Assertion**: Response status is 200 AND body has `status = "ready"` AND `database = true` AND every entry in `secrets` is `true` AND `tokens.spotify = "active"` AND `tokens.tidal = "active"`.

**Pass**: TRUE if all hold.

---

## T-014-05: GET /readyz returns 503 when database down

**Type**: assertion

**Setup**: Configure `DATABASE_URL` to a non-routable address; all secrets present.

**Action**: `GET /readyz`.

**Assertion**: Response status is 503 AND body has `database = false`.

**Pass**: TRUE if both hold.

---

## T-014-06: GET /readyz returns 503 when token revoked

**Type**: assertion

**Setup**: All else green; `provider_tokens.status` for `spotify` set to `'revoked'`.

**Action**: `GET /readyz`.

**Assertion**: Response status is 503 AND `tokens.spotify = "revoked"`.

**Pass**: TRUE if both hold.

---

## T-014-07: GET /readyz returns 503 when secret missing

**Type**: assertion

**Setup**: Unset `JWT_SECRET`.

**Action**: `GET /readyz`.

**Assertion**: Response status is 503 AND `secrets.JWT_SECRET = false`.

**Pass**: TRUE if both hold.

---

## T-014-08: GET /readyz body contains no secret values

**Type**: assertion

**Setup**: All secrets set with canary values: `JWT_SECRET = 'JWTCANARY'`, `TOKEN_ENCRYPTION_KEY = 'EKCANARY'`, etc. Persist tokens with plaintext canary `TOKCANARY`.

**Action**: `GET /readyz`. Inspect the response body as a string.

**Assertion**: The response body does NOT contain any of: `JWTCANARY`, `EKCANARY`, `TOKCANARY`, the `DATABASE_URL` value, or any ciphertext bytes (verified by checking the body length is small enough to preclude inclusion).

**Pass**: TRUE if no canary substring found.

---

## T-014-09: GET /readyz database query timeout

**Type**: metric

**Setup**: Configure database client with a controllable delay; introduce a 10 s artificial delay on `SELECT 1`.

**Action**: `GET /readyz`; record total response time.

**Measurement**: Total response time in seconds.

**Pass**: metric value MUST be ≤ 3.0 (the endpoint enforces a 2 s DB timeout plus < 1 s overhead).

---

## T-014-10: Endpoints work when JWT_SECRET misconfigured

**Type**: assertion

**Setup**: Set `JWT_SECRET` to an empty string (intentionally broken).

**Action**: `GET /healthz` AND `GET /readyz`.

**Assertion**: `GET /healthz` returns 200 AND `GET /readyz` returns a defined response (200 or 503), neither throwing or returning 500.

**Pass**: TRUE if all hold.

---

## T-014-11: Both endpoints under 3 s

**Type**: metric

**Setup**: All systems green. Worker deployed.

**Action**: Issue 50 sequential requests alternating between `GET /healthz` and `GET /readyz`; record per-request response time.

**Measurement**: Maximum recorded response time across all 50 requests, in seconds.

**Pass**: metric value MUST be < 3.0.
