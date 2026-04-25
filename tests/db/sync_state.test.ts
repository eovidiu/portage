import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Env } from "../../src/env";

const mockQuery = vi.fn();

vi.mock("@neondatabase/serverless", () => ({
  neon: () => mockQuery,
}));

import { readCursor, writeCursor } from "../../src/db/sync_state";

const makeEnv = (): Env => ({
  DATABASE_URL: "postgresql://test",
  JWT_SECRET: "secret",
  TOKEN_ENCRYPTION_KEY: btoa(String.fromCharCode(...new Array(32).fill(0x42))),
  SPOTIFY_CLIENT_ID: "",
  SPOTIFY_CLIENT_SECRET: "",
  SPOTIFY_REDIRECT_URI: "",
  TIDAL_CLIENT_ID: "",
  TIDAL_CLIENT_SECRET: "",
  TIDAL_REDIRECT_URI: "",
  TIDAL_COUNTRY_CODE: "RO",
  TIDAL_PLAYLIST_TITLE: "Spotify Liked",
});

beforeEach(() => {
  mockQuery.mockReset();
});

describe("readCursor", () => {
  it("returns cold start timestamp when no row exists", async () => {
    mockQuery.mockResolvedValueOnce([]);
    const cursor = await readCursor(makeEnv(), "spotify_cursor");
    expect(cursor).toBe("1970-01-01T00:00:00Z");
  });

  it("returns stored value when row exists", async () => {
    mockQuery.mockResolvedValueOnce([{ value: "2026-04-25T07:00:00Z" }]);
    const cursor = await readCursor(makeEnv(), "spotify_cursor");
    expect(cursor).toBe("2026-04-25T07:00:00Z");
  });

  it("queries by the provided key", async () => {
    mockQuery.mockResolvedValueOnce([]);
    await readCursor(makeEnv(), "my_key");
    const [, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(params[0]).toBe("my_key");
  });
});

describe("writeCursor", () => {
  it("issues an UPSERT with the key and value", async () => {
    mockQuery.mockResolvedValueOnce([]);
    await writeCursor(mockQuery, "spotify_cursor", "2026-04-25T07:00:00Z");
    expect(mockQuery).toHaveBeenCalledOnce();
    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql.toLowerCase()).toContain("on conflict");
    expect(params[0]).toBe("spotify_cursor");
    expect(params[1]).toBe("2026-04-25T07:00:00Z");
  });
});
