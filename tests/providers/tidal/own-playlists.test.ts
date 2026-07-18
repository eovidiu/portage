import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Env } from "../../../src/env";

vi.mock("../../../src/providers/tidal/client", () => ({
  tidalFetch: vi.fn(),
}));

import { listOwnPlaylists } from "../../../src/providers/tidal/own-playlists";
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

// Tidal OAS grounding (openapi-types.ts):
//   - GET /playlists (7532-7589): filter[owners.id] = "me" for the
//     authenticated user's own playlists; page[cursor] pagination.
//   - Playlists_Multi_Resource_Data_Document (20631-20635): data[] is full
//     Playlists_Resource_Object entries — name/numberOfItems come back
//     directly, no per-playlist follow-up request.
//   - Playlists_Attributes (20558-20602): numberOfItems is OPTIONAL (can be
//     absent on unbounded playlists).

describe("listOwnPlaylists", () => {
  it("requests filter[owners.id]=me", async () => {
    mockTidalFetch.mockResolvedValueOnce(ok({ data: [] }));
    await listOwnPlaylists(makeEnv());
    const url: string = mockTidalFetch.mock.calls[0][1];
    expect(url).toContain("filter[owners.id]=me");
  });

  it("maps id/name/numberOfItems from data[] attributes", async () => {
    mockTidalFetch.mockResolvedValueOnce(
      ok({
        data: [
          { id: "PL1", attributes: { name: "Liked from Tidal", numberOfItems: 42 } },
          { id: "PL2", attributes: { name: "Road Trip", numberOfItems: 10 } },
        ],
      }),
    );
    const page = await listOwnPlaylists(makeEnv());
    expect(page.playlists).toEqual([
      { id: "PL1", name: "Liked from Tidal", numberOfItems: 42 },
      { id: "PL2", name: "Road Trip", numberOfItems: 10 },
    ]);
  });

  it("defaults numberOfItems to null when the OAS omits it (unbounded playlist)", async () => {
    mockTidalFetch.mockResolvedValueOnce(
      ok({ data: [{ id: "PL1", attributes: { name: "Mix" } }] }),
    );
    const page = await listOwnPlaylists(makeEnv());
    expect(page.playlists[0].numberOfItems).toBeNull();
  });

  it("reads the next-page cursor from links.meta.nextCursor", async () => {
    mockTidalFetch.mockResolvedValueOnce(
      ok({
        data: [],
        links: { next: "https://openapi.tidal.com/v2/playlists?page[cursor]=abc", meta: { nextCursor: "abc" } },
      }),
    );
    const page = await listOwnPlaylists(makeEnv());
    expect(page.hasMore).toBe(true);
    expect(page.cursor).toBe("abc");
  });

  it("hasMore=false and cursor=null on the last page", async () => {
    mockTidalFetch.mockResolvedValueOnce(ok({ data: [] }));
    const page = await listOwnPlaylists(makeEnv());
    expect(page.hasMore).toBe(false);
    expect(page.cursor).toBeNull();
  });

  it("passes page[cursor] as a query param on subsequent pages", async () => {
    mockTidalFetch.mockResolvedValueOnce(ok({ data: [] }));
    await listOwnPlaylists(makeEnv(), "cursor_xyz");
    const url: string = mockTidalFetch.mock.calls[0][1];
    expect(url).toContain("page[cursor]=cursor_xyz");
  });

  it("throws on non-ok response", async () => {
    mockTidalFetch.mockResolvedValueOnce(statusResponse(500));
    await expect(listOwnPlaylists(makeEnv())).rejects.toThrow("500");
  });

  it("returns an empty playlists array when data is absent from the response", async () => {
    mockTidalFetch.mockResolvedValueOnce(ok({}));
    const page = await listOwnPlaylists(makeEnv());
    expect(page.playlists).toEqual([]);
  });

  it("defaults name to empty string when attributes.name is absent", async () => {
    mockTidalFetch.mockResolvedValueOnce(ok({ data: [{ id: "PL1", attributes: {} }] }));
    const page = await listOwnPlaylists(makeEnv());
    expect(page.playlists[0].name).toBe("");
  });
});
