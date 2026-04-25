import { describe, it, expect } from "vitest";
import { encryptToken } from "../../src/crypto";

const TEST_KEY_B64 = btoa(String.fromCharCode(...new Array(32).fill(0x42)));

describe("encryptToken", () => {
  it("T-004-04: returns iv that is exactly 12 bytes", async () => {
    const result = await encryptToken("sample", TEST_KEY_B64);
    expect(result.iv).toBeInstanceOf(Uint8Array);
    expect(result.iv.byteLength).toBe(12);
  });

  it("T-004-04: returns ciphertext as Uint8Array", async () => {
    const result = await encryptToken("sample", TEST_KEY_B64);
    expect(result.ciphertext).toBeInstanceOf(Uint8Array);
  });

  it("T-004-05: IV is unique across 1000 operations", async () => {
    const ivs = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      const { iv } = await encryptToken("sample", TEST_KEY_B64);
      ivs.add(Array.from(iv).join(","));
    }
    expect(ivs.size).toBe(1000);
  });

  it("T-004-15: uses AES-256-GCM algorithm", async () => {
    const key = await crypto.subtle.importKey(
      "raw",
      Uint8Array.from(atob(TEST_KEY_B64), (c) => c.charCodeAt(0)),
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt"]
    );
    expect(key.algorithm.name).toBe("AES-GCM");
    const keyDetails = key.algorithm as AesKeyAlgorithm;
    expect(keyDetails.length).toBe(256);
  });

  it("T-004-10: throws if key is wrong length (16 bytes)", async () => {
    const shortKey = btoa(String.fromCharCode(...new Array(16).fill(0x42)));
    await expect(encryptToken("test", shortKey)).rejects.toThrow(
      /key must be 32 bytes/i
    );
  });

  it("T-004-09: throws if key is missing/empty", async () => {
    await expect(encryptToken("test", "")).rejects.toThrow(
      /TOKEN_ENCRYPTION_KEY/i
    );
  });
});
