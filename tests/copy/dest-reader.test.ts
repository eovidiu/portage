import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Env } from "../../src/env";

vi.mock("../../src/providers/tidal/playlist", () => ({ getPlaylistTracks: vi.fn() }));
vi.mock("../../src/copy/spotify-source", () => ({ getSpotifyPlaylistItems: vi.fn() }));
vi.mock("../../src/providers/tidal/client", () => ({ tidalFetch: vi.fn() }));
vi.mock("../../src/providers/spotify/oauth", () => ({ spotifyFetch: vi.fn() }));

import { snapshotDestTracks, readDestItemCount } from "../../src/copy/dest-reader";
import { getPlaylistTracks } from "../../src/providers/tidal/playlist";
import { getSpotifyPlaylistItems } from "../../src/copy/spotify-source";
import { tidalFetch } from "../../src/providers/tidal/client";
import { spotifyFetch } from "../../src/providers/spotify/oauth";

const mockGetPlaylistTracks = vi.mocked(getPlaylistTracks);
const mockGetSpotifyPlaylistItems = vi.mocked(getSpotifyPlaylistItems);
const mockTidalFetch = vi.mocked(tidalFetch);
const mockSpotifyFetch = vi.mocked(spotifyFetch);
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

describe("readDestItemCount (B1 count-based crash reconcile)", () => {
  it("reads attributes.numberOfItems from GET /v2/playlists/{id} for Tidal", async () => {
    mockTidalFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ data: { id: "playlist-1", attributes: { numberOfItems: 42 } } }),
    } as Response);

    const result = await readDestItemCount(mockEnv, "tidal", "playlist-1");
    expect(result).toBe(42);
    expect(mockTidalFetch).toHaveBeenCalledWith(mockEnv, expect.stringContaining("playlist-1"));
  });

  it("treats a missing numberOfItems as 0", async () => {
    mockTidalFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ data: { id: "playlist-1", attributes: {} } }),
    } as Response);
    const result = await readDestItemCount(mockEnv, "tidal", "playlist-1");
    expect(result).toBe(0);
  });

  it("throws with the HTTP status on a non-ok Tidal response", async () => {
    mockTidalFetch.mockResolvedValueOnce({ ok: false, status: 404 } as Response);
    await expect(readDestItemCount(mockEnv, "tidal", "playlist-1")).rejects.toThrow("404");
  });

  it("reads tracks.total from GET /v1/playlists/{id}?fields=tracks.total for Spotify", async () => {
    mockSpotifyFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ tracks: { total: 7 } }),
    } as Response);

    const result = await readDestItemCount(mockEnv, "spotify", "playlist-2");
    expect(result).toBe(7);
    expect(mockSpotifyFetch).toHaveBeenCalledWith(
      mockEnv,
      expect.stringContaining("fields=tracks.total"),
    );
  });

  it("throws with the HTTP status on a non-ok Spotify response", async () => {
    mockSpotifyFetch.mockResolvedValueOnce({ ok: false, status: 403 } as Response);
    await expect(readDestItemCount(mockEnv, "spotify", "playlist-2")).rejects.toThrow("403");
  });
});
