import { describe, it, expect, vi, beforeEach } from "vitest";

const mockQuery = vi.fn();

vi.mock("@neondatabase/serverless", () => ({
  neon: () => mockQuery,
}));

import {
  upsertPlaylistConfig,
  listPlaylistConfigs,
  getPlaylistConfig,
  setTidalPlaylistId,
  markSynced,
  type PlaylistConfigRow,
} from "../../src/db/playlist_configs";

beforeEach(() => {
  mockQuery.mockReset();
});

describe("T-016-03: upsertPlaylistConfig inserts a new row", () => {
  it("issues an INSERT ... ON CONFLICT statement", async () => {
    mockQuery.mockResolvedValueOnce([]);
    await upsertPlaylistConfig(
      mockQuery as Parameters<typeof upsertPlaylistConfig>[0],
      { spotify_playlist_id: "abc123", spotify_name: "Workout" },
    );
    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql.toLowerCase()).toContain("insert into playlist_configs");
    expect(sql.toLowerCase()).toContain("on conflict");
    expect(sql.toLowerCase()).toContain("do update");
    expect(params).toEqual(["abc123", "Workout"]);
  });
});

describe("T-016-04: upsertPlaylistConfig updates spotify_name only", () => {
  it("does not touch tidal_playlist_id or created_at in the UPDATE clause", async () => {
    mockQuery.mockResolvedValueOnce([]);
    await upsertPlaylistConfig(
      mockQuery as Parameters<typeof upsertPlaylistConfig>[0],
      { spotify_playlist_id: "abc123", spotify_name: "New" },
    );
    const [sql] = mockQuery.mock.calls[0] as [string, unknown[]];
    const lower = sql.toLowerCase();
    // The DO UPDATE clause must mention spotify_name but NOT tidal_playlist_id or created_at
    const updateClauseMatch = lower.match(/do update set([\s\S]*)$/);
    expect(updateClauseMatch).toBeTruthy();
    const updateClause = updateClauseMatch![1];
    expect(updateClause).toContain("spotify_name");
    expect(updateClause).not.toContain("tidal_playlist_id");
    expect(updateClause).not.toContain("created_at");
  });
});

describe("T-016-05: setTidalPlaylistId writes the Tidal ID", () => {
  it("UPDATEs the tidal_playlist_id column for the given spotify_playlist_id", async () => {
    mockQuery.mockResolvedValueOnce([]);
    await setTidalPlaylistId(
      mockQuery as Parameters<typeof setTidalPlaylistId>[0],
      "abc123",
      "tidal-99",
    );
    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql.toLowerCase()).toContain("update playlist_configs");
    expect(sql.toLowerCase()).toContain("set tidal_playlist_id");
    expect(params).toEqual(["abc123", "tidal-99"]);
  });
});

describe("T-016-06: markSynced updates last_synced_at", () => {
  it("UPDATEs last_synced_at to the given timestamp", async () => {
    mockQuery.mockResolvedValueOnce([]);
    await markSynced(
      mockQuery as Parameters<typeof markSynced>[0],
      "abc123",
      "2026-05-08T10:00:00Z",
    );
    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql.toLowerCase()).toContain("update playlist_configs");
    expect(sql.toLowerCase()).toContain("set last_synced_at");
    expect(params).toEqual(["abc123", "2026-05-08T10:00:00Z"]);
  });
});

describe("T-016-07: listPlaylistConfigs returns all rows", () => {
  it("returns the array as Spotify-keyed PlaylistConfigRow objects", async () => {
    const dbRows: PlaylistConfigRow[] = [
      {
        spotify_playlist_id: "__liked__",
        spotify_name: "Spotify Liked",
        tidal_playlist_id: null,
        created_at: "2026-05-08T00:00:00Z",
        last_synced_at: null,
        enabled: true,
      },
      {
        spotify_playlist_id: "abc123",
        spotify_name: "Workout",
        tidal_playlist_id: "tidal-9",
        created_at: "2026-05-08T01:00:00Z",
        last_synced_at: "2026-05-08T02:00:00Z",
        enabled: true,
      },
    ];
    mockQuery.mockResolvedValueOnce(dbRows);
    const result = await listPlaylistConfigs(
      mockQuery as Parameters<typeof listPlaylistConfigs>[0],
    );
    expect(result).toHaveLength(2);
    expect(result.map((r) => r.spotify_playlist_id).sort()).toEqual([
      "__liked__",
      "abc123",
    ]);
  });

  it("returns empty array when table is empty", async () => {
    mockQuery.mockResolvedValueOnce([]);
    const result = await listPlaylistConfigs(
      mockQuery as Parameters<typeof listPlaylistConfigs>[0],
    );
    expect(result).toEqual([]);
  });
});

describe("getPlaylistConfig", () => {
  it("returns the row when found", async () => {
    mockQuery.mockResolvedValueOnce([
      {
        spotify_playlist_id: "abc123",
        spotify_name: "Workout",
        tidal_playlist_id: "tidal-9",
        created_at: "2026-05-08T01:00:00Z",
        last_synced_at: null,
      },
    ]);
    const result = await getPlaylistConfig(
      mockQuery as Parameters<typeof getPlaylistConfig>[0],
      "abc123",
    );
    expect(result).not.toBeNull();
    expect(result!.spotify_playlist_id).toBe("abc123");
    expect(result!.tidal_playlist_id).toBe("tidal-9");
  });

  it("returns null when no row exists", async () => {
    mockQuery.mockResolvedValueOnce([]);
    const result = await getPlaylistConfig(
      mockQuery as Parameters<typeof getPlaylistConfig>[0],
      "missing",
    );
    expect(result).toBeNull();
  });
});
