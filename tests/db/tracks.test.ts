import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Env } from "../../src/env";

const mockQuery = vi.fn();

vi.mock("@neondatabase/serverless", () => ({
  neon: () => mockQuery,
}));

import { upsertTracks, buildUpsertQueries, countTracks, type TrackRow } from "../../src/db/tracks";

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

const track: TrackRow = {
  spotify_id: "abc123",
  isrc: "GBUM71029604",
  artist: "Artist",
  title: "Title",
  album: "Album",
  duration_ms: 210000,
  spotify_added_at: "2026-04-25T10:00:00Z",
};

beforeEach(() => {
  mockQuery.mockReset();
});

describe("upsertTracks", () => {
  it("returns 0 for empty input without calling sql", async () => {
    const result = await upsertTracks(mockQuery as Parameters<typeof upsertTracks>[0], []);
    expect(result).toBe(0);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("uses ON CONFLICT DO NOTHING in SQL", async () => {
    mockQuery.mockResolvedValueOnce([{ spotify_id: "abc123" }]);
    await upsertTracks(mockQuery as Parameters<typeof upsertTracks>[0], [track]);
    const [sql] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql.toLowerCase()).toContain("on conflict");
    expect(sql.toLowerCase()).toContain("do nothing");
  });

  it("returns count of actually-inserted rows", async () => {
    mockQuery
      .mockResolvedValueOnce([{ spotify_id: "a" }])
      .mockResolvedValueOnce([]);
    const result = await upsertTracks(mockQuery as Parameters<typeof upsertTracks>[0], [
      { ...track, spotify_id: "a" },
      { ...track, spotify_id: "b" },
    ]);
    expect(result).toBe(1);
  });

  it("passes all 7 columns in correct order", async () => {
    mockQuery.mockResolvedValueOnce([{ spotify_id: "abc123" }]);
    await upsertTracks(mockQuery as Parameters<typeof upsertTracks>[0], [track]);
    const [, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(params[0]).toBe("abc123");
    expect(params[1]).toBe("GBUM71029604");
    expect(params[2]).toBe("Artist");
    expect(params[3]).toBe("Title");
    expect(params[4]).toBe("Album");
    expect(params[5]).toBe(210000);
    expect(params[6]).toBe("2026-04-25T10:00:00Z");
  });

  it("passes null isrc when absent", async () => {
    mockQuery.mockResolvedValueOnce([{ spotify_id: "x" }]);
    await upsertTracks(mockQuery as Parameters<typeof upsertTracks>[0], [{ ...track, spotify_id: "x", isrc: null }]);
    const [, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(params[1]).toBeNull();
  });
});

describe("buildUpsertQueries", () => {
  it("returns one query per track", () => {
    const mockTxSql = vi.fn().mockReturnValue(Promise.resolve([]));
    const queries = buildUpsertQueries(
      mockTxSql as Parameters<typeof buildUpsertQueries>[0],
      [track, { ...track, spotify_id: "xyz" }],
    );
    expect(queries).toHaveLength(2);
    expect(mockTxSql).toHaveBeenCalledTimes(2);
  });

  it("returns empty array for zero tracks", () => {
    const mockTxSql = vi.fn();
    const queries = buildUpsertQueries(mockTxSql as Parameters<typeof buildUpsertQueries>[0], []);
    expect(queries).toHaveLength(0);
    expect(mockTxSql).not.toHaveBeenCalled();
  });
});

describe("countTracks", () => {
  it("returns the integer count from SELECT COUNT", async () => {
    mockQuery.mockResolvedValueOnce([{ n: 42 }]);
    const count = await countTracks(makeEnv());
    expect(count).toBe(42);
    const [sql] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql.toLowerCase()).toContain("count");
  });
});
