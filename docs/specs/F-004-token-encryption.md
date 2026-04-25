# F-004: OAuth token encryption at rest

## Summary

OAuth access and refresh tokens for Spotify and Tidal MUST be encrypted with AES-256-GCM before storage in Postgres. Encryption uses a 256-bit key sourced from Cloudflare Secrets (`TOKEN_ENCRYPTION_KEY`). Each encryption operation generates a fresh 96-bit IV. Plaintext tokens MUST exist only in volatile Worker memory during use.

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

### Persist tokens

- **Given** plaintext access and refresh tokens for `provider`
- **When** the persist helper is called
- **Then** the helper encrypts each token independently (separate IVs)
- **And** writes a single row to `provider_tokens` with columns: `provider`, `access_token_ciphertext`, `access_token_iv`, `refresh_token_ciphertext`, `refresh_token_iv`, `expires_at`, `updated_at`
- **And** uses an `INSERT ... ON CONFLICT (provider) DO UPDATE` upsert

### Read tokens for use

- **Given** a request to fetch `provider`'s tokens
- **When** the load helper is called
- **Then** the helper reads the `provider_tokens` row
- **And** decrypts both access and refresh tokens
- **And** returns `{ accessToken, refreshToken, expiresAt }` in plaintext to the caller

## Detailed requirements

| ID | Requirement |
|---|---|
| F-004-R1 | The cipher MUST be AES-256-GCM. No other ciphers permitted. |
| F-004-R2 | The IV MUST be exactly 96 bits (12 bytes). |
| F-004-R3 | The IV MUST be generated fresh per encryption operation from `crypto.getRandomValues`. |
| F-004-R4 | The encryption key MUST be loaded from `TOKEN_ENCRYPTION_KEY` via the env binding. The key MUST be 32 bytes after base64 decode. |
| F-004-R5 | The system MUST refuse to start if `TOKEN_ENCRYPTION_KEY` is missing or wrong length. |
| F-004-R6 | Plaintext tokens MUST NOT appear in any `console.log`, `console.error`, persisted log, error message, or response body. |
| F-004-R7 | Decryption failures MUST be reported with a generic error code (`token_integrity_failure`) without exposing IV or ciphertext bytes. |
| F-004-R8 | The Postgres columns for ciphertext and IV MUST be `bytea`. |
| F-004-R9 | Encryption MUST authenticate the ciphertext (GCM tag verification on decrypt); modifications MUST cause decryption to fail. |
| F-004-R10 | The helper module MUST expose only four functions: `encryptToken`, `decryptToken`, `persistTokens(provider, ...)`, `loadTokens(provider)`. No other token-handling functions. |
| F-004-R11 | Key rotation is out of scope for v1; the spec MUST be updated before introducing it. |

## Database schema

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

## Data effects

- All writes go through `persistTokens`, never raw INSERT/UPDATE
- All reads go through `loadTokens`, never raw SELECT

## Failure modes

| Mode | Cause | Recovery |
|---|---|---|
| `token_integrity_failure` on decrypt | Database corruption or accidental column modification | Re-run OAuth flow for the affected provider |
| Key missing on startup | Misconfiguration | Fix env binding; redeploy |
| Key mismatch (cannot decrypt any tokens) | `TOKEN_ENCRYPTION_KEY` rotated without re-encryption | Restore previous key from secret backup or re-run all OAuth flows |

## Acceptance criteria

- All tests in T-004 pass
- The `provider_tokens` table never contains plaintext-looking values (verified by manual inspection in Neon)
- A round trip (encrypt → persist → load → decrypt) returns the exact plaintext input for inputs of length 1, 100, 10,000 bytes
- A modified ciphertext byte causes decrypt to throw, every time
