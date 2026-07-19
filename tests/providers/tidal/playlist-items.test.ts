import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Env } from "../../../src/env";

vi.mock("../../../src/providers/tidal/client", () => ({
  tidalFetch: vi.fn(),
}));

import { getPlaylistItems, resolveArtistNames } from "../../../src/providers/tidal/playlist-items";
import { tidalFetch } from "../../../src/providers/tidal/client";

const mockTidalFetch = tidalFetch as ReturnType<typeof vi.fn>;

function makeEnv(): Env {
  return {
    DATABASE_URL: "postgresql://test",
    JWT_SECRET: "test-secret",
    TOKEN_ENCRYPTION_KEY: btoa(String.fromCharCode(...new Array(32).fill(0x42))),
    SPOTIFY_CLIENT_ID: "",
    SPOTIFY_CLIENT_SECRET: "",
    SPOTIFY_REDIRECT_URI: "",
    TIDAL_CLIENT_ID: "",
    TIDAL_CLIENT_SECRET: "",
    TIDAL_REDIRECT_URI: "",
    TIDAL_COUNTRY_CODE: "RO",
    TIDAL_PLAYLIST_TITLE: "Spotify Liked",
  };
}

function ok(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

function statusResponse(status: number): Response {
  return new Response("{}", { status });
}

beforeEach(() => {
  vi.clearAllMocks();
});

// Tidal OAS grounding for these tests (openapi-types.ts):
//   - Playlists_Items_Multi_Relationship_Data_Document (8093-8149, 20603-20625):
//     data[] is bare resource identifiers { id, type }; included[] carries the
//     full Tracks_Resource_Object when `include=items` is set.
//   - Tracks_Attributes (21829-21903): isrc (required), title (required),
//     duration (required, ISO-8601, e.g. "PT2M58S").
//   - Tracks_Relationships.artists (21916) is a Multi_Relationship_Data_Document
//     — artist resource identifiers only, no names.
//   - Artists_Attributes.name (18788-18820ish): artist display name; GET
//     /artists?filter[id]= (2428) returns Artists_Multi_Resource_Data_Document
//     (18888-18892) with full attributes in data[].

describe("getPlaylistItems", () => {
  it("reads isrc/title/durationMs/artistIds from included[] track resources", async () => {
    mockTidalFetch.mockResolvedValueOnce(
      ok({
        data: [{ id: "T1", type: "tracks" }],
        included: [
          {
            id: "T1",
            type: "tracks",
            attributes: { isrc: "QMJMT1701229", title: "Kill Jay Z", duration: "PT2M58S" },
            relationships: { artists: { data: [{ id: "A1", type: "artists" }] } },
          },
        ],
      }),
    );

    const page = await getPlaylistItems(makeEnv(), "PL1");

    expect(page.items).toEqual([
      {
        tidalId: "T1",
        isrc: "QMJMT1701229",
        title: "Kill Jay Z",
        durationMs: 178000,
        artistIds: ["A1"],
      },
    ]);
    expect(page.hasMore).toBe(false);
    expect(page.cursor).toBeNull();
  });

  it("preserves source ordering from data[] even when included[] is unordered", async () => {
    mockTidalFetch.mockResolvedValueOnce(
      ok({
        data: [
          { id: "T2", type: "tracks" },
          { id: "T1", type: "tracks" },
        ],
        included: [
          { id: "T1", type: "tracks", attributes: { isrc: "A", title: "First", duration: "PT1M" } },
          { id: "T2", type: "tracks", attributes: { isrc: "B", title: "Second", duration: "PT2M" } },
        ],
      }),
    );

    const page = await getPlaylistItems(makeEnv(), "PL1");
    expect(page.items.map((i) => i.tidalId)).toEqual(["T2", "T1"]);
    expect(page.items[0].title).toBe("Second");
    expect(page.items[1].title).toBe("First");
  });

  it("handles multiple artist ids on a track", async () => {
    mockTidalFetch.mockResolvedValueOnce(
      ok({
        data: [{ id: "T1", type: "tracks" }],
        included: [
          {
            id: "T1",
            type: "tracks",
            attributes: { isrc: "A", title: "Feat.", duration: "PT3M" },
            relationships: {
              artists: {
                data: [
                  { id: "A1", type: "artists" },
                  { id: "A2", type: "artists" },
                ],
              },
            },
          },
        ],
      }),
    );

    const page = await getPlaylistItems(makeEnv(), "PL1");
    expect(page.items[0].artistIds).toEqual(["A1", "A2"]);
  });

  it("returns nulls for isrc/title/durationMs and empty artistIds when the track is not in included[]", async () => {
    mockTidalFetch.mockResolvedValueOnce(ok({ data: [{ id: "T1", type: "tracks" }] }));

    const page = await getPlaylistItems(makeEnv(), "PL1");
    expect(page.items).toEqual([
      { tidalId: "T1", isrc: null, title: null, durationMs: null, artistIds: [] },
    ]);
  });

  it("returns empty items array when data is absent", async () => {
    mockTidalFetch.mockResolvedValueOnce(ok({}));
    const page = await getPlaylistItems(makeEnv(), "PL1");
    expect(page.items).toEqual([]);
  });

  it("reads the next-page cursor from links.meta.nextCursor", async () => {
    mockTidalFetch.mockResolvedValueOnce(
      ok({
        data: [{ id: "T1", type: "tracks" }],
        links: { next: "https://openapi.tidal.com/v2/playlists/PL1/relationships/items?page[cursor]=abc", meta: { nextCursor: "abc" } },
      }),
    );
    const page = await getPlaylistItems(makeEnv(), "PL1");
    expect(page.hasMore).toBe(true);
    expect(page.cursor).toBe("abc");
  });

  it("passes cursor as a page[cursor] query param and requests include=items", async () => {
    mockTidalFetch.mockResolvedValueOnce(ok({ data: [] }));
    await getPlaylistItems(makeEnv(), "PL1", "cursor_xyz");
    const url: string = mockTidalFetch.mock.calls[0][1];
    expect(url).toContain("include=items");
    expect(url).toContain("page[cursor]=cursor_xyz");
  });

  it("throws on non-ok response", async () => {
    mockTidalFetch.mockResolvedValueOnce(statusResponse(500));
    await expect(getPlaylistItems(makeEnv(), "PL1")).rejects.toThrow("500");
  });
});

describe("resolveArtistNames", () => {
  it("returns a Map of artistId -> name from a single batch", async () => {
    mockTidalFetch.mockResolvedValueOnce(
      ok({
        data: [
          { id: "A1", attributes: { name: "JAY Z" } },
          { id: "A2", attributes: { name: "Beyoncé" } },
        ],
      }),
    );

    const names = await resolveArtistNames(makeEnv(), ["A1", "A2"]);
    expect(names.get("A1")).toBe("JAY Z");
    expect(names.get("A2")).toBe("Beyoncé");
    expect(names.size).toBe(2);
  });

  it("sends repeated filter[id] query params (OpenAPI default array style)", async () => {
    mockTidalFetch.mockResolvedValueOnce(ok({ data: [] }));
    await resolveArtistNames(makeEnv(), ["A1", "A2"]);
    const url: string = mockTidalFetch.mock.calls[0][1];
    expect(url).toContain("filter[id]=A1");
    expect(url).toContain("filter[id]=A2");
  });

  it("de-duplicates artist ids before batching", async () => {
    mockTidalFetch.mockResolvedValueOnce(ok({ data: [{ id: "A1", attributes: { name: "JAY Z" } } ] }));
    await resolveArtistNames(makeEnv(), ["A1", "A1", "A1"]);
    expect(mockTidalFetch).toHaveBeenCalledOnce();
    const url: string = mockTidalFetch.mock.calls[0][1];
    expect((url.match(/filter\[id\]=/g) ?? []).length).toBe(1);
  });

  it("returns an empty Map without a network call for an empty id list", async () => {
    const names = await resolveArtistNames(makeEnv(), []);
    expect(names.size).toBe(0);
    expect(mockTidalFetch).not.toHaveBeenCalled();
  });

  it("skips artists missing a name attribute", async () => {
    mockTidalFetch.mockResolvedValueOnce(
      ok({ data: [{ id: "A1", attributes: {} }, { id: "A2", attributes: { name: "Real Name" } }] }),
    );
    const names = await resolveArtistNames(makeEnv(), ["A1", "A2"]);
    expect(names.has("A1")).toBe(false);
    expect(names.get("A2")).toBe("Real Name");
  });

  it("throws on non-ok response", async () => {
    mockTidalFetch.mockResolvedValueOnce(statusResponse(500));
    await expect(resolveArtistNames(makeEnv(), ["A1"])).rejects.toThrow("500");
  });

  it("returns an empty Map when data is absent from the response", async () => {
    mockTidalFetch.mockResolvedValueOnce(ok({}));
    const names = await resolveArtistNames(makeEnv(), ["A1"]);
    expect(names.size).toBe(0);
  });

  it("batches ids across multiple requests when exceeding the batch size", async () => {
    const ids = Array.from({ length: 55 }, (_, i) => `A${i}`);
    mockTidalFetch.mockImplementation(async () => ok({ data: [] }));
    await resolveArtistNames(makeEnv(), ids);
    expect(mockTidalFetch).toHaveBeenCalledTimes(2);
  });
});
