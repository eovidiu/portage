import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Env } from "../../../src/env";

vi.mock("../../../src/providers/spotify/oauth", () => ({
  spotifyFetch: vi.fn(),
}));

import { createPlaylist, addItems } from "../../../src/providers/spotify/playlist-write";
import { spotifyFetch } from "../../../src/providers/spotify/oauth";

const mockSpotifyFetch = vi.mocked(spotifyFetch);

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

function ok(body: unknown, status = 200): Response {
  return {
    ok: true,
    status,
    headers: new Headers(),
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

function statusResponse(status: number, retryAfter?: string): Response {
  const headers = new Headers();
  if (retryAfter) headers.set("Retry-After", retryAfter);
  return {
    ok: false,
    status,
    headers,
    json: () => Promise.resolve({}),
  } as unknown as Response;
}

beforeEach(() => {
  mockSpotifyFetch.mockReset();
});

// F-030 spotify-playlist-write spec: "Private playlist created"
describe("createPlaylist — POST /v1/me/playlists (F-030)", () => {
  it("sends { name, public: false } and returns the new playlist id", async () => {
    mockSpotifyFetch.mockResolvedValueOnce(ok({ id: "NEW_PLAYLIST", name: "Copied" }));

    const id = await createPlaylist(makeEnv(), "Copied");

    expect(id).toBe("NEW_PLAYLIST");
    expect(mockSpotifyFetch).toHaveBeenCalledOnce();
    const [, url, init] = mockSpotifyFetch.mock.calls[0] as [Env, string, RequestInit];
    expect(url).toBe("https://api.spotify.com/v1/me/playlists");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ name: "Copied", public: false });
  });

  it("never builds a /users/{id}/playlists path", async () => {
    mockSpotifyFetch.mockResolvedValueOnce(ok({ id: "X" }));
    await createPlaylist(makeEnv(), "Copied");
    const [, url] = mockSpotifyFetch.mock.calls[0] as [Env, string];
    expect(url).not.toContain("/users/");
  });

  it("throws on non-OK response", async () => {
    mockSpotifyFetch.mockResolvedValueOnce(statusResponse(500));
    await expect(createPlaylist(makeEnv(), "Copied")).rejects.toThrow(/500/);
  });
});

// F-030 spotify-playlist-write spec: "Batch appended" + "Rate-limited batch retried once"
describe("addItems — POST /v1/playlists/{id}/items (F-030)", () => {
  it("builds spotify:track: URIs and posts to the /items path", async () => {
    mockSpotifyFetch.mockResolvedValueOnce(ok({ snapshot_id: "SNAP1" }, 201));

    const result = await addItems(makeEnv(), "PLAYLIST1", ["t1", "t2", "t3"]);

    expect(result).toEqual({ added: 3, snapshotId: "SNAP1", rateLimited: false });
    expect(mockSpotifyFetch).toHaveBeenCalledOnce();
    const [, url, init] = mockSpotifyFetch.mock.calls[0] as [Env, string, RequestInit];
    expect(url).toBe("https://api.spotify.com/v1/playlists/PLAYLIST1/items");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({
      uris: ["spotify:track:t1", "spotify:track:t2", "spotify:track:t3"],
    });
  });

  it("never builds the deprecated /tracks path", async () => {
    mockSpotifyFetch.mockResolvedValueOnce(ok({ snapshot_id: "SNAP1" }, 201));
    await addItems(makeEnv(), "PLAYLIST1", ["t1"]);
    const [, url] = mockSpotifyFetch.mock.calls[0] as [Env, string];
    expect(url).not.toMatch(/\/tracks$/);
  });

  it("rejects batches larger than 50 URIs", async () => {
    const ids = Array.from({ length: 51 }, (_, i) => `t${i}`);
    await expect(addItems(makeEnv(), "PLAYLIST1", ids)).rejects.toThrow(/50/);
    expect(mockSpotifyFetch).not.toHaveBeenCalled();
  });

  it("reports rateLimited immediately when Retry-After exceeds the cap, without sleeping or retrying", async () => {
    mockSpotifyFetch.mockResolvedValueOnce(statusResponse(429, "3600"));

    const result = await addItems(makeEnv(), "PLAYLIST1", ["t1"]);

    expect(result).toEqual({ added: 0, snapshotId: null, rateLimited: true });
    expect(mockSpotifyFetch).toHaveBeenCalledOnce();
  });

  it("retries once on 429, honoring Retry-After, and succeeds", async () => {
    vi.useFakeTimers();
    try {
      mockSpotifyFetch
        .mockResolvedValueOnce(statusResponse(429, "1"))
        .mockResolvedValueOnce(ok({ snapshot_id: "SNAP2" }, 201));

      const p = addItems(makeEnv(), "PLAYLIST1", ["t1"]);
      await vi.advanceTimersByTimeAsync(1100);
      const result = await p;

      expect(mockSpotifyFetch).toHaveBeenCalledTimes(2);
      expect(result).toEqual({ added: 1, snapshotId: "SNAP2", rateLimited: false });
    } finally {
      vi.useRealTimers();
    }
  });

  it("defaults to a 1s retry delay when Retry-After is absent", async () => {
    vi.useFakeTimers();
    try {
      mockSpotifyFetch
        .mockResolvedValueOnce(statusResponse(429))
        .mockResolvedValueOnce(ok({ snapshot_id: "SNAP3" }, 201));

      const p = addItems(makeEnv(), "PLAYLIST1", ["t1"]);
      await vi.advanceTimersByTimeAsync(1100);
      const result = await p;

      expect(result).toEqual({ added: 1, snapshotId: "SNAP3", rateLimited: false });
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns rateLimited without throwing on a second consecutive 429", async () => {
    vi.useFakeTimers();
    try {
      mockSpotifyFetch
        .mockResolvedValueOnce(statusResponse(429, "1"))
        .mockResolvedValueOnce(statusResponse(429, "1"));

      const p = addItems(makeEnv(), "PLAYLIST1", ["t1"]);
      await vi.advanceTimersByTimeAsync(1100);
      const result = await p;

      expect(result).toEqual({ added: 0, snapshotId: null, rateLimited: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it("throws on a non-OK, non-429 response", async () => {
    mockSpotifyFetch.mockResolvedValueOnce(statusResponse(500));
    await expect(addItems(makeEnv(), "PLAYLIST1", ["t1"])).rejects.toThrow(/500/);
  });
});

describe("addItems — playlist id encoding", () => {
  it("percent-encodes the playlist id in the items URL", async () => {
    mockSpotifyFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ snapshot_id: "s1" }), { status: 201 }),
    );
    await addItems(makeEnv(), "p l/1", ["t1"]);
    const url = mockSpotifyFetch.mock.calls[0][1] as string;
    expect(url).toContain("/playlists/p%20l%2F1/items");
  });
});
