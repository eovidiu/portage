# T-001: Authentication tests

Covers F-001. Every test produces exactly one output: a boolean (TRUE/FALSE) or a single numeric metric.

## Conventions

- **Type**: `assertion` (boolean) or `metric` (number with threshold)
- **Setup** describes the precondition state
- **Action** describes the single action under test
- **Assertion** (boolean tests) or **Measurement** (metric tests) is the observable output
- **Pass** defines the success criterion in unambiguous terms

---

## T-001-01: Bootstrap script rejects short secret

**Type**: assertion

**Setup**: Set `JWT_SECRET` env var to a 16-byte string.

**Action**: Invoke the bootstrap token-minting script.

**Assertion**: Script exits with non-zero status code and prints an error containing the substring `"secret too short"`.

**Pass**: TRUE if both conditions hold, FALSE otherwise.

---

## T-001-02: Bootstrap script mints valid JWT with strong secret

**Type**: assertion

**Setup**: Set `JWT_SECRET` to a 32-byte random string.

**Action**: Run the bootstrap script with `subject = "owner"`.

**Assertion**: Output is a JWT that, when decoded, has `sub = "owner"`, `iss = "spotify-roon-sync"`, and `exp` exactly 365 days after `iat` (within 60 s tolerance).

**Pass**: TRUE if all four conditions hold.

---

## T-001-03: Missing Authorization header returns 401

**Type**: assertion

**Setup**: Worker deployed with valid `JWT_SECRET`.

**Action**: `GET /sync/status` with no `Authorization` header.

**Assertion**: Response status is 401 AND response body equals `{"error": "missing_token"}`.

**Pass**: TRUE if both hold.

---

## T-001-04: Malformed Authorization header returns 401

**Type**: assertion

**Setup**: Worker deployed.

**Action**: `GET /sync/status` with `Authorization: NotBearer abc.def.ghi`.

**Assertion**: Response status is 401 AND response body equals `{"error": "malformed_token"}`.

**Pass**: TRUE if both hold.

---

## T-001-05: Wrong-secret signature returns 401

**Type**: assertion

**Setup**: Mint a JWT with `JWT_SECRET = "different_secret"` but otherwise valid claims.

**Action**: `GET /sync/status` with that token.

**Assertion**: Response status is 401 AND response body equals `{"error": "invalid_signature"}`.

**Pass**: TRUE if both hold.

---

## T-001-06: Expired token returns 401

**Type**: assertion

**Setup**: Mint a valid JWT with `exp` set to 60 seconds in the past.

**Action**: `GET /sync/status` with that token.

**Assertion**: Response status is 401 AND response body equals `{"error": "expired_token"}`.

**Pass**: TRUE if both hold.

---

## T-001-07: Wrong issuer returns 401

**Type**: assertion

**Setup**: Mint a JWT with the correct secret but `iss = "other-system"`.

**Action**: `GET /sync/status` with that token.

**Assertion**: Response status is 401 AND response body equals `{"error": "invalid_issuer"}`.

**Pass**: TRUE if both hold.

---

## T-001-08: Wrong subject returns 401

**Type**: assertion

**Setup**: Mint a JWT with `sub = "intruder"` and otherwise valid claims; allowlist is `["owner"]`.

**Action**: `GET /sync/status` with that token.

**Assertion**: Response status is 401 AND response body equals `{"error": "invalid_subject"}`.

**Pass**: TRUE if both hold.

---

## T-001-09: Valid token reaches handler

**Type**: assertion

**Setup**: Mint a valid bootstrap JWT.

**Action**: `GET /sync/status` with that token; route handler is instrumented to record `ctx.subject`.

**Assertion**: Recorded `ctx.subject == "owner"`.

**Pass**: TRUE if equal.

---

## T-001-10: JWT verification latency p95

**Type**: metric

**Setup**: Mint 1000 valid tokens. Worker running locally with `wrangler dev`.

**Action**: Send 1000 sequential `GET /sync/status` requests, each with a unique valid token; record per-request server-side time spent in the auth middleware (excluding handler).

**Measurement**: p95 of recorded middleware times, in milliseconds.

**Pass**: metric value MUST be < 5 ms.

---

## T-001-11: No token logging

**Type**: assertion

**Setup**: Mint a JWT containing the recognisable string `LEAKCANARY` in its payload (custom claim). Capture all log output.

**Action**: Send 100 requests with that token to mixed routes, including invalid ones.

**Assertion**: No log line contains the substring `LEAKCANARY` AND no log line contains the literal value of `JWT_SECRET`.

**Pass**: TRUE if both hold.

---

## T-001-12: Healthz remains unauthenticated

**Type**: assertion

**Setup**: Worker deployed.

**Action**: `GET /healthz` with no `Authorization` header.

**Assertion**: Response status is 200.

**Pass**: TRUE if 200.

---

## T-001-13: OAuth callbacks remain unauthenticated by JWT

**Type**: assertion

**Setup**: Worker deployed; valid `oauth_state` row inserted with state `S` and code_verifier.

**Action**: `GET /auth/spotify/callback?state=S&code=fakecode` with no `Authorization` header.

**Assertion**: Response status is NOT 401 (it may be 400 due to fakecode failing the exchange, but not 401).

**Pass**: TRUE if status code != 401.

---

## T-001-14: Query-parameter token rejected

**Type**: assertion

**Setup**: Mint a valid bootstrap JWT.

**Action**: `GET /sync/status?token=<jwt>` with no `Authorization` header.

**Assertion**: Response status is 401.

**Pass**: TRUE if 401.
