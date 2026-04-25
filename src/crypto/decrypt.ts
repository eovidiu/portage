import { importKey, IntegrityError } from "./key";

export async function decryptToken(
  ciphertext: Uint8Array,
  iv: Uint8Array,
  keyB64: string
): Promise<string> {
  const cryptoKey = await importKey(keyB64, "decrypt");
  let plaintextBuf: ArrayBuffer;
  try {
    plaintextBuf = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv },
      cryptoKey,
      ciphertext
    );
  } catch {
    throw new IntegrityError("decryption failed: token_integrity_failure");
  }
  return new TextDecoder().decode(plaintextBuf);
}
