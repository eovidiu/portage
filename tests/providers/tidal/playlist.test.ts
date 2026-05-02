import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Env } from "../../../src/env";

vi.mock("../../../src/db/provider_tokens", () => ({
  persistTokens: vi.fn(),
  loadTokens: vi.fn(),
  markRevoked: vi.fn(),
}));

vi.mock("../../../src/db/oauth_state", () => ({
  storeOAuthState: vi.fn(),
  consumeOAuthState: vi.fn(),
  purgeExpiredOAuthState: vi.fn(),
}));

vi.mock("../../../src/providers/tidal/client", () => ({
  tidalFetch: vi.fn(),
}));

import {
  createPlaylist,
  getPlaylist,
  getPlaylistTracks,
  getAllPlaylistTrackIds,
  addTracksToPlaylist,
} from "../../../src/providers/tidal/playlist";
import { BATCH_SIZE } from "../../../src/providers/tidal/playlist-endpoints";
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

// Tidal Open API v2 grounding for these tests:
//   - Create payload: PlaylistsCreateOperation_Payload_Data_Attributes
//     required: ["name"]; allowed: accessType (PUBLIC|UNLISTED), createdAt,
//     description, name. NO `privacy` attribute, NO `title` attribute.
//   - Read attributes: Playlists_Attributes uses `name` (not `title`).
//   - Add-tracks: PlaylistsItemsRelationshipAddOperation_Payload requires
//     data (maxItems: 20) AND meta.positionBefore (string, required).
//   - GET items: documented query params are page[cursor], countryCode,
//     include — NOT `limit`.

describe("createPlaylist", () => {
  it("sends JSON:API POST body with attributes.name + accessType=UNLISTED", async () => {
    const env = makeEnv();
    mockTidalFetch.mockResolvedValueOnce(
      ok({ data: { id: "PLAYLIST_X", attributes: { name: "Spotify Liked" } } }),
    );

    const id = await createPlaylist(env, "Spotify Liked");

    expect(id).toBe("PLAYLIST_X");
    expect(mockTidalFetch).toHaveBeenCalledOnce();
    const call = mockTidalFetch.mock.calls[0];
    expect(call[1]).toContain("/playlists");
    expect(call[2].method).toBe("POST");
    const body = JSON.parse(call[2].body as string);
    expect(body.data.type).toBe("playlists");
    expect(body.data.attributes.name).toBe("Spotify Liked");
    expect(body.data.attributes.accessType).toBe("UNLISTED");
    expect(body.data.attributes).not.toHaveProperty("title");
    expect(body.data.attributes).not.toHaveProperty("privacy");
    expect(body.data.attributes.description).toContain("spotify-roon-sync");
    expect(body.data.attributes.description).toContain("Do not edit manually");
  });

  it("throws if create returns non-2xx", async () => {
    mockTidalFetch.mockResolvedValueOnce(statusResponse(500));
    await expect(createPlaylist(makeEnv(), "Spotify Liked")).rejects.toThrow("500");
  });
});

describe("getPlaylist", () => {
  it("parses attributes.name from response", async () => {
    mockTidalFetch.mockResolvedValueOnce(
      ok({ data: { id: "PL1", attributes: { name: "Spotify Liked" } } }),
    );
    const result = await getPlaylist(makeEnv(), "PL1");
    expect(result).toEqual({ id: "PL1", name: "Spotify Liked" });
  });

  it("returns null on 404", async () => {
    mockTidalFetch.mockResolvedValueOnce(statusResponse(404));
    const result = await getPlaylist(makeEnv(), "GONE");
    expect(result).toBeNull();
  });

  it("returns null on 403", async () => {
    mockTidalFetch.mockResolvedValueOnce(statusResponse(403));
    const result = await getPlaylist(makeEnv(), "PRIVATE");
    expect(result).toBeNull();
  });

  it("throws on 500", async () => {
    mockTidalFetch.mockResolvedValueOnce(statusResponse(500));
    await expect(getPlaylist(makeEnv(), "PL1")).rejects.toThrow("500");
  });
});

