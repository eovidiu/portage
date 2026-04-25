# T-004: Token encryption tests

Covers F-004.

---

## T-004-01: Round-trip preserves short input

**Type**: assertion

**Setup**: Set `TOKEN_ENCRYPTION_KEY` to a known 32-byte key.

**Action**: Encrypt the string `"a"`; immediately decrypt the result.

**Assertion**: Decrypted output equals `"a"`.

**Pass**: TRUE if equal.

---

## T-004-02: Round-trip preserves typical-length input

**Type**: assertion

**Setup**: Same key as above.

**Action**: Encrypt a 200-byte ASCII random string; decrypt.

**Assertion**: Decrypted output equals the original.

**Pass**: TRUE if equal.

---

## T-004-03: Round-trip preserves large input

**Type**: assertion

**Setup**: Same key.

**Action**: Encrypt a 10,000-byte random string; decrypt.

**Assertion**: Decrypted output equals the original.

**Pass**: TRUE if equal.

---

## T-004-04: IV is exactly 12 bytes

**Type**: assertion

**Setup**: Same key.

**Action**: Encrypt the string `"sample"`; inspect the returned IV.

**Assertion**: IV byte length equals 12.

**Pass**: TRUE if length == 12.

---

## T-004-05: IV is unique across operations

**Type**: assertion

**Setup**: Same key.

**Action**: Encrypt the string `"sample"` 1000 times; collect all IVs.

**Assertion**: All 1000 IVs are distinct.

**Pass**: TRUE if `len(set(ivs)) == 1000`.

---

## T-004-06: Tampered ciphertext fails decryption

**Type**: assertion

**Setup**: Same key. Encrypt `"original"`.

**Action**: Flip the last bit of the ciphertext; attempt to decrypt.

**Assertion**: Decryption raises an exception of type `IntegrityError` (or equivalent), and no plaintext is returned.

**Pass**: TRUE if exception is raised AND no return value.

---

## T-004-07: Tampered IV fails decryption

**Type**: assertion

**Setup**: Same key. Encrypt `"original"`.

**Action**: Flip the first bit of the IV; attempt to decrypt with the modified IV.

**Assertion**: Decryption raises an exception, no plaintext returned.

**Pass**: TRUE if exception raised.

---

## T-004-08: Wrong key fails decryption

**Type**: assertion

**Setup**: Encrypt `"original"` with key A.

**Action**: Attempt to decrypt with key B (different 32-byte key).

**Assertion**: Decryption raises an exception.

**Pass**: TRUE if exception raised.

---

## T-004-09: Missing key fails on startup

**Type**: assertion

**Setup**: Unset `TOKEN_ENCRYPTION_KEY`.

**Action**: Start the Worker (in dev mode) and capture the error.

**Assertion**: Worker fails to start with an error message containing the substring `"TOKEN_ENCRYPTION_KEY"`.

**Pass**: TRUE if both hold.

---

## T-004-10: Wrong-length key fails on startup

**Type**: assertion

**Setup**: Set `TOKEN_ENCRYPTION_KEY` to a 16-byte (base64-decoded) value.

**Action**: Start the Worker; capture the error.

**Assertion**: Worker fails to start with an error message containing the substring `"key must be 32 bytes"` or equivalent.

**Pass**: TRUE if startup fails AND error mentions key length.

---

## T-004-11: persistTokens upserts correctly

**Type**: assertion

**Setup**: Empty `provider_tokens` table.

**Action**: Call `persistTokens('spotify', { accessToken: 'AT1', refreshToken: 'RT1', expiresAt: T1 })`; then call again with `{ accessToken: 'AT2', refreshToken: 'RT2', expiresAt: T2 }`.

**Assertion**: Exactly one row exists for `provider = 'spotify'`. After both calls, decrypting yields `accessToken = 'AT2'`, `refreshToken = 'RT2'`, and `expires_at = T2`.

**Pass**: TRUE if all conditions hold.

---

## T-004-12: loadTokens returns plaintext

**Type**: assertion

**Setup**: Persist tokens with plaintext `"AT_FIXED"` and `"RT_FIXED"`.

**Action**: Call `loadTokens('spotify')`.

**Assertion**: Returned object equals `{ accessToken: 'AT_FIXED', refreshToken: 'RT_FIXED', expiresAt: <stored value> }`.

**Pass**: TRUE if exact match.

---

## T-004-13: No plaintext token in any log line

**Type**: assertion

**Setup**: Persist tokens with plaintext containing canary string `TOKENPLAINCANARY`. Capture all log output during a complete sync run.

**Action**: Run F-005 → F-008 end to end against mocks.

**Assertion**: No log line in the captured output contains `TOKENPLAINCANARY`.

**Pass**: TRUE if substring not found.

---

## T-004-14: Encryption performance

**Type**: metric

**Setup**: Same key.

**Action**: Encrypt and decrypt a 1,000-byte string 10,000 times in sequence; record total wall time.

**Measurement**: Total wall time in milliseconds.

**Pass**: metric value MUST be < 5000 ms (i.e., > 2,000 round-trips per second on the target Worker).

---

## T-004-15: Cipher is exactly AES-256-GCM

**Type**: assertion

**Setup**: Inspect the source code or runtime configuration.

**Action**: Verify the algorithm parameter passed to `crypto.subtle.encrypt`.

**Assertion**: Algorithm name is exactly `"AES-GCM"` and key length is 256 bits.

**Pass**: TRUE if both hold.
