import { describe, it, expect } from "vitest";
import { encryptToken, decryptToken } from "../../src/crypto";

const TEST_KEY_B64 = btoa(String.fromCharCode(...new Array(32).fill(0x42)));
const ALT_KEY_B64 = btoa(String.fromCharCode(...new Array(32).fill(0x99)));

describe("decryptToken", () => {
  it("T-004-06: throws IntegrityError on tampered ciphertext", async () => {
    const { ciphertext, iv } = await encryptToken("original", TEST_KEY_B64);
    const tampered = new Uint8Array(ciphertext);
    tampered[tampered.byteLength - 1] ^= 0xff;
    await expect(decryptToken(tampered, iv, TEST_KEY_B64)).rejects.toThrow(
      /IntegrityError|integrity|decryption failed/i
    );
  });

  it("T-004-07: throws on tampered IV", async () => {
    const { ciphertext, iv } = await encryptToken("original", TEST_KEY_B64);
    const tamperedIv = new Uint8Array(iv);
    tamperedIv[0] ^= 0x01;
    await expect(decryptToken(ciphertext, tamperedIv, TEST_KEY_B64)).rejects.toThrow(
      /IntegrityError|integrity|decryption failed/i
    );
  });

  it("T-004-08: throws when decrypting with a different key", async () => {
    const { ciphertext, iv } = await encryptToken("original", TEST_KEY_B64);
    await expect(decryptToken(ciphertext, iv, ALT_KEY_B64)).rejects.toThrow(
      /IntegrityError|integrity|decryption failed/i
    );
  });
});
