import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Env } from "../../src/env";
import { persistTokens, loadTokens, markRevoked } from "../../src/db/provider_tokens";

const TEST_KEY_B64 = btoa(String.fromCharCode(...new Array(32).fill(0x42)));

const makeEnv = (): Env => ({
  DATABASE_URL: "postgresql://test",
  JWT_SECRET: "secret",
  TOKEN_ENCRYPTION_KEY: TEST_KEY_B64,
  SPOTIFY_CLIENT_ID: "",
  SPOTIFY_CLIENT_SECRET: "",
  SPOTIFY_REDIRECT_URI: "",
  TIDAL_CLIENT_ID: "",
  TIDAL_CLIENT_SECRET: "",
  TIDAL_REDIRECT_URI: "",
  TIDAL_COUNTRY_CODE: "RO",
  TIDAL_PLAYLIST_TITLE: "Spotify Liked",
});

// Capture the SQL calls made to the mocked neon client
const mockQuery = vi.fn();

vi.mock("@neondatabase/serverless", () => ({
  neon: () => mockQuery,
}));

beforeEach(() => {
  mockQuery.mockReset();
});

describe("persistTokens", () => {
  it("T-004b-01: encrypts both tokens and UPSERTs with separate IVs", async () => {
    mockQuery.mockResolvedValueOnce([]);

    const env = makeEnv();
    const expiresAt = new Date("2026-12-31T00:00:00Z");
    await persistTokens(env, "spotify", "access-plain", "refresh-plain", expiresAt);

    expect(mockQuery).toHaveBeenCalledOnce();
    const [_sql, paramsArr] = mockQuery.mock.calls[0] as [string, unknown[]];

    // params: [access_ciphertext, access_iv, refresh_ciphertext, refresh_iv, expires_at, provider]
    const accessCiphertext = paramsArr[0] as Buffer;
    const accessIv = paramsArr[1] as Buffer;
    const refreshCiphertext = paramsArr[2] as Buffer;
    const refreshIv = paramsArr[3] as Buffer;

    expect(accessIv).toBeInstanceOf(Buffer);
    expect(refreshIv).toBeInstanceOf(Buffer);
    expect(accessIv.byteLength).toBe(12);
    expect(refreshIv.byteLength).toBe(12);

    // IVs must be different (separate encryption operations)
    expect(Buffer.compare(accessIv, refreshIv)).not.toBe(0);

    expect(accessCiphertext).toBeInstanceOf(Buffer);
    expect(refreshCiphertext).toBeInstanceOf(Buffer);
    // Ciphertext must not contain plaintext
    expect(accessCiphertext.toString()).not.toContain("access-plain");
    expect(refreshCiphertext.toString()).not.toContain("refresh-plain");
  });

  it("T-004b-01b: SQL contains UPSERT keyword (INSERT ... ON CONFLICT)", async () => {
    mockQuery.mockResolvedValueOnce([]);
    const env = makeEnv();
    await persistTokens(env, "tidal", "at", "rt", new Date());

    const [sql] = mockQuery.mock.calls[0] as [string];
    expect(sql.toLowerCase()).toContain("on conflict");
  });
});

describe("loadTokens", () => {
  it("T-004b-02: decrypts both tokens correctly (round-trip)", async () => {
    const env = makeEnv();
    const { encryptToken } = await import("../../src/crypto");

    const { ciphertext: atCt, iv: atIv } = await encryptToken("access-secret", TEST_KEY_B64);
    const { ciphertext: rtCt, iv: rtIv } = await encryptToken("refresh-secret", TEST_KEY_B64);

    // Return a DB row with bytea as Buffer (how @neondatabase/serverless delivers bytea)
    mockQuery.mockResolvedValueOnce([{
      access_token_ciphertext: Buffer.from(atCt),
      access_token_iv: Buffer.from(atIv),
      refresh_token_ciphertext: Buffer.from(rtCt),
      refresh_token_iv: Buffer.from(rtIv),
      expires_at: new Date("2026-12-31T00:00:00Z"),
      status: "active",
    }]);

    const result = await loadTokens(env, "spotify");

    expect(result).not.toBeNull();
    expect(result!.accessToken).toBe("access-secret");
    expect(result!.refreshToken).toBe("refresh-secret");
    expect(result!.status).toBe("active");
    expect(result!.expiresAt).toBeInstanceOf(Date);
  });

  it("T-004b-02b: returns null when no row exists", async () => {
    mockQuery.mockResolvedValueOnce([]);
    const result = await loadTokens(makeEnv(), "spotify");
    expect(result).toBeNull();
  });

  it("T-004b-02c: returns row even when status is revoked", async () => {
    const env = makeEnv();
    const { encryptToken } = await import("../../src/crypto");
    const { ciphertext: atCt, iv: atIv } = await encryptToken("at", TEST_KEY_B64);
    const { ciphertext: rtCt, iv: rtIv } = await encryptToken("rt", TEST_KEY_B64);

    mockQuery.mockResolvedValueOnce([{
      access_token_ciphertext: Buffer.from(atCt),
      access_token_iv: Buffer.from(atIv),
      refresh_token_ciphertext: Buffer.from(rtCt),
      refresh_token_iv: Buffer.from(rtIv),
      expires_at: new Date(),
      status: "revoked",
    }]);

    const result = await loadTokens(env, "spotify");
    expect(result).not.toBeNull();
    expect(result!.status).toBe("revoked");
  });
});

describe("markRevoked", () => {
  it("T-004b-03: issues UPDATE SET status=revoked for the correct provider", async () => {
    mockQuery.mockResolvedValueOnce([]);
    await markRevoked(makeEnv(), "tidal");

    expect(mockQuery).toHaveBeenCalledOnce();
    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql.toLowerCase()).toContain("status");
    expect(sql.toLowerCase()).toContain("revoked");
    expect(params[0]).toBe("tidal");
  });
});
