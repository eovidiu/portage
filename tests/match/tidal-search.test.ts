// F-024 R3: shared Tidal catalog search helper.
// Verifies URL composition, 429-with-Retry-After single retry, and
// JSON:API → ResolvedTidalCandidate[] extraction. Fuzzy and the new manual
// route both depend on this contract.
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Env } from "../../src/env";

vi.mock("../../src/providers/tidal/client");
import { tidalFetch } from "../../src/providers/tidal/client";
const mockTidalFetch = vi.mocked(tidalFetch);

import { searchTidalCandidates } from "../../src/match/tidal-search";

const env = {} as Env;

beforeEach(() => {
  vi.resetAllMocks();
});

function jsonApiResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/vnd.api+json" },
    ...init,
  });
}

function happyBody() {
  return {
    // The live API returns `data` as an ARRAY holding one searchResults
    // resource. Verified 2026-08-31 against
    // GET openapi.tidal.com/v2/searchResults?filter[query]=…
    data: [
      {
        id: "7WWZpWooHF2uk21EqhRp2G6linyDUHByQuDklLmc909BTb",
        type: "searchResults",
        relationships: {
          tracks: {
            data: [
              { id: "track-1", type: "tracks" },
              { id: "track-2", type: "tracks" },
            ],
          },
        },
      },
    ],
    included: [
      {
        id: "track-1",
        type: "tracks",
        attributes: { title: "One", duration: "PT7M27S", isrc: "USEL18800020" },
        relationships: {
          artists: { data: [{ id: "artist-1", type: "artists" }] },
          albums: { data: [{ id: "album-1", type: "albums" }] },
        },
      },
      {
        id: "track-2",
        type: "tracks",
        attributes: { title: "One (Live)", duration: "PT8M14S", isrc: "USEL18800021" },
        relationships: {
          artists: { data: [{ id: "artist-1", type: "artists" }] },
          albums: { data: [{ id: "album-2", type: "albums" }] },
        },
      },
      { id: "artist-1", type: "artists", attributes: { name: "Metallica" } },
      { id: "album-1", type: "albums", attributes: { title: "...And Justice For All" } },
      { id: "album-2", type: "albums", attributes: { title: "Live S&M" } },
    ],
  };
}

describe("searchTidalCandidates — URL composition", () => {
  // Tidal removed GET /v2/searchResults/{query} on ~2026-08-11; the path form
  // now returns 400 INVALID_RESOURCE_ID for every query, including plain ASCII.
  // The query belongs in filter[query] on the collection.
  it("puts the query in filter[query] on the collection, with the compound include", async () => {
    mockTidalFetch.mockResolvedValueOnce(jsonApiResponse(happyBody()));
    await searchTidalCandidates(env, "Metallica One");
    expect(mockTidalFetch).toHaveBeenCalledOnce();
    const url = mockTidalFetch.mock.calls[0][1];
    expect(url).toBe(
      "https://openapi.tidal.com/v2/searchResults" +
        "?filter%5Bquery%5D=Metallica+One" +
        "&include=tracks%2Ctracks.artists%2Ctracks.albums",
    );
  });

  it("never puts the query in the path segment", async () => {
    mockTidalFetch.mockResolvedValueOnce(jsonApiResponse(happyBody()));
    await searchTidalCandidates(env, "Metallica One");
    const url = new URL(mockTidalFetch.mock.calls[0][1] as string);
    expect(url.pathname).toBe("/v2/searchResults");
  });

  it("encodes special chars in the query parameter", async () => {
    mockTidalFetch.mockResolvedValueOnce(jsonApiResponse(happyBody()));
    await searchTidalCandidates(env, "AC/DC Back in Black");
    const url = mockTidalFetch.mock.calls[0][1];
    expect(url).toContain("filter%5Bquery%5D=AC%2FDC+Back+in+Black");
  });
});

