import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Env } from "../../src/env";
import {
  storeOAuthState,
  consumeOAuthState,
  purgeExpiredOAuthState,
} from "../../src/db/oauth_state";

const makeEnv = (): Env => ({
  DATABASE_URL: "postgresql://test",
  JWT_SECRET: "secret",
  TOKEN_ENCRYPTION_KEY: "",
  SPOTIFY_CLIENT_ID: "",
  SPOTIFY_CLIENT_SECRET: "",
  SPOTIFY_REDIRECT_URI: "",
  TIDAL_CLIENT_ID: "",
  TIDAL_CLIENT_SECRET: "",
  TIDAL_REDIRECT_URI: "",
  TIDAL_COUNTRY_CODE: "RO",
  TIDAL_PLAYLIST_TITLE: "Spotify Liked",
});

const mockQuery = vi.fn();

vi.mock("@neondatabase/serverless", () => ({
  neon: () => mockQuery,
}));

beforeEach(() => {
  mockQuery.mockReset();
});

describe("storeOAuthState", () => {
  it("T-004b-04: INSERTs with correct shape (state, code_verifier, expires_at)", async () => {
    mockQuery.mockResolvedValueOnce([]);
    const expiresAt = new Date(Date.now() + 600_000);
    await storeOAuthState(makeEnv(), {
      state: "abc123",
      codeVerifier: "verifier-xyz",
      expiresAt,
    });

    expect(mockQuery).toHaveBeenCalledOnce();
    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql.toLowerCase()).toContain("insert");
    expect(params[0]).toBe("abc123");
    expect(params[1]).toBe("verifier-xyz");
    expect(params[2]).toEqual(expiresAt);
  });
});

describe("consumeOAuthState", () => {
  it("T-004b-05: returns code_verifier for a valid state (single atomic query)", async () => {
    mockQuery.mockResolvedValueOnce([{ code_verifier: "verifier-xyz" }]);

    const result = await consumeOAuthState(makeEnv(), "abc123");

    expect(result).not.toBeNull();
    expect(result!.codeVerifier).toBe("verifier-xyz");

    // Atomicity: exactly ONE query call (DELETE ... RETURNING, not separate SELECT+DELETE)
    expect(mockQuery).toHaveBeenCalledOnce();
    const [sql] = mockQuery.mock.calls[0];
    const sqlLower = (sql as string).toLowerCase();
    expect(sqlLower).toContain("delete");
    expect(sqlLower).toContain("returning");
    expect(sqlLower).toContain("expires_at");
  });

  it("T-004b-06: returns null when state not found or expired", async () => {
    mockQuery.mockResolvedValueOnce([]);
    const result = await consumeOAuthState(makeEnv(), "nonexistent");
    expect(result).toBeNull();
  });

  it("T-004b-06b: state parameter is passed to the query", async () => {
    mockQuery.mockResolvedValueOnce([]);
    await consumeOAuthState(makeEnv(), "my-state-val");

    const [_sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(params[0]).toBe("my-state-val");
  });
});

describe("purgeExpiredOAuthState", () => {
  it("T-004b-07: deletes only expired rows (WHERE expires_at < now())", async () => {
    mockQuery.mockResolvedValueOnce([]);
    await purgeExpiredOAuthState(makeEnv());

    expect(mockQuery).toHaveBeenCalledOnce();
    const [sql] = mockQuery.mock.calls[0];
    const sqlLower = (sql as string).toLowerCase();
    expect(sqlLower).toContain("delete");
    expect(sqlLower).toContain("expires_at");
    expect(sqlLower).toContain("now()");
  });
});
