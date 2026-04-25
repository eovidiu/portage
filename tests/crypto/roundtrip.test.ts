import { describe, it, expect } from "vitest";
import { encryptToken, decryptToken } from "../../src/crypto";

const TEST_KEY_B64 = btoa(String.fromCharCode(...new Array(32).fill(0x42)));

function randomString(length: number): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const arr = new Uint8Array(length);
  crypto.getRandomValues(arr);
  return Array.from(arr, (b) => chars[b % chars.length]).join("");
}

describe("round-trip", () => {
  it("T-004-01: preserves short input ('a')", async () => {
    const { ciphertext, iv } = await encryptToken("a", TEST_KEY_B64);
    const plaintext = await decryptToken(ciphertext, iv, TEST_KEY_B64);
    expect(plaintext).toBe("a");
  });

  it("T-004-02: preserves 200-byte ASCII string", async () => {
    const original = randomString(200);
    const { ciphertext, iv } = await encryptToken(original, TEST_KEY_B64);
    const plaintext = await decryptToken(ciphertext, iv, TEST_KEY_B64);
    expect(plaintext).toBe(original);
  });

  it("T-004-03: preserves 10,000-byte string", async () => {
    const original = randomString(10_000);
    const { ciphertext, iv } = await encryptToken(original, TEST_KEY_B64);
    const plaintext = await decryptToken(ciphertext, iv, TEST_KEY_B64);
    expect(plaintext).toBe(original);
  });

  it("round-trip preserves unicode with emoji", async () => {
    const original = "Hello 世界 🌍 éàü";
    const { ciphertext, iv } = await encryptToken(original, TEST_KEY_B64);
    const plaintext = await decryptToken(ciphertext, iv, TEST_KEY_B64);
    expect(plaintext).toBe(original);
  });

  it("T-004-14: 10,000 round-trips of 1,000-byte string in < 5000ms", async () => {
    const input = randomString(1_000);
    const start = Date.now();
    for (let i = 0; i < 10_000; i++) {
      const { ciphertext, iv } = await encryptToken(input, TEST_KEY_B64);
      await decryptToken(ciphertext, iv, TEST_KEY_B64);
    }
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(5000);
  }, 30_000);

  it("property: 100 random plaintexts all round-trip cleanly", async () => {
    for (let i = 0; i < 100; i++) {
      const len = 1 + Math.floor(Math.random() * 499);
      const original = randomString(len);
      const { ciphertext, iv } = await encryptToken(original, TEST_KEY_B64);
      const plaintext = await decryptToken(ciphertext, iv, TEST_KEY_B64);
      expect(plaintext).toBe(original);
    }
  });
});
