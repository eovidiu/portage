import { importKey } from "./key";

export interface EncryptResult {
  ciphertext: Uint8Array;
  iv: Uint8Array;
}

export async function encryptToken(
  plaintext: string,
  keyB64: string
): Promise<EncryptResult> {
  const cryptoKey = await importKey(keyB64, "encrypt");
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(plaintext);
  const ciphertextBuf = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    cryptoKey,
    encoded
  );
  return {
    ciphertext: new Uint8Array(ciphertextBuf),
    iv,
  };
}