describe("getPlaylistTracks", () => {
  it("returns track ids from included field", async () => {
    mockTidalFetch.mockResolvedValueOnce(
      ok({
        included: [{ id: "T1" }, { id: "T2" }],
        meta: { cursor: null },
      }),
    );
    const page = await getPlaylistTracks(makeEnv(), "PL1");
    expect(page.trackIds).toEqual(["T1", "T2"]);
    expect(page.hasMore).toBe(false);
    expect(page.cursor).toBeNull();
  });

  it("falls back to data field", async () => {
    mockTidalFetch.mockResolvedValueOnce(
      ok({ data: [{ id: "T3" }], meta: {} }),
    );
    const page = await getPlaylistTracks(makeEnv(), "PL1");
    expect(page.trackIds).toEqual(["T3"]);
  });

  it("returns empty trackIds when neither included nor data present", async () => {
    mockTidalFetch.mockResolvedValueOnce(ok({ meta: {} }));
    const page = await getPlaylistTracks(makeEnv(), "PL1");
    expect(page.trackIds).toHaveLength(0);
  });

  it("hasMore=true when cursor is present", async () => {
    mockTidalFetch.mockResolvedValueOnce(
      ok({
        included: [{ id: "T1" }],
        meta: { cursor: "abc123" },
      }),
    );
    const page = await getPlaylistTracks(makeEnv(), "PL1");
    expect(page.hasMore).toBe(true);
    expect(page.cursor).toBe("abc123");
  });

  it("passes cursor as query param on subsequent page", async () => {
    mockTidalFetch.mockResolvedValueOnce(ok({ included: [], meta: {} }));
    await getPlaylistTracks(makeEnv(), "PL1", "cursor_abc");
    const url: string = mockTidalFetch.mock.calls[0][1];
    expect(url).toContain("cursor_abc");
  });
});

describe("getAllPlaylistTrackIds", () => {
  it("aggregates all pages into a Set", async () => {
    mockTidalFetch
      .mockResolvedValueOnce(ok({ included: [{ id: "T1" }, { id: "T2" }], meta: { cursor: "next" } }))
      .mockResolvedValueOnce(ok({ included: [{ id: "T3" }], meta: {} }));

    const ids = await getAllPlaylistTrackIds(makeEnv(), "PL1");
    expect(ids).toEqual(new Set(["T1", "T2", "T3"]));
    expect(mockTidalFetch).toHaveBeenCalledTimes(2);
  });

  it("returns empty set for empty playlist", async () => {
    mockTidalFetch.mockResolvedValueOnce(ok({ included: [], meta: {} }));
    const ids = await getAllPlaylistTrackIds(makeEnv(), "PL1");
    expect(ids.size).toBe(0);
  });
});

describe("addTracksToPlaylist — 429 handling (F-008-R8)", () => {
  it("retries once on 429 and returns added count", async () => {
    const retryHeaders = { "Retry-After": "0" };
    mockTidalFetch
      .mockResolvedValueOnce(new Response("{}", { status: 429, headers: retryHeaders }))
      .mockResolvedValueOnce(ok({}));

    const result = await addTracksToPlaylist(makeEnv(), "PL1", ["T1"]);
    expect(result.added).toBe(1);
    expect(mockTidalFetch).toHaveBeenCalledTimes(2);
  });

  it("uses default 1s retry-after when header is absent", async () => {
    // No Retry-After header → defaults to 1 (uses ?? "1" branch)
    mockTidalFetch
      .mockResolvedValueOnce(new Response("{}", { status: 429 }))
      .mockResolvedValueOnce(ok({}));

    const result = await addTracksToPlaylist(makeEnv(), "PL1", ["T1"]);
    expect(result.added).toBe(1);
  });

  it("aborts batch on second 429 and counts remaining as errors", async () => {
    const retryHeaders = { "Retry-After": "0" };
    // 2 batches of BATCH_SIZE each; first 429, retry 429 → abort
    const manyIds = Array.from({ length: BATCH_SIZE + 1 }, (_, i) => `T${i}`);
    mockTidalFetch
      .mockResolvedValueOnce(new Response("{}", { status: 429, headers: retryHeaders }))
      .mockResolvedValueOnce(new Response("{}", { status: 429, headers: retryHeaders }));

    const result = await addTracksToPlaylist(makeEnv(), "PL1", manyIds);
    expect(result.aborted ?? result.errors).toBeGreaterThan(0);
    expect(result.added).toBe(0);
  });

  it("partial last batch: 429 abort does not underflow error count (m8)", async () => {
    // BATCH_SIZE+5 ids: batch 1 (BATCH_SIZE) succeeds, batch 2 (5) gets two 429s → abort.
    // Without Math.max(0, ...), errors would be: 5 + (total - BATCH_SIZE - BATCH_SIZE)
    // i.e. 5 + (BATCH_SIZE+5 - 2*BATCH_SIZE) = 5 - BATCH_SIZE, which is negative when BATCH_SIZE > 5.
    const retryHeaders = { "Retry-After": "0" };
    const ids = Array.from({ length: BATCH_SIZE + 5 }, (_, i) => `T${i}`);
    mockTidalFetch
      .mockResolvedValueOnce(ok({}))   // batch 1 (BATCH_SIZE items) → success
      .mockResolvedValueOnce(new Response("{}", { status: 429, headers: retryHeaders })) // batch 2 first try
      .mockResolvedValueOnce(new Response("{}", { status: 429, headers: retryHeaders })); // batch 2 retry → abort

    const result = await addTracksToPlaylist(makeEnv(), "PL1", ids);
    expect(result.added).toBe(BATCH_SIZE);
    expect(result.errors).toBe(5); // the 5-item last batch, NOT negative
    expect(result.errors).toBeGreaterThanOrEqual(0);
  });
});

