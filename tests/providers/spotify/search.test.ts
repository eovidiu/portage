import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Env } from "../../../src/env";

vi.mock("../../../src/providers/spotify/oauth", () => ({
  spotifyFetch: vi.fn(),
}));

import { searchByIsrc, searchByText } from "../../../src/providers/spotify/search";
import { spotifyFetch } from "../../../src/providers/spotify/oauth";
import { scoreCandidate, type SpotifyTrackInput } from "../../../src/match/score";

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

function ok(body: unknown): Response {
  return {
    ok: true,
    status: 200,
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

function searchItem(overrides: Record<string, unknown> = {}) {
  return {
    id: "sp1",
    name: "Song Title",
    artists: [{ name: "The Artist" }],
    album: { name: "The Album" },
    duration_ms: 200000,
    external_ids: { isrc: "USRC17607839" },
    ...overrides,
  };
}

beforeEach(() => {
  mockSpotifyFetch.mockReset();
});

// F-030 spotify-catalog-search spec: "ISRC hit with agreeing artist"
describe("searchByIsrc — GET /v1/search q=isrc: (F-030)", () => {
  const source: SpotifyTrackInput = {
    title: "Song Title",
    artist: "The Artist",
    album: "The Album",
    duration_ms: 200000,
  };

  it("uppercases the ISRC and builds the query with type=track&limit=10", async () => {
    mockSpotifyFetch.mockResolvedValueOnce(ok({ tracks: { items: [] } }));
    await searchByIsrc(makeEnv(), "usrc17607839", source);

    expect(mockSpotifyFetch).toHaveBeenCalledOnce();
    const [, url] = mockSpotifyFetch.mock.calls[0] as [Env, string];
    const parsed = new URL(url);
    expect(parsed.searchParams.get("q")).toBe("isrc:USRC17607839");
    expect(parsed.searchParams.get("type")).toBe("track");
    expect(parsed.searchParams.get("limit")).toBe("10");
  });

  it("accepts a candidate whose artist agrees and duration is in tolerance", async () => {
    mockSpotifyFetch.mockResolvedValueOnce(ok({ tracks: { items: [searchItem()] } }));

    const result = await searchByIsrc(makeEnv(), "USRC17607839", source);

    expect(result.status).toBe("matched");
    expect(result.confidence).toBe(0.95);
    expect(result.candidate?.id).toBe("sp1");
  });

  it("rejects when the only result's artist does not agree", async () => {
    mockSpotifyFetch.mockResolvedValueOnce(
      ok({ tracks: { items: [searchItem({ artists: [{ name: "Someone Else" }] })] } }),
    );

    const result = await searchByIsrc(makeEnv(), "USRC17607839", source);
    expect(result.status).toBe("no_match");
  });

  it("rejects when duration is outside the ±2000ms tolerance", async () => {
    mockSpotifyFetch.mockResolvedValueOnce(
      ok({ tracks: { items: [searchItem({ duration_ms: 205000 })] } }),
    );

    const result = await searchByIsrc(makeEnv(), "USRC17607839", source);
    expect(result.status).toBe("no_match");
  });

  it("accepts an agreeing candidate without a duration check when the source duration is unknown", async () => {
    mockSpotifyFetch.mockResolvedValueOnce(ok({ tracks: { items: [searchItem()] } }));

    const sourceNoDuration: SpotifyTrackInput = {
      title: "Song Title",
      artist: "The Artist",
      album: "The Album",
      duration_ms: null,
    };

    const result = await searchByIsrc(makeEnv(), "USRC17607839", sourceNoDuration);
    expect(result.status).toBe("matched");
  });

  it("returns no_match when the search has no results", async () => {
    mockSpotifyFetch.mockResolvedValueOnce(ok({ tracks: { items: [] } }));
    const result = await searchByIsrc(makeEnv(), "USRC17607839", source);
    expect(result.status).toBe("no_match");
  });

  it("retries once on 429 and succeeds", async () => {
    vi.useFakeTimers();
    try {
      mockSpotifyFetch
        .mockResolvedValueOnce(statusResponse(429, "1"))
        .mockResolvedValueOnce(ok({ tracks: { items: [searchItem()] } }));

      const p = searchByIsrc(makeEnv(), "USRC17607839", source);
      await vi.advanceTimersByTimeAsync(1100);
      const result = await p;

      expect(mockSpotifyFetch).toHaveBeenCalledTimes(2);
      expect(result.status).toBe("matched");
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns rate_limited (not a throw) on a second consecutive 429", async () => {
    vi.useFakeTimers();
    try {
      mockSpotifyFetch
        .mockResolvedValueOnce(statusResponse(429, "1"))
        .mockResolvedValueOnce(statusResponse(429, "1"));

      const p = searchByIsrc(makeEnv(), "USRC17607839", source);
      await vi.advanceTimersByTimeAsync(1100);
      const result = await p;

      expect(result.status).toBe("rate_limited");
    } finally {
      vi.useRealTimers();
    }
  });

  it("throws on a non-OK, non-429 response", async () => {
    mockSpotifyFetch.mockResolvedValueOnce(statusResponse(500));
    await expect(searchByIsrc(makeEnv(), "USRC17607839", source)).rejects.toThrow(/500/);
  });
});

// F-030 spotify-catalog-search spec: "Fuzzy text search"
describe("searchByText — GET /v1/search track:/artist: filters (F-030)", () => {
  it("builds the query from title + artist with limit=10", async () => {
    mockSpotifyFetch.mockResolvedValueOnce(ok({ tracks: { items: [] } }));
    await searchByText(makeEnv(), "Doxy", "Miles Davis");

    const [, url] = mockSpotifyFetch.mock.calls[0] as [Env, string];
    const parsed = new URL(url);
    expect(parsed.searchParams.get("q")).toBe("track:Doxy artist:Miles Davis");
    expect(parsed.searchParams.get("limit")).toBe("10");
  });

  it("maps results into the ResolvedTidalCandidate shape consumed by score.ts", async () => {
    mockSpotifyFetch.mockResolvedValueOnce(ok({ tracks: { items: [searchItem()] } }));

    const result = await searchByText(makeEnv(), "Song Title", "The Artist");

    expect(result.status).toBe("ok");
    expect(result.candidates).toEqual([
      {
        id: "sp1",
        title: "Song Title",
        primaryArtist: "The Artist",
        artists: ["The Artist"],
        albumTitle: "The Album",
        durationMs: 200000,
        isrc: "USRC17607839",
      },
    ]);
  });

  it("feeds a mapped candidate into match/score.ts's scoreCandidate without modifying src/match", async () => {
    mockSpotifyFetch.mockResolvedValueOnce(ok({ tracks: { items: [searchItem()] } }));

    const result = await searchByText(makeEnv(), "Song Title", "The Artist");
    const source: SpotifyTrackInput = {
      title: "Song Title",
      artist: "The Artist",
      album: "The Album",
      duration_ms: 200000,
    };

    const score = scoreCandidate(source, result.candidates[0]);
    expect(score.total).toBeGreaterThanOrEqual(0.95);
  });

  it("returns rate_limited with empty candidates on a second consecutive 429", async () => {
    vi.useFakeTimers();
    try {
      mockSpotifyFetch
        .mockResolvedValueOnce(statusResponse(429, "1"))
        .mockResolvedValueOnce(statusResponse(429, "1"));

      const p = searchByText(makeEnv(), "Song Title", "The Artist");
      await vi.advanceTimersByTimeAsync(1100);
      const result = await p;

      expect(result.status).toBe("rate_limited");
      expect(result.candidates).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("throws on a non-OK, non-429 response", async () => {
    mockSpotifyFetch.mockResolvedValueOnce(statusResponse(500));
    await expect(searchByText(makeEnv(), "Song Title", "The Artist")).rejects.toThrow(/500/);
  });

  it("defaults to a 1s retry delay when Retry-After is absent, then succeeds", async () => {
    vi.useFakeTimers();
    try {
      mockSpotifyFetch
        .mockResolvedValueOnce(statusResponse(429))
        .mockResolvedValueOnce(ok({ tracks: { items: [searchItem()] } }));

      const p = searchByText(makeEnv(), "Song Title", "The Artist");
      await vi.advanceTimersByTimeAsync(1100);
      const result = await p;

      expect(result.status).toBe("ok");
      expect(result.candidates).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("throws when the 429 retry itself returns a non-OK response", async () => {
    vi.useFakeTimers();
    try {
      mockSpotifyFetch
        .mockResolvedValueOnce(statusResponse(429, "1"))
        .mockResolvedValueOnce(statusResponse(500));

      const p = searchByText(makeEnv(), "Song Title", "The Artist");
      await vi.advanceTimersByTimeAsync(1100);
      await expect(p).rejects.toThrow(/500/);
    } finally {
      vi.useRealTimers();
    }
  });

  it("treats a missing tracks field (after retry) as zero candidates", async () => {
    vi.useFakeTimers();
    try {
      mockSpotifyFetch
        .mockResolvedValueOnce(statusResponse(429, "1"))
        .mockResolvedValueOnce(ok({}));

      const p = searchByText(makeEnv(), "Song Title", "The Artist");
      await vi.advanceTimersByTimeAsync(1100);
      const result = await p;

      expect(result).toEqual({ status: "ok", candidates: [] });
    } finally {
      vi.useRealTimers();
    }
  });

  it("treats a missing tracks field as zero candidates (first try, no retry)", async () => {
    mockSpotifyFetch.mockResolvedValueOnce(ok({}));
    const result = await searchByText(makeEnv(), "Song Title", "The Artist");
    expect(result).toEqual({ status: "ok", candidates: [] });
  });

  it("maps an item with no artists, album, duration, or isrc to safe defaults", async () => {
    mockSpotifyFetch.mockResolvedValueOnce(
      ok({
        tracks: {
          items: [{ id: "sp-bare", name: "Bare Track", artists: [] }],
        },
      }),
    );

    const result = await searchByText(makeEnv(), "Bare Track", "");
    expect(result.candidates).toEqual([
      {
        id: "sp-bare",
        title: "Bare Track",
        primaryArtist: "",
        artists: [],
        albumTitle: "",
        durationMs: null,
        isrc: null,
      },
    ]);
  });
});
