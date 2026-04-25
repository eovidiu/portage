# F-004: OAuth token encryption at rest

## Summary

OAuth access and refresh tokens for Spotify and Tidal MUST be encrypted with AES-256-GCM before storage in Postgres. Encryption uses a 256-bit key sourced from Cloudflare Secrets (`TOKEN_ENCRYPTION_KEY`). Each encryption operation generates a fresh 96-bit IV. Plaintext tokens MUST exist only in volatile Worker memory during use.

**Scope boundary**: F-004 is a pure cryptographic primitive module. It exposes `encryptToken` and `decryptToken` only. Token persistence helpers (`persistTokens`/`loadTokens`) that read and write the `provider_tokens` table are scoped to a follow-on feature **F-004b**, which depends on F-002 and F-003 (the OAuth flows that produce tokens to persist). This separation keeps F-004 a zero-DB-coupling helper that can be tested and reasoned about independently.

## Linked tests

[T-004](../tests/T-004-token-encryption.md)

## Dependencies

- Cloudflare Secrets: `TOKEN_ENCRYPTION_KEY` (32 bytes, base64-encoded)
- Web Crypto API (built into Workers; no external library)

## Behavioural specification

### Encrypt a token

- **Given** a plaintext token string and the `TOKEN_ENCRYPTION_KEY`
- **When** the encryption helper is called
- **Then** the helper generates a fresh 12-byte (96-bit) IV from the CSPRNG
- **And** computes `ciphertext = AES-256-GCM(key, iv, plaintext)` where ciphertext includes the GCM authentication tag
- **And** returns `{ ciphertext: Uint8Array, iv: Uint8Array }`

### Decrypt a token

- **Given** a `{ ciphertext, iv }` pair and the `TOKEN_ENCRYPTION_KEY`
- **When** the decryption helper is called
- **Then** the helper invokes AES-GCM decrypt
- **And** returns the plaintext token string on success

### Decrypt with tampered ciphertext

- **Given** a valid IV and a ciphertext where any byte has been flipped
- **When** decrypt is called
- **Then** the operation throws an `IntegrityError`
- **And** the caller MUST treat this as a fatal token corruption and emit a `token_integrity_failure` log entry

## Detailed requirements

| ID | Requirement |
|---|---|
| F-004-R1 | The cipher MUST be AES-256-GCM. No other ciphers permitted. |
| F-004-R2 | The IV MUST be exactly 96 bits (12 bytes). |
| F-004-R3 | The IV MUST be generated fresh per encryption operation from `crypto.getRandomValues`. |
| F-004-R4 | The encryption key MUST be loaded from `TOKEN_ENCRYPTION_KEY` via the env binding. The key MUST be 32 bytes after base64 decode. |
| F-004-R5 | ~~The system MUST refuse to start if `TOKEN_ENCRYPTION_KEY` is missing or wrong length.~~ **Moved to F-001 (auth middleware)**: startup-time secret validation is co-located with the other boot-time checks in the auth middleware per lead decision D2. F-004 still throws a descriptive error when `encryptToken`/`decryptToken` are called with an invalid or missing key. |
| F-004-R6 | Plaintext tokens MUST NOT appear in any `console.log`, `console.error`, persisted log, error message, or response body. |
| F-004-R7 | Decryption failures MUST be reported with a generic error code (`token_integrity_failure`) without exposing IV or ciphertext bytes. |
| F-004-R8 | ~~The Postgres columns for ciphertext and IV MUST be `bytea`.~~ **Moved to F-004b**: column type constraints belong to the persistence layer. |
| F-004-R9 | Encryption MUST authenticate the ciphertext (GCM tag verification on decrypt); modifications MUST cause decryption to fail. |
| F-004-R10 | The module MUST expose exactly two functions: `encryptToken` and `decryptToken`. The `IntegrityError` class is also exported so callers can catch it by type. No persistence helpers in this module. |
| F-004-R11 | Key rotation is out of scope for v1; the spec MUST be updated before introducing it. |

## Module exports

```typescript
export function encryptToken(plaintext: string, keyB64: string): Promise<EncryptResult>
export function decryptToken(ciphertext: Uint8Array, iv: Uint8Array, keyB64: string): Promise<string>
export class IntegrityError extends Error {}
export interface EncryptResult { ciphertext: Uint8Array; iv: Uint8Array }
```

No other symbols are exported from `src/crypto/index.ts`.

## Database schema

The `provider_tokens` table schema is defined in F-004b. Reproduced here for reference:

```sql
CREATE TABLE provider_tokens (
  provider TEXT PRIMARY KEY,
  access_token_ciphertext BYTEA NOT NULL,
  access_token_iv BYTEA NOT NULL,
  refresh_token_ciphertext BYTEA NOT NULL,
  refresh_token_iv BYTEA NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

## Failure modes

| Mode | Cause | Recovery |
|---|---|---|
| `token_integrity_failure` on decrypt | Database corruption or accidental column modification | Re-run OAuth flow for the affected provider |
| Key missing at call-time | `encryptToken`/`decryptToken` called before env binding is populated | Fix env binding; redeploy |
| Key mismatch (cannot decrypt any tokens) | `TOKEN_ENCRYPTION_KEY` rotated without re-encryption | Restore previous key from secret backup or re-run all OAuth flows |

## Acceptance criteria

F-004 is satisfied when:

- All T-004 tests pass (covers R1–R7, R9, R10)
- `encryptToken` and `decryptToken` round-trip correctly for inputs of length 1, 100, and 10,000 bytes
- A modified ciphertext byte causes `decryptToken` to throw `IntegrityError`, every time
- No plaintext token value appears in any error message or log output

Acceptance criteria for persistence (T-004-11, T-004-12, T-004-13) and startup-time key validation (T-004-09 strict form) are deferred to F-004b and F-001 respectively.