describe("searchTidalCandidates — 429 retry semantics", () => {
  it("retries once after a 429 with Retry-After, then returns the second response", async () => {
    mockTidalFetch
      .mockResolvedValueOnce(
        new Response("", { status: 429, headers: { "Retry-After": "0" } }),
      )
      .mockResolvedValueOnce(jsonApiResponse(happyBody()));

    const result = await searchTidalCandidates(env, "Metallica One");

    expect(mockTidalFetch).toHaveBeenCalledTimes(2);
    expect(result.retried).toBe(true);
    expect(result.status).toBe(200);
    expect(result.candidates).toHaveLength(2);
  });

  it("returns the 429 without sleeping or retrying when Retry-After exceeds the cap", async () => {
    mockTidalFetch.mockResolvedValueOnce(
      new Response("", { status: 429, headers: { "Retry-After": "3600" } }),
    );

    const result = await searchTidalCandidates(env, "Metallica One");

    expect(mockTidalFetch).toHaveBeenCalledOnce();
    expect(result.retried).toBe(false);
    expect(result.status).toBe(429);
    expect(result.candidates).toEqual([]);
  });

  it("returns 429 status when the retry also 429s (no third call)", async () => {
    mockTidalFetch
      .mockResolvedValueOnce(
        new Response("", { status: 429, headers: { "Retry-After": "0" } }),
      )
      .mockResolvedValueOnce(
        new Response("", { status: 429, headers: { "Retry-After": "0" } }),
      );

    const result = await searchTidalCandidates(env, "Metallica One");

    expect(mockTidalFetch).toHaveBeenCalledTimes(2);
    expect(result.retried).toBe(true);
    expect(result.status).toBe(429);
    expect(result.candidates).toEqual([]);
  });

  it("does not retry on non-429 status", async () => {
    mockTidalFetch.mockResolvedValueOnce(new Response("upstream down", { status: 503 }));
    const result = await searchTidalCandidates(env, "Metallica One");
    expect(mockTidalFetch).toHaveBeenCalledOnce();
    expect(result.retried).toBe(false);
    expect(result.status).toBe(503);
    expect(result.candidates).toEqual([]);
  });
});

