import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Env } from "../../../src/env";

vi.mock("../../../src/providers/tidal/client", () => ({
  tidalFetch: vi.fn(),
}));

import { getPlaylistItems, resolveTrackArtists } from "../../../src/providers/tidal/playlist-items";
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
//   - The items endpoint's `include` supports ONLY `items` (8107-8119) — there
//     is no `items.artists`, and live responses (verified 2026-07-21 against a
//     public playlist) return included[] track resources with NO `relationships`
//     key at all. Artist linkage MUST come from a separate /tracks batch.
//   - /tracks GET (11508): `filter[id]` is array(string) → repeated params;
//     `include=artists` returns relationships.artists.data on data[] plus full
//     Artists resources (Artists_Attributes.name, 18788-18820) in included[],
//     de-duplicated across tracks (live-verified 2026-07-21).
//   - Tracks_Attributes (21829-21903): isrc (required), title (required),
//     duration (required, ISO-8601, e.g. "PT2M58S").

describe("getPlaylistItems", () => {
  it("reads isrc/title/durationMs from included[] track resources", async () => {
    mockTidalFetch.mockResolvedValueOnce(
      ok({
        data: [{ id: "T1", type: "tracks" }],
        included: [
          {
            id: "T1",
            type: "tracks",
            attributes: { isrc: "QMJMT1701229", title: "Kill Jay Z", duration: "PT2M58S" },
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

  it("returns nulls for isrc/title/durationMs when the track is not in included[]", async () => {
    mockTidalFetch.mockResolvedValueOnce(ok({ data: [{ id: "T1", type: "tracks" }] }));

    const page = await getPlaylistItems(makeEnv(), "PL1");
    expect(page.items).toEqual([{ tidalId: "T1", isrc: null, title: null, durationMs: null }]);
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

describe("resolveTrackArtists", () => {
  it("maps track id -> primary artist name via relationships + included[]", async () => {
    mockTidalFetch.mockResolvedValueOnce(
      ok({
        data: [
          {
            id: "T1",
            type: "tracks",
            attributes: { isrc: "A", title: "One", duration: "PT1M" },
            relationships: { artists: { data: [{ id: "A1", type: "artists" }] } },
          },
          {
            id: "T2",
            type: "tracks",
            attributes: { isrc: "B", title: "Two", duration: "PT2M" },
            relationships: {
              artists: {
                data: [
                  { id: "A2", type: "artists" },
                  { id: "A1", type: "artists" },
                ],
              },
            },
          },
        ],
        included: [
          { id: "A1", type: "artists", attributes: { name: "JAY Z" } },
          { id: "A2", type: "artists", attributes: { name: "Beyoncé" } },
        ],
      }),
    );

    const names = await resolveTrackArtists(makeEnv(), ["T1", "T2"]);
    expect(names.get("T1")).toBe("JAY Z");
    expect(names.get("T2")).toBe("Beyoncé");
    expect(names.size).toBe(2);
  });

  it("resolves a shared artist that included[] de-duplicates across tracks", async () => {
    // Live-verified 2026-07-21: two tracks by the same artist return
    // included[] with a single artists resource.
    mockTidalFetch.mockResolvedValueOnce(
      ok({
        data: [
          { id: "T1", type: "tracks", relationships: { artists: { data: [{ id: "A1", type: "artists" }] } } },
          { id: "T2", type: "tracks", relationships: { artists: { data: [{ id: "A1", type: "artists" }] } } },
        ],
        included: [{ id: "A1", type: "artists", attributes: { name: "Queen" } }],
      }),
    );

    const names = await resolveTrackArtists(makeEnv(), ["T1", "T2"]);
    expect(names.get("T1")).toBe("Queen");
    expect(names.get("T2")).toBe("Queen");
  });

  it("sends repeated filter[id] query params and include=artists", async () => {
    mockTidalFetch.mockResolvedValueOnce(ok({ data: [] }));
    await resolveTrackArtists(makeEnv(), ["T1", "T2"]);
    const url: string = mockTidalFetch.mock.calls[0][1];
    expect(url).toContain("/tracks?");
    expect(url).toContain("filter[id]=T1");
    expect(url).toContain("filter[id]=T2");
    expect(url).toContain("include=artists");
  });

  it("de-duplicates track ids before batching", async () => {
    mockTidalFetch.mockResolvedValueOnce(ok({ data: [] }));
    await resolveTrackArtists(makeEnv(), ["T1", "T1", "T1"]);
    expect(mockTidalFetch).toHaveBeenCalledOnce();
    const url: string = mockTidalFetch.mock.calls[0][1];
    expect((url.match(/filter\[id\]=/g) ?? []).length).toBe(1);
  });

  it("returns an empty Map without a network call for an empty id list", async () => {
    const names = await resolveTrackArtists(makeEnv(), []);
    expect(names.size).toBe(0);
    expect(mockTidalFetch).not.toHaveBeenCalled();
  });

  it("skips tracks with no artists relationship and artists missing a name", async () => {
    mockTidalFetch.mockResolvedValueOnce(
      ok({
        data: [
          { id: "T1", type: "tracks" },
          { id: "T2", type: "tracks", relationships: { artists: { data: [] } } },
          { id: "T3", type: "tracks", relationships: { artists: { data: [{ id: "A1", type: "artists" }] } } },
          { id: "T4", type: "tracks", relationships: { artists: { data: [{ id: "A2", type: "artists" }] } } },
        ],
        included: [
          { id: "A1", type: "artists", attributes: {} },
          { id: "A2", type: "artists", attributes: { name: "Real Name" } },
        ],
      }),
    );
    const names = await resolveTrackArtists(makeEnv(), ["T1", "T2", "T3", "T4"]);
    expect(names.has("T1")).toBe(false);
    expect(names.has("T2")).toBe(false);
    expect(names.has("T3")).toBe(false);
    expect(names.get("T4")).toBe("Real Name");
  });

  it("throws on non-ok response", async () => {
    mockTidalFetch.mockResolvedValueOnce(statusResponse(500));
    await expect(resolveTrackArtists(makeEnv(), ["T1"])).rejects.toThrow("500");
  });

  it("returns an empty Map when data is absent from the response", async () => {
    mockTidalFetch.mockResolvedValueOnce(ok({}));
    const names = await resolveTrackArtists(makeEnv(), ["T1"]);
    expect(names.size).toBe(0);
  });

  it("batches ids across multiple requests when exceeding the batch size", async () => {
    const ids = Array.from({ length: 25 }, (_, i) => `T${i}`);
    mockTidalFetch.mockImplementation(async () => ok({ data: [] }));
    await resolveTrackArtists(makeEnv(), ids);
    expect(mockTidalFetch).toHaveBeenCalledTimes(2);
  });
});
