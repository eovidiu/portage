import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Env } from "../../src/env";

const mockQuery = vi.fn();

vi.mock("@neondatabase/serverless", () => ({
  neon: () => mockQuery,
}));

import { readCursor, buildCursorQuery, keyForPlaylist } from "../../src/db/sync_state";

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

describe("buildCursorQuery", () => {
  it("returns a query (thenable) with the UPSERT SQL and correct params", () => {
    const mockTxSql = vi.fn().mockReturnValue(Promise.resolve([]));
    buildCursorQuery(mockTxSql as Parameters<typeof buildCursorQuery>[0], "spotify_cursor", "2026-04-25T07:00:00Z");
    expect(mockTxSql).toHaveBeenCalledOnce();
    const [sql, params] = mockTxSql.mock.calls[0] as [string, unknown[]];
    expect(sql.toLowerCase()).toContain("on conflict");
    expect(params[0]).toBe("spotify_cursor");
    expect(params[1]).toBe("2026-04-25T07:00:00Z");
  });
});

describe("T-017-03: keyForPlaylist format for extras", () => {
  it("returns playlist:{id}:cursor for extras", () => {
    expect(keyForPlaylist("cursor", "abc123")).toBe("playlist:abc123:cursor");
  });

  it("returns playlist:{id}:resume_url for extras", () => {
    expect(keyForPlaylist("resume_url", "abc123")).toBe("playlist:abc123:resume_url");
  });

  it("returns playlist:{id}:sweep_max for extras", () => {
    expect(keyForPlaylist("sweep_max", "abc123")).toBe("playlist:abc123:sweep_max");
  });
});

describe("T-017-04: keyForPlaylist special-cases __liked__", () => {
  it("returns the legacy flat keys for __liked__ (preserves F-005 backward compat)", () => {
    expect(keyForPlaylist("cursor", "__liked__")).toBe("spotify_cursor");
    expect(keyForPlaylist("resume_url", "__liked__")).toBe("spotify_resume_url");
    expect(keyForPlaylist("sweep_max", "__liked__")).toBe("spotify_sweep_max");
  });
});
