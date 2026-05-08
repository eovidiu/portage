import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Env } from "../../../src/env";

vi.mock("../../../src/providers/spotify/oauth", () => ({
  spotifyFetch: vi.fn(),
}));

import { fetchSpotifyPlaylistName } from "../../../src/providers/spotify/playlists";
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

beforeEach(() => {
  mockSpotifyFetch.mockReset();
});

describe("T-016-08: fetchSpotifyPlaylistName returns the name", () => {
  it("issues GET /v1/playlists/{id}?fields=name and returns the name", async () => {
    mockSpotifyFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ name: "Workout" }), { status: 200 }),
    );
    const env = makeEnv();
    const result = await fetchSpotifyPlaylistName(env, "abc123");
    expect(result).toBe("Workout");
    expect(mockSpotifyFetch).toHaveBeenCalledTimes(1);
    const [, url] = mockSpotifyFetch.mock.calls[0] as [Env, string];
    expect(url).toBe("https://api.spotify.com/v1/playlists/abc123?fields=name");
  });
});

describe("T-016-09: fetchSpotifyPlaylistName propagates 404", () => {
  it("throws when Spotify returns 404", async () => {
    mockSpotifyFetch.mockResolvedValueOnce(
      new Response("not found", { status: 404 }),
    );
    const env = makeEnv();
    await expect(fetchSpotifyPlaylistName(env, "abc123")).rejects.toThrow(/404/);
  });

  it("throws when Spotify returns 500", async () => {
    mockSpotifyFetch.mockResolvedValueOnce(
      new Response("server error", { status: 500 }),
    );
    const env = makeEnv();
    await expect(fetchSpotifyPlaylistName(env, "abc123")).rejects.toThrow(/500/);
  });
});

describe("T-016-10: fetchSpotifyPlaylistName falls back on empty name", () => {
  it("returns 'Spotify Playlist {id}' when Spotify returns empty name", async () => {
    mockSpotifyFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ name: "" }), { status: 200 }),
    );
    const env = makeEnv();
    const result = await fetchSpotifyPlaylistName(env, "abc123");
    expect(result).toBe("Spotify Playlist abc123");
  });

  it("returns 'Spotify Playlist {id}' when Spotify omits the name field", async () => {
    mockSpotifyFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({}), { status: 200 }),
    );
    const env = makeEnv();
    const result = await fetchSpotifyPlaylistName(env, "xyz789");
    expect(result).toBe("Spotify Playlist xyz789");
  });
});