describe("addTracksToPlaylist — invalid track id handling", () => {
  it("extracts invalid ids from 400 error response with pointer", async () => {
    const errBody = {
      errors: [
        { source: { pointer: "/data/0/id" }, detail: "track unavailable" },
      ],
    };
    mockTidalFetch.mockResolvedValueOnce(
      new Response(JSON.stringify(errBody), { status: 400 }),
    );

    const result = await addTracksToPlaylist(makeEnv(), "PL1", ["BAD_ID", "GOOD_ID"]);
    expect(result.invalidIds).toContain("BAD_ID");
  });

  it("extracts invalid ids from 400 error response with id field", async () => {
    const errBody = {
      errors: [{ id: "BAD_ID", detail: "track unavailable" }],
    };
    mockTidalFetch.mockResolvedValueOnce(
      new Response(JSON.stringify(errBody), { status: 400 }),
    );

    const result = await addTracksToPlaylist(makeEnv(), "PL1", ["BAD_ID", "GOOD_ID"]);
    expect(result.invalidIds).toContain("BAD_ID");
  });

  it("treats 400 with unparseable body as errors", async () => {
    mockTidalFetch.mockResolvedValueOnce(
      new Response("not-json", { status: 400 }),
    );
    const result = await addTracksToPlaylist(makeEnv(), "PL1", ["T1"]);
    expect(result.errors).toBe(1);
    expect(result.invalidIds).toHaveLength(0);
  });

  it("treats 400 with no extractable invalid ids as errors", async () => {
    // 400 but errors array is empty → fallthrough to errors path
    mockTidalFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ errors: [] }), { status: 400 }),
    );
    const result = await addTracksToPlaylist(makeEnv(), "PL1", ["T1"]);
    expect(result.errors).toBe(1);
    expect(result.invalidIds).toHaveLength(0);
  });

  it("treats 422 with invalid pointer as errors (covers status === 422 branch)", async () => {
    const errBody = {
      errors: [{ source: { pointer: "/data/0/id" }, detail: "unavailable" }],
    };
    mockTidalFetch.mockResolvedValueOnce(
      new Response(JSON.stringify(errBody), { status: 422 }),
    );
    const result = await addTracksToPlaylist(makeEnv(), "PL1", ["T1"]);
    expect(result.invalidIds).toContain("T1");
  });

  it("returns added count on success", async () => {
    mockTidalFetch.mockResolvedValueOnce(ok({}));
    const result = await addTracksToPlaylist(makeEnv(), "PL1", ["T1", "T2"]);
    expect(result.added).toBe(2);
    expect(result.invalidIds).toHaveLength(0);
    expect(result.errors).toBe(0);
  });
});

describe("addTracksToPlaylist — request body shape (OAS-grounded)", () => {
  it("BATCH_SIZE matches Tidal OAS PlaylistsItemsRelationshipAddOperation maxItems (20)", () => {
    expect(BATCH_SIZE).toBeLessThanOrEqual(20);
    expect(BATCH_SIZE).toBeGreaterThan(0);
  });

  it("body omits meta entirely (append-at-end semantic; 2026-05-02 prod fix)", async () => {
    mockTidalFetch.mockResolvedValueOnce(ok({}));
    await addTracksToPlaylist(makeEnv(), "PL1", ["T1", "T2"]);
    const call = mockTidalFetch.mock.calls[0];
    const body = JSON.parse(call[2].body as string);
    expect(body.meta).toBeUndefined();
  });

  it("data items have type='tracks' and id (Resource_Identifier shape)", async () => {
    mockTidalFetch.mockResolvedValueOnce(ok({}));
    await addTracksToPlaylist(makeEnv(), "PL1", ["TRACK_A", "TRACK_B"]);
    const call = mockTidalFetch.mock.calls[0];
    const body = JSON.parse(call[2].body as string);
    expect(body.data).toEqual([
      { type: "tracks", id: "TRACK_A" },
      { type: "tracks", id: "TRACK_B" },
    ]);
  });

  it("respects BATCH_SIZE limit (splits a >BATCH_SIZE list into multiple POSTs)", async () => {
    // Construct exactly BATCH_SIZE+1 ids → expect 2 POST calls
    const ids = Array.from({ length: BATCH_SIZE + 1 }, (_, i) => `T${i}`);
    mockTidalFetch.mockResolvedValue(ok({}));

    await addTracksToPlaylist(makeEnv(), "PL1", ids);

    expect(mockTidalFetch).toHaveBeenCalledTimes(2);
    const firstBody = JSON.parse(mockTidalFetch.mock.calls[0][2].body as string);
    const secondBody = JSON.parse(mockTidalFetch.mock.calls[1][2].body as string);
    expect(firstBody.data).toHaveLength(BATCH_SIZE);
    expect(secondBody.data).toHaveLength(1);
  });
});