describe("searchTidalCandidates — JSON:API resolution", () => {
  it("returns all resolved candidates with title/artist/album/duration/isrc filled", async () => {
    mockTidalFetch.mockResolvedValueOnce(jsonApiResponse(happyBody()));
    const result = await searchTidalCandidates(env, "Metallica One");
    expect(result.candidates).toEqual([
      {
        id: "track-1",
        title: "One",
        primaryArtist: "Metallica",
        artists: ["Metallica"],
        albumTitle: "...And Justice For All",
        durationMs: 7 * 60_000 + 27_000,
        isrc: "USEL18800020",
      },
      {
        id: "track-2",
        title: "One (Live)",
        primaryArtist: "Metallica",
        artists: ["Metallica"],
        albumTitle: "Live S&M",
        durationMs: 8 * 60_000 + 14_000,
        isrc: "USEL18800021",
      },
    ]);
  });

  it("resolves multiple artists in document order", async () => {
    const body = happyBody();
    body.included.push({
      id: "artist-2",
      type: "artists",
      attributes: { name: "Cliff Burton" },
    });
    body.included[0].relationships.artists.data = [
      { id: "artist-1", type: "artists" },
      { id: "artist-2", type: "artists" },
    ];
    mockTidalFetch.mockResolvedValueOnce(jsonApiResponse(body));
    const result = await searchTidalCandidates(env, "x");
    expect(result.candidates[0].artists).toEqual(["Metallica", "Cliff Burton"]);
    expect(result.candidates[0].primaryArtist).toBe("Metallica");
  });

  it("returns isrc null when the track attribute is missing", async () => {
    const body = happyBody();
    delete (body.included[0].attributes as Record<string, unknown>).isrc;
    mockTidalFetch.mockResolvedValueOnce(jsonApiResponse(body));
    const result = await searchTidalCandidates(env, "x");
    expect(result.candidates[0].isrc).toBeNull();
  });

  it("emits a candidate with empty artists when the included artist is missing", async () => {
    const body = happyBody();
    body.included = body.included.filter((r) => r.type !== "artists");
    mockTidalFetch.mockResolvedValueOnce(jsonApiResponse(body));
    const result = await searchTidalCandidates(env, "x");
    expect(result.candidates[0].primaryArtist).toBe("");
    expect(result.candidates[0].artists).toEqual([]);
  });

  it("emits a candidate with empty album when the included album is missing", async () => {
    const body = happyBody();
    body.included = body.included.filter((r) => r.type !== "albums");
    mockTidalFetch.mockResolvedValueOnce(jsonApiResponse(body));
    const result = await searchTidalCandidates(env, "x");
    expect(result.candidates[0].albumTitle).toBe("");
  });

  it("emits durationMs null for unparseable duration", async () => {
    const body = happyBody();
    (body.included[0].attributes as Record<string, unknown>).duration = "";
    mockTidalFetch.mockResolvedValueOnce(jsonApiResponse(body));
    const result = await searchTidalCandidates(env, "x");
    expect(result.candidates[0].durationMs).toBeNull();
  });

  it("returns no candidates when relationships.tracks.data is empty", async () => {
    const body = happyBody();
    body.data[0].relationships.tracks.data = [];
    mockTidalFetch.mockResolvedValueOnce(jsonApiResponse(body));
    const result = await searchTidalCandidates(env, "x");
    expect(result.candidates).toEqual([]);
  });

  it("returns no candidates when the track refs cannot be resolved in included", async () => {
    const body = happyBody();
    body.included = body.included.filter((r) => r.type !== "tracks");
    mockTidalFetch.mockResolvedValueOnce(jsonApiResponse(body));
    const result = await searchTidalCandidates(env, "x");
    expect(result.candidates).toEqual([]);
  });

  it("skips non-track refs in the relationship data", async () => {
    const body = happyBody();
    body.data[0].relationships.tracks.data.unshift({ id: "other-1", type: "videos" });
    mockTidalFetch.mockResolvedValueOnce(jsonApiResponse(body));
    const result = await searchTidalCandidates(env, "x");
    expect(result.candidates).toHaveLength(2);
    expect(result.candidates.every((c) => c.id !== "other-1")).toBe(true);
  });

  // Defensive: the pre-2026-08-11 endpoint returned `data` as a bare object.
  // Accepting both shapes means a future Tidal change back cannot silently
  // zero out every search the way the array change would have.
  it("also resolves a bare-object data (older response shape)", async () => {
    const body = happyBody() as unknown as { data: unknown[] | unknown };
    body.data = (body.data as unknown[])[0];
    mockTidalFetch.mockResolvedValueOnce(jsonApiResponse(body));
    const result = await searchTidalCandidates(env, "x");
    expect(result.candidates).toHaveLength(2);
  });
});

describe("searchTidalCandidates — malformed input", () => {
  it("flags bodyParseError when 2xx body is not JSON", async () => {
    mockTidalFetch.mockResolvedValueOnce(
      new Response("not json", { status: 200, headers: { "content-type": "text/plain" } }),
    );
    const result = await searchTidalCandidates(env, "x");
    expect(result.candidates).toEqual([]);
    expect(result.status).toBe(200);
    expect(result.bodyParseError).toBe(true);
  });

  it("does not flag bodyParseError when 2xx body is valid JSON with no candidates", async () => {
    mockTidalFetch.mockResolvedValueOnce(jsonApiResponse({ data: { id: "x", type: "searchResults" } }));
    const result = await searchTidalCandidates(env, "x");
    expect(result.candidates).toEqual([]);
    expect(result.bodyParseError).toBe(false);
  });

  it("does not flag bodyParseError on non-2xx status (body intentionally skipped)", async () => {
    mockTidalFetch.mockResolvedValueOnce(new Response("garbage", { status: 503 }));
    const result = await searchTidalCandidates(env, "x");
    expect(result.bodyParseError).toBe(false);
    expect(result.status).toBe(503);
  });
});
