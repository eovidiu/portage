import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Env } from "../../src/env";

vi.mock("../../src/providers/tidal/playlist", () => ({ getPlaylistTracks: vi.fn() }));
vi.mock("../../src/copy/spotify-source", () => ({ getSpotifyPlaylistItems: vi.fn() }));

import { snapshotDestTracks, readDestTailIds } from "../../src/copy/dest-reader";
import { getPlaylistTracks } from "../../src/providers/tidal/playlist";
import { getSpotifyPlaylistItems } from "../../src/copy/spotify-source";

const mockGetPlaylistTracks = vi.mocked(getPlaylistTracks);
const mockGetSpotifyPlaylistItems = vi.mocked(getSpotifyPlaylistItems);
const mockEnv = { DATABASE_URL: "postgresql://test" } as Env;

beforeEach(() => {
  vi.clearAllMocks();
});

function spotifyItem(id: string) {
  return { id, isrc: null, title: "T", artist: null, album: null, duration_ms: null };
}

describe("snapshotDestTracks", () => {
  it("paginates a Tidal destination playlist to completion", async () => {
    mockGetPlaylistTracks
      .mockResolvedValueOnce({ trackIds: ["t1", "t2"], hasMore: true, cursor: "c1" })
      .mockResolvedValueOnce({ trackIds: ["t3"], hasMore: false, cursor: null });

    const result = await snapshotDestTracks(mockEnv, "tidal", "playlist-1", 5000);
    expect(result).toEqual({ ids: ["t1", "t2", "t3"], oversized: false });
    expect(mockGetPlaylistTracks).toHaveBeenNthCalledWith(1, mockEnv, "playlist-1", null);
    expect(mockGetPlaylistTracks).toHaveBeenNthCalledWith(2, mockEnv, "playlist-1", "c1");
  });

  it("paginates a Spotify destination playlist to completion", async () => {
    mockGetSpotifyPlaylistItems.mockResolvedValueOnce({
      items: [spotifyItem("s1"), spotifyItem("s2")],
      hasMore: false,
      cursor: null,
    });

    const result = await snapshotDestTracks(mockEnv, "spotify", "playlist-2", 5000);
    expect(result).toEqual({ ids: ["s1", "s2"], oversized: false });
  });

  it("stops early and reports oversized when the count exceeds the cap", async () => {
    mockGetPlaylistTracks
      .mockResolvedValueOnce({ trackIds: ["t1", "t2", "t3"], hasMore: true, cursor: "c1" })
      .mockResolvedValueOnce({ trackIds: ["t4"], hasMore: true, cursor: "c2" });

    const result = await snapshotDestTracks(mockEnv, "tidal", "playlist-1", 3);
    expect(result.oversized).toBe(true);
    // Stops fetching further pages once the cap is exceeded.
    expect(mockGetPlaylistTracks).toHaveBeenCalledTimes(2);
  });
});

describe("readDestTailIds", () => {
  it("reads a single page of Tidal destination ids", async () => {
    mockGetPlaylistTracks.mockResolvedValueOnce({ trackIds: ["t1", "t2"], hasMore: true, cursor: "c1" });
    const result = await readDestTailIds(mockEnv, "tidal", "playlist-1");
    expect(result).toEqual(new Set(["t1", "t2"]));
    expect(mockGetPlaylistTracks).toHaveBeenCalledOnce();
  });

  it("reads a single page of Spotify destination ids", async () => {
    mockGetSpotifyPlaylistItems.mockResolvedValueOnce({
      items: [spotifyItem("s1")],
      hasMore: false,
      cursor: null,
    });
    const result = await readDestTailIds(mockEnv, "spotify", "playlist-2");
    expect(result).toEqual(new Set(["s1"]));
    expect(mockGetSpotifyPlaylistItems).toHaveBeenCalledOnce();
  });
});