describe("getPlaylistTracks — URL shape (OAS-grounded)", () => {
  it("does NOT pass an undocumented `limit` query parameter", async () => {
    mockTidalFetch.mockResolvedValueOnce(ok({ included: [], meta: {} }));
    await getPlaylistTracks(makeEnv(), "PL1");
    const url: string = mockTidalFetch.mock.calls[0][1];
    expect(url).not.toMatch(/[?&]limit=/);
  });

  it("uses page[cursor] for pagination (the documented query param)", async () => {
    mockTidalFetch.mockResolvedValueOnce(ok({ included: [], meta: {} }));
    await getPlaylistTracks(makeEnv(), "PL1", "cursor_xyz");
    const url: string = mockTidalFetch.mock.calls[0][1];
    expect(url).toContain("page[cursor]=cursor_xyz");
  });
});

describe("getPlaylistTracks — error handling", () => {
  it("throws on non-ok response", async () => {
    mockTidalFetch.mockResolvedValueOnce(statusResponse(500));
    await expect(getPlaylistTracks(makeEnv(), "PL1")).rejects.toThrow("500");
  });
});

describe("addTracksToPlaylist — _extractInvalidIds edge cases", () => {
  it("handles 400 with null body (non-object) gracefully", async () => {
    mockTidalFetch.mockResolvedValueOnce(
      new Response(JSON.stringify(null), { status: 400 }),
    );
    const result = await addTracksToPlaylist(makeEnv(), "PL1", ["T1"]);
    expect(result.errors).toBe(1);
  });

  it("handles 400 with non-array errors field gracefully", async () => {
    mockTidalFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ errors: "not an array" }), { status: 400 }),
    );
    const result = await addTracksToPlaylist(makeEnv(), "PL1", ["T1"]);
    expect(result.errors).toBe(1);
  });

  it("handles 400 where pointer doesn't match /data/N pattern", async () => {
    const errBody = {
      errors: [{ source: { pointer: "/unknown/path" }, detail: "bad" }],
    };
    mockTidalFetch.mockResolvedValueOnce(
      new Response(JSON.stringify(errBody), { status: 400 }),
    );
    // No pointer match, no id field → no invalid ids extracted → errors path
    const result = await addTracksToPlaylist(makeEnv(), "PL1", ["T1"]);
    expect(result.errors).toBe(1);
    expect(result.invalidIds).toHaveLength(0);
  });

  it("handles 400 where err items are null or non-objects", async () => {
    const errBody = { errors: [null, "string-error", 42] };
    mockTidalFetch.mockResolvedValueOnce(
      new Response(JSON.stringify(errBody), { status: 400 }),
    );
    const result = await addTracksToPlaylist(makeEnv(), "PL1", ["T1"]);
    expect(result.errors).toBe(1);
  });

  it("handles 400 where pointer is non-string", async () => {
    const errBody = {
      errors: [{ source: { pointer: 42 } }],
    };
    mockTidalFetch.mockResolvedValueOnce(
      new Response(JSON.stringify(errBody), { status: 400 }),
    );
    const result = await addTracksToPlaylist(makeEnv(), "PL1", ["T1"]);
    expect(result.errors).toBe(1);
  });

  it("handles 400 where pointer index is out of batch range", async () => {
    const errBody = {
      errors: [{ source: { pointer: "/data/99/id" } }],
    };
    mockTidalFetch.mockResolvedValueOnce(
      new Response(JSON.stringify(errBody), { status: 400 }),
    );
    // index 99 is out of range for a 1-element batch
    const result = await addTracksToPlaylist(makeEnv(), "PL1", ["T1"]);
    expect(result.errors).toBe(1);
    expect(result.invalidIds).toHaveLength(0);
  });
});
