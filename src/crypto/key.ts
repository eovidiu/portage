export class IntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IntegrityError";
  }
}

export async function importKey(
  keyB64: string,
  usage: "encrypt" | "decrypt"
): Promise<CryptoKey> {
  if (!keyB64) {
    throw new Error("TOKEN_ENCRYPTION_KEY is not set");
  }
  const raw = Uint8Array.from(atob(keyB64), (c) => c.charCodeAt(0));
  if (raw.byteLength !== 32) {
    throw new Error(`key must be 32 bytes after base64 decode, got ${raw.byteLength}`);
  }
  return crypto.subtle.importKey(
    "raw",
    raw,
    { name: "AES-GCM", length: 256 },
    false,
    [usage]
  );
}
