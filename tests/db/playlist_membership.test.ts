import { describe, it, expect, vi, beforeEach } from "vitest";

const mockQuery = vi.fn();

vi.mock("@neondatabase/serverless", () => ({
  neon: () => mockQuery,
}));

import {
  buildMembershipUpsertQueries,
  markMembershipSynced,
  selectUnsyncedMatchesForPlaylist,
  type PlaylistMembershipRow,
} from "../../src/db/playlist_membership";

beforeEach(() => {
  mockQuery.mockReset();
});

describe("buildMembershipUpsertQueries (sync-callback array form)", () => {
  it("returns one query per row", () => {
    const mockTxSql = vi.fn().mockReturnValue(Promise.resolve([]));
    const rows: PlaylistMembershipRow[] = [
      { spotify_playlist_id: "abc123", spotify_track_id: "t-a", added_at: "2026-05-09T10:00:00Z" },
      { spotify_playlist_id: "abc123", spotify_track_id: "t-b", added_at: "2026-05-09T11:00:00Z" },
    ];
    const queries = buildMembershipUpsertQueries(
      mockTxSql as Parameters<typeof buildMembershipUpsertQueries>[0],
      rows,
    );
    expect(queries).toHaveLength(2);
    expect(mockTxSql).toHaveBeenCalledTimes(2);
    const [sql0, params0] = mockTxSql.mock.calls[0] as [string, unknown[]];
    expect(sql0.toLowerCase()).toContain("insert into playlist_membership");
    expect(sql0.toLowerCase()).toContain("on conflict");
    expect(sql0.toLowerCase()).toContain("do nothing");
    // DO NOTHING (not DO UPDATE SET) preserves the original added_at on duplicate
    expect(sql0.toLowerCase()).not.toContain("do update set");
    expect(params0).toEqual(["abc123", "t-a", "2026-05-09T10:00:00Z"]);
  });

  it("returns empty array for empty input without invoking txSql", () => {
    const mockTxSql = vi.fn();
    const queries = buildMembershipUpsertQueries(
      mockTxSql as Parameters<typeof buildMembershipUpsertQueries>[0],
      [],
    );
    expect(queries).toEqual([]);
    expect(mockTxSql).not.toHaveBeenCalled();
  });
});

describe("T-017-07: markMembershipSynced flips synced_at for given track IDs", () => {
  it("UPDATEs synced_at via WHERE spotify_track_id = ANY(...)", async () => {
    mockQuery.mockResolvedValueOnce([]);
    await markMembershipSynced(
      mockQuery as Parameters<typeof markMembershipSynced>[0],
      "abc123",
      ["track-a", "track-c"],
      "2026-05-09T12:00:00Z",
    );
    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql.toLowerCase()).toContain("update playlist_membership");
    expect(sql.toLowerCase()).toContain("set synced_at");
    expect(sql.toLowerCase()).toContain("where spotify_playlist_id");
    expect(sql.toLowerCase()).toContain("any");
    expect(params).toEqual(["abc123", "2026-05-09T12:00:00Z", ["track-a", "track-c"]]);
  });

  it("returns early without DB call for empty trackIds", async () => {
    await markMembershipSynced(
      mockQuery as Parameters<typeof markMembershipSynced>[0],
      "abc123",
      [],
      "2026-05-09T12:00:00Z",
    );
    expect(mockQuery).not.toHaveBeenCalled();
  });
});

describe("T-017-08: selectUnsyncedMatchesForPlaylist returns only unsynced + matched + valid", () => {
  it("issues a JOIN on matches with synced_at IS NULL AND NOT tidal_id_invalid", async () => {
    mockQuery.mockResolvedValueOnce([
      { spotify_track_id: "t1", tidal_id: "tidal-1" },
    ]);
    const result = await selectUnsyncedMatchesForPlaylist(
      mockQuery as Parameters<typeof selectUnsyncedMatchesForPlaylist>[0],
      "abc123",
    );
    expect(result).toEqual([{ spotify_track_id: "t1", tidal_id: "tidal-1" }]);
    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    const lower = sql.toLowerCase();
    expect(lower).toContain("from playlist_membership");
    expect(lower).toContain("join matches");
    expect(lower).toContain("synced_at is null");
    expect(lower).toContain("not");
    expect(lower).toContain("tidal_id_invalid");
    expect(params).toEqual(["abc123"]);
  });
});
