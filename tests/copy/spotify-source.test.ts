import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Env } from "../../src/env";

vi.mock("../../src/providers/spotify/oauth", () => ({ spotifyFetch: vi.fn() }));

import { getSpotifyPlaylistItems } from "../../src/copy/spotify-source";
import { spotifyFetch } from "../../src/providers/spotify/oauth";

const mockSpotifyFetch = vi.mocked(spotifyFetch);
const mockEnv = { DATABASE_URL: "postgresql://test" } as Env;

beforeEach(() => {
  vi.clearAllMocks();
});

function trackItem(overrides: Record<string, unknown> = {}) {
  return {
    track: {
      id: "sp1",
      name: "Song",
      artists: [{ name: "Artist" }],
      album: { name: "Album" },
      duration_ms: 200000,
      external_ids: { isrc: "USABC1234567" },
      type: "track",
      is_local: false,
      ...overrides,
    },
  };
}

describe("getSpotifyPlaylistItems", () => {
  it("maps a page of items to the generic source-item shape", async () => {
    mockSpotifyFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ items: [trackItem()], next: null }),
    } as Response);

    const page = await getSpotifyPlaylistItems(mockEnv, "playlist-1", null);

    expect(page.items).toEqual([
      {
        id: "sp1",
        isrc: "USABC1234567",
        title: "Song",
        artist: "Artist",
        album: "Album",
        duration_ms: 200000,
      },
    ]);
    expect(page.hasMore).toBe(false);
    expect(page.cursor).toBeNull();
  });

  it("uses the given cursor URL directly instead of the default page URL", async () => {
    mockSpotifyFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ items: [], next: null }),
    } as Response);

    await getSpotifyPlaylistItems(mockEnv, "playlist-1", "https://api.spotify.com/next-page");

    expect(mockSpotifyFetch).toHaveBeenCalledWith(mockEnv, "https://api.spotify.com/next-page");
  });

  it("reports hasMore + cursor when Spotify returns a next URL", async () => {
    mockSpotifyFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ items: [trackItem()], next: "https://api.spotify.com/next" }),
    } as Response);

    const page = await getSpotifyPlaylistItems(mockEnv, "playlist-1", null);
    expect(page.hasMore).toBe(true);
    expect(page.cursor).toBe("https://api.spotify.com/next");
  });

  it("skips local tracks, non-track items, and null tracks", async () => {
    mockSpotifyFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        items: [
          trackItem({ is_local: true }),
          { track: { ...trackItem().track, type: "episode" } },
          { track: null },
          trackItem({ id: "sp2" }),
        ],
        next: null,
      }),
    } as Response);

    const page = await getSpotifyPlaylistItems(mockEnv, "playlist-1", null);
    expect(page.items).toHaveLength(1);
    expect(page.items[0].id).toBe("sp2");
  });

  it("defaults missing isrc/album/artist to null", async () => {
    mockSpotifyFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        items: [{ track: { id: "sp3", name: "T", artists: [], type: "track", is_local: false } }],
        next: null,
      }),
    } as Response);

    const page = await getSpotifyPlaylistItems(mockEnv, "playlist-1", null);
    expect(page.items[0]).toEqual({
      id: "sp3",
      isrc: null,
      title: "T",
      artist: null,
      album: null,
      duration_ms: null,
    });
  });

  it("retries once on 429 honoring Retry-After", async () => {
    vi.useFakeTimers();
    mockSpotifyFetch
      .mockResolvedValueOnce({ ok: false, status: 429, headers: new Headers({ "Retry-After": "0" }) } as Response)
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ items: [], next: null }) } as Response);

    const promise = getSpotifyPlaylistItems(mockEnv, "playlist-1", null);
    await vi.runAllTimersAsync();
    const page = await promise;

    expect(mockSpotifyFetch).toHaveBeenCalledTimes(2);
    expect(page.items).toEqual([]);
    vi.useRealTimers();
  });

  it("throws when the response is a non-ok, non-429 status", async () => {
    mockSpotifyFetch.mockResolvedValueOnce({ ok: false, status: 500 } as Response);
    await expect(getSpotifyPlaylistItems(mockEnv, "playlist-1", null)).rejects.toThrow(/500/);
  });

  it("throws when a second consecutive 429 is received", async () => {
    vi.useFakeTimers();
    mockSpotifyFetch.mockResolvedValue({
      ok: false,
      status: 429,
      headers: new Headers({ "Retry-After": "0" }),
    } as Response);

    const promise = getSpotifyPlaylistItems(mockEnv, "playlist-1", null);
    const assertion = expect(promise).rejects.toThrow(/rate limit/i);
    await vi.runAllTimersAsync();
    await assertion;
    vi.useRealTimers();
  });
});

describe("getSpotifyPlaylistItems — playlist id encoding", () => {
  it("percent-encodes the playlist id in the first-page URL", async () => {
    mockSpotifyFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ items: [], next: null }), { status: 200 }),
    );
    await getSpotifyPlaylistItems(mockEnv, "p l/1", null);
    const url = mockSpotifyFetch.mock.calls[0][1] as string;
    expect(url).toContain("/playlists/p%20l%2F1/tracks");
  });
});
