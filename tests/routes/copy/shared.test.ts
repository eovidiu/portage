import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Env } from "../../../src/env";

vi.mock("../../../src/providers/tidal/own-playlists", () => ({ listOwnPlaylists: vi.fn() }));
vi.mock("../../../src/providers/spotify/playlists", () => ({
  listOwnPlaylists: vi.fn(),
  fetchSpotifyPlaylistName: vi.fn(),
}));
vi.mock("../../../src/providers/tidal/playlist", () => ({ getPlaylist: vi.fn() }));

import { findOwnPlaylist, resolveSourceName } from "../../../src/routes/copy/shared";
import { listOwnPlaylists as listTidalOwnPlaylists } from "../../../src/providers/tidal/own-playlists";
import {
  listOwnPlaylists as listSpotifyOwnPlaylists,
  fetchSpotifyPlaylistName,
} from "../../../src/providers/spotify/playlists";
import { getPlaylist } from "../../../src/providers/tidal/playlist";

const mockListTidalOwnPlaylists = vi.mocked(listTidalOwnPlaylists);
const mockListSpotifyOwnPlaylists = vi.mocked(listSpotifyOwnPlaylists);
const mockFetchSpotifyPlaylistName = vi.mocked(fetchSpotifyPlaylistName);
const mockGetPlaylist = vi.mocked(getPlaylist);

const mockEnv = { DATABASE_URL: "postgresql://test" } as Env;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("findOwnPlaylist", () => {
  it("returns true when the Tidal playlist id appears on the first page", async () => {
    mockListTidalOwnPlaylists.mockResolvedValueOnce({
      playlists: [{ id: "p1", name: "P1", numberOfItems: 3 }],
      hasMore: false,
      cursor: null,
    });
    const result = await findOwnPlaylist(mockEnv, "tidal", "p1");
    expect(result).toBe(true);
  });

  it("paginates Spotify's own playlists until found", async () => {
    mockListSpotifyOwnPlaylists
      .mockResolvedValueOnce({ playlists: [{ id: "other", name: "O", trackCount: 1 }], nextOffset: 50 })
      .mockResolvedValueOnce({ playlists: [{ id: "target", name: "T", trackCount: 2 }], nextOffset: null });

    const result = await findOwnPlaylist(mockEnv, "spotify", "target");
    expect(result).toBe(true);
    expect(mockListSpotifyOwnPlaylists).toHaveBeenCalledTimes(2);
  });

  it("returns false when the id never appears across all pages", async () => {
    mockListTidalOwnPlaylists.mockResolvedValueOnce({
      playlists: [{ id: "p1", name: "P1", numberOfItems: 3 }],
      hasMore: false,
      cursor: null,
    });
    const result = await findOwnPlaylist(mockEnv, "tidal", "missing");
    expect(result).toBe(false);
  });
});

describe("resolveSourceName", () => {
  it("resolves a Tidal playlist's name", async () => {
    mockGetPlaylist.mockResolvedValueOnce({ id: "p1", name: "My Tidal Playlist" });
    const name = await resolveSourceName(mockEnv, "tidal", "p1");
    expect(name).toBe("My Tidal Playlist");
  });

  it("returns null when the Tidal playlist does not exist", async () => {
    mockGetPlaylist.mockResolvedValueOnce(null);
    const name = await resolveSourceName(mockEnv, "tidal", "missing");
    expect(name).toBeNull();
  });

  it("resolves a Spotify playlist's name", async () => {
    mockFetchSpotifyPlaylistName.mockResolvedValueOnce("My Spotify Playlist");
    const name = await resolveSourceName(mockEnv, "spotify", "sp1");
    expect(name).toBe("My Spotify Playlist");
  });

  it("returns null when the Spotify lookup throws (not found/unreachable)", async () => {
    mockFetchSpotifyPlaylistName.mockRejectedValueOnce(new Error("404"));
    const name = await resolveSourceName(mockEnv, "spotify", "missing");
    expect(name).toBeNull();
  });
});
