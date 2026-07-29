import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Env } from "../../../src/env";

// DB mock infrastructure — mirrors tests/providers/spotify/liked.test.ts.
// The transaction mock takes a sync callback returning an array of un-awaited
// queries, calls each through mockTxSql, and resolves them in order.
const mockQuery = vi.fn();
const txQueryResults: unknown[][] = [];
const mockTxSql = vi.fn().mockImplementation(() => {
  const result = txQueryResults.shift() ?? [];
  return Promise.resolve(result);
});
const mockTransaction = vi.fn().mockImplementation(
  (fn: (sql: typeof mockTxSql) => unknown[]) => {
    const queries = fn(mockTxSql);
    return Promise.all(queries as Promise<unknown[]>[]);
  },
);

vi.mock("@neondatabase/serverless", () => ({
  neon: () => {
    const fn = mockQuery;
    (fn as unknown as Record<string, unknown>).transaction = mockTransaction;
    return fn;
  },
}));

vi.mock("../../../src/providers/spotify/oauth", () => ({
  spotifyFetch: vi.fn(),
}));

import {
  fetchSpotifyPlaylistName,
  fetchPlaylistTracks,
  listOwnPlaylists,
} from "../../../src/providers/spotify/playlists";
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
  mockQuery.mockReset();
  mockTxSql.mockClear();
  mockTransaction.mockClear();
  txQueryResults.length = 0;
});

// Helpers from liked.test.ts — duplicated here to keep test files independent.
function makeTrack(id: string, addedAt: string, overrides: Record<string, unknown> = {}) {
  return {
    added_at: addedAt,
    track: {
      id,
      name: `Track ${id}`,
      artists: [{ name: `Artist ${id}` }],
      album: { name: `Album ${id}` },
      duration_ms: 180000,
      external_ids: { isrc: `ISRC${id}` },
      type: "track",
      is_local: false,
      ...overrides,
    },
  };
}

function makePage(items: object[], next: string | null = null) {
  return { items, next };
}

function makeOkResponse(body: object): Response {
  return {
    ok: true,
    status: 200,
    headers: new Headers(),
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

function make429Response(retryAfter = "1"): Response {
  return {
    ok: false,
    status: 429,
    headers: new Headers({ "Retry-After": retryAfter }),
    json: () => Promise.resolve({}),
  } as unknown as Response;
}

// =============================================================================
// fetchSpotifyPlaylistName (existing tests preserved verbatim)
// =============================================================================

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
    await expect(fetchSpotifyPlaylistName(makeEnv(), "abc123")).rejects.toThrow(/404/);
  });

  it("throws when Spotify returns 500", async () => {
    mockSpotifyFetch.mockResolvedValueOnce(
      new Response("server error", { status: 500 }),
    );
    await expect(fetchSpotifyPlaylistName(makeEnv(), "abc123")).rejects.toThrow(/500/);
  });
});

describe("T-016-10: fetchSpotifyPlaylistName falls back on empty name", () => {
  it("returns 'Spotify Playlist {id}' when Spotify returns empty name", async () => {
    mockSpotifyFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ name: "" }), { status: 200 }),
    );
    expect(await fetchSpotifyPlaylistName(makeEnv(), "abc123")).toBe("Spotify Playlist abc123");
  });

  it("returns 'Spotify Playlist {id}' when Spotify omits the name field", async () => {
    mockSpotifyFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({}), { status: 200 }),
    );
    expect(await fetchSpotifyPlaylistName(makeEnv(), "xyz789")).toBe("Spotify Playlist xyz789");
  });
});

// =============================================================================
// fetchPlaylistTracks
// =============================================================================

describe("T-017-09: fetchPlaylistTracks cold start fetches and persists", () => {
  it("fetches /v1/playlists/{id}/tracks?limit=50 and persists tracks + membership", async () => {
    // sync_state cold-start reads: cursor (no row), resume_url (no row), sweep_max (no row)
    mockQuery
      .mockResolvedValueOnce([]) // readCursor → cold start
      .mockResolvedValueOnce([]) // readState resume_url
      .mockResolvedValueOnce([]); // readState sweep_max

    mockSpotifyFetch.mockResolvedValueOnce(
      makeOkResponse(
        makePage(
          [
            makeTrack("t1", "2026-05-09T10:00:00Z"),
            makeTrack("t2", "2026-05-09T09:00:00Z"),
            makeTrack("t3", "2026-05-09T08:00:00Z"),
          ],
          null,
        ),
      ),
    );

    // 3 tracks upsert + 3 membership upsert + 3 sync_state writes = 9 queries in tx
    txQueryResults.push(
      [{ spotify_id: "t1" }],
      [{ spotify_id: "t2" }],
      [{ spotify_id: "t3" }],
      [], // membership t1
      [], // membership t2
      [], // membership t3
      [], // cursor write
      [], // resume_url write
      [], // sweep_max write
    );

    const result = await fetchPlaylistTracks(makeEnv(), "abc123", 1);

    expect(result.pagesProcessed).toBe(1);
    expect(result.tracksInserted).toBe(3);
    expect(result.morePagesPending).toBe(false);

    const [, url] = mockSpotifyFetch.mock.calls[0] as [Env, string];
    expect(url).toBe("https://api.spotify.com/v1/playlists/abc123/tracks?limit=50");
  });
});

describe("T-017-11: fetchPlaylistTracks atomicity — single transaction holds tracks + membership + sync_state", () => {
  it("transaction's array contains 2 tracks + 2 membership + 3 sync_state writes", async () => {
    mockQuery
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    mockSpotifyFetch.mockResolvedValueOnce(
      makeOkResponse(
        makePage(
          [
            makeTrack("t1", "2026-05-09T10:00:00Z"),
            makeTrack("t2", "2026-05-09T09:00:00Z"),
          ],
          null,
        ),
      ),
    );

    txQueryResults.push(
      [{ spotify_id: "t1" }],
      [{ spotify_id: "t2" }],
      [],
      [],
      [],
      [],
      [],
    );

    await fetchPlaylistTracks(makeEnv(), "abc123", 1);

    expect(mockTransaction).toHaveBeenCalledTimes(1);
    // The mockTxSql function is called for each query the transaction emits;
    // verify the count matches the expected 2 + 2 + 3 = 7
    expect(mockTxSql).toHaveBeenCalledTimes(7);

    // Verify the mix by inspecting SQL strings of each call
    const sqls = mockTxSql.mock.calls.map((c) => (c[0] as string).toLowerCase());
    const trackUpserts = sqls.filter((s) => s.includes("insert into tracks"));
    const membershipUpserts = sqls.filter((s) =>
      s.includes("insert into playlist_membership"),
    );
    const syncStateWrites = sqls.filter((s) => s.includes("insert into sync_state"));
    expect(trackUpserts).toHaveLength(2);
    expect(membershipUpserts).toHaveLength(2);
    expect(syncStateWrites).toHaveLength(3);
  });
});

describe("T-017-12: voluntary mid-sweep stop persists resume_url + sweep_max + does not advance cursor", () => {
  it("when maxPages=1 and page.next is set, persists resume URL and freezes cursor", async () => {
    // Cold start
    mockQuery
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    mockSpotifyFetch.mockResolvedValueOnce(
      makeOkResponse(
        makePage(
          [makeTrack("t1", "2026-05-09T10:00:00Z")],
          "https://api.spotify.com/v1/playlists/abc123/tracks?offset=50&limit=50",
        ),
      ),
    );

    txQueryResults.push([{ spotify_id: "t1" }], [], [], [], []);

    const result = await fetchPlaylistTracks(makeEnv(), "abc123", 1);

    expect(result.morePagesPending).toBe(true);

    // Inspect the sync_state writes — find by key in params
    const calls = mockTxSql.mock.calls;
    const syncStateCalls = calls.filter((c) =>
      (c[0] as string).toLowerCase().includes("insert into sync_state"),
    );
    const writes = syncStateCalls.map((c) => {
      const params = c[1] as unknown[];
      return { key: params[0] as string, value: params[1] as string };
    });
    const cursorWrite = writes.find((w) => w.key === "playlist:abc123:cursor");
    const resumeWrite = writes.find((w) => w.key === "playlist:abc123:resume_url");
    const sweepMaxWrite = writes.find((w) => w.key === "playlist:abc123:sweep_max");

    // Cursor frozen at cold start (1970)
    expect(cursorWrite?.value).toBe("1970-01-01T00:00:00Z");
    // Resume URL set to page.next
    expect(resumeWrite?.value).toBe(
      "https://api.spotify.com/v1/playlists/abc123/tracks?offset=50&limit=50",
    );
    // Sweep max set to runMax (the one track we processed). toISOString() emits .000Z.
    expect(sweepMaxWrite?.value).toBe("2026-05-09T10:00:00.000Z");
  });
});

describe("T-017-13: resumes from resume_url when set", () => {
  it("uses persisted resume_url instead of the default URL", async () => {
    mockQuery
      .mockResolvedValueOnce([{ value: "2026-04-01T00:00:00Z" }]) // cursor exists
      .mockResolvedValueOnce([{ value: "https://api.spotify.com/v1/playlists/abc123/tracks?offset=50&limit=50" }]) // resume_url
      .mockResolvedValueOnce([]); // sweep_max empty

    mockSpotifyFetch.mockResolvedValueOnce(
      makeOkResponse(makePage([], null)),
    );

    txQueryResults.push([], [], []);

    await fetchPlaylistTracks(makeEnv(), "abc123", 1);

    expect(mockSpotifyFetch).toHaveBeenCalledTimes(1);
    const [, url] = mockSpotifyFetch.mock.calls[0] as [Env, string];
    expect(url).toBe("https://api.spotify.com/v1/playlists/abc123/tracks?offset=50&limit=50");
  });
});

describe("T-017-14: skips null tracks, is_local, non-track items", () => {
  it("excludes skipped items from tracks and membership writes", async () => {
    mockQuery
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    mockSpotifyFetch.mockResolvedValueOnce(
      makeOkResponse(
        makePage(
          [
            makeTrack("t1", "2026-05-09T10:00:00Z"),
            makeTrack("t2", "2026-05-09T09:00:00Z"),
            { added_at: "2026-05-09T08:00:00Z", track: null }, // null track
            makeTrack("t-local", "2026-05-09T07:00:00Z", { is_local: true }),
            makeTrack("t-episode", "2026-05-09T06:00:00Z", { type: "episode" }),
          ],
          null,
        ),
      ),
    );

    // 2 tracks + 2 membership + 3 sync_state = 7 queries
    txQueryResults.push(
      [{ spotify_id: "t1" }],
      [{ spotify_id: "t2" }],
      [],
      [],
      [],
      [],
      [],
    );

    const result = await fetchPlaylistTracks(makeEnv(), "abc123", 1);
    expect(result.tracksInserted).toBe(2);
    expect(result.tracksSkipped).toBe(3);

    const trackUpserts = mockTxSql.mock.calls.filter((c) =>
      (c[0] as string).toLowerCase().includes("insert into tracks"),
    );
    const membershipUpserts = mockTxSql.mock.calls.filter((c) =>
      (c[0] as string).toLowerCase().includes("insert into playlist_membership"),
    );
    expect(trackUpserts).toHaveLength(2);
    expect(membershipUpserts).toHaveLength(2);
  });
});

describe("T-017-15: 429 retry honours Retry-After", () => {
  it("waits and retries once on 429", async () => {
    vi.useFakeTimers();
    try {
      mockQuery
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);

      mockSpotifyFetch
        .mockResolvedValueOnce(make429Response("1"))
        .mockResolvedValueOnce(makeOkResponse(makePage([], null)));

      txQueryResults.push([], [], []);

      const fetchPromise = fetchPlaylistTracks(makeEnv(), "abc123", 1);
      // advance fake timer to release the Retry-After sleep
      await vi.advanceTimersByTimeAsync(1100);
      await fetchPromise;

      expect(mockSpotifyFetch).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("T-017-16: aborts on second 429", () => {
  it("throws when Spotify returns 429 twice in a row", async () => {
    vi.useFakeTimers();
    try {
      mockQuery
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);

      mockSpotifyFetch
        .mockResolvedValueOnce(make429Response("1"))
        .mockResolvedValueOnce(make429Response("1"));

      const fetchPromise = fetchPlaylistTracks(makeEnv(), "abc123", 1);
      await vi.advanceTimersByTimeAsync(1100);
      await expect(fetchPromise).rejects.toThrow(/rate limit|429/i);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("T-017-10: cursor cutoff stops pagination early", () => {
  it("when a track's added_at <= cursor - 60s is seen, halts within the page", async () => {
    mockQuery
      .mockResolvedValueOnce([{ value: "2026-05-09T12:00:00Z" }]) // cursor
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    mockSpotifyFetch.mockResolvedValueOnce(
      makeOkResponse(
        makePage(
          [
            makeTrack("t-new", "2026-05-09T13:00:00Z"),
            makeTrack("t-old", "2026-05-09T08:00:00Z"), // before cutoff
            makeTrack("t-newer", "2026-05-09T14:00:00Z"), // unreachable
          ],
          "next-page-url",
        ),
      ),
    );

    // 1 track upsert + 1 membership upsert + 3 sync_state writes
    txQueryResults.push([{ spotify_id: "t-new" }], [], [], [], []);

    const result = await fetchPlaylistTracks(makeEnv(), "abc123", 5);

    expect(result.tracksInserted).toBe(1);
    expect(result.morePagesPending).toBe(false); // cutoff = sweep complete

    // Pagination halted within the page; only one Spotify call
    expect(mockSpotifyFetch).toHaveBeenCalledTimes(1);
  });
});

describe("F-017 multi-page: non-last-page persistence in one batched transaction", () => {
  it("persists each non-last page's tracks + memberships in ONE transaction; final page atomic with sync_state", async () => {
    mockQuery
      .mockResolvedValueOnce([]) // cursor cold start
      .mockResolvedValueOnce([]) // resume_url empty
      .mockResolvedValueOnce([]); // sweep_max empty

    // Page 0 (non-last): 1 track upsert + 1 membership upsert in one transaction
    txQueryResults.push([{ spotify_id: "t1" }], []);

    mockSpotifyFetch
      .mockResolvedValueOnce(
        makeOkResponse(
          makePage(
            [makeTrack("t1", "2026-05-09T11:00:00Z")],
            "https://api.spotify.com/v1/playlists/abc123/tracks?offset=50&limit=50",
          ),
        ),
      )
      .mockResolvedValueOnce(
        makeOkResponse(
          makePage(
            [makeTrack("t2", "2026-05-09T10:00:00Z")],
            null,
          ),
        ),
      );

    // Page 1 (last): 1 track + 1 membership + 3 sync_state in transaction
    txQueryResults.push([{ spotify_id: "t2" }], [], [], [], []);

    const result = await fetchPlaylistTracks(makeEnv(), "abc123", 2);

    expect(result.pagesProcessed).toBe(2);
    expect(result.tracksInserted).toBe(2);
    expect(result.morePagesPending).toBe(false);

    // Two Spotify calls (page 0 and page 1)
    expect(mockSpotifyFetch).toHaveBeenCalledTimes(2);
  });
});

// =============================================================================
// listOwnPlaylists (F-030 task 1.6)
// =============================================================================

describe("listOwnPlaylists — GET /v1/me/playlists (F-030)", () => {
  it("issues GET /v1/me/playlists?limit=50&offset=0 by default", async () => {
    mockSpotifyFetch.mockResolvedValueOnce(
      makeOkResponse({
        items: [],
        next: null,
        offset: 0,
        limit: 50,
        total: 0,
      }),
    );

    await listOwnPlaylists(makeEnv());

    expect(mockSpotifyFetch).toHaveBeenCalledOnce();
    const [, url] = mockSpotifyFetch.mock.calls[0] as [Env, string];
    expect(url).toBe("https://api.spotify.com/v1/me/playlists?limit=50&offset=0");
  });

  it("defaults trackCount to 0 when the item omits tracks", async () => {
    mockSpotifyFetch.mockResolvedValueOnce(
      makeOkResponse({
        items: [{ id: "p3", name: "No Count" }],
        next: null,
        offset: 0,
        limit: 50,
        total: 1,
      }),
    );

    const result = await listOwnPlaylists(makeEnv());
    expect(result.playlists).toEqual([{ id: "p3", name: "No Count", trackCount: 0 }]);
  });

  it("maps items to { id, name, trackCount }", async () => {
    mockSpotifyFetch.mockResolvedValueOnce(
      makeOkResponse({
        items: [
          { id: "p1", name: "Workout", tracks: { total: 42 } },
          { id: "p2", name: "Chill", tracks: { total: 7 } },
        ],
        next: null,
        offset: 0,
        limit: 50,
        total: 2,
      }),
    );

    const result = await listOwnPlaylists(makeEnv());

    expect(result.playlists).toEqual([
      { id: "p1", name: "Workout", trackCount: 42 },
      { id: "p2", name: "Chill", trackCount: 7 },
    ]);
  });

  it("returns nextOffset = offset + limit when the response's next is non-null", async () => {
    mockSpotifyFetch.mockResolvedValueOnce(
      makeOkResponse({
        items: [{ id: "p1", name: "Workout", tracks: { total: 42 } }],
        next: "https://api.spotify.com/v1/me/playlists?limit=50&offset=50",
        offset: 0,
        limit: 50,
        total: 120,
      }),
    );

    const result = await listOwnPlaylists(makeEnv());
    expect(result.nextOffset).toBe(50);
  });

  it("returns nextOffset = null when the response's next is null (last page)", async () => {
    mockSpotifyFetch.mockResolvedValueOnce(
      makeOkResponse({
        items: [{ id: "p1", name: "Workout", tracks: { total: 42 } }],
        next: null,
        offset: 100,
        limit: 50,
        total: 101,
      }),
    );

    const result = await listOwnPlaylists(makeEnv());
    expect(result.nextOffset).toBeNull();
  });

  it("honors an explicit offset param", async () => {
    mockSpotifyFetch.mockResolvedValueOnce(
      makeOkResponse({ items: [], next: null, offset: 50, limit: 50, total: 50 }),
    );

    await listOwnPlaylists(makeEnv(), 50);

    const [, url] = mockSpotifyFetch.mock.calls[0] as [Env, string];
    expect(url).toBe("https://api.spotify.com/v1/me/playlists?limit=50&offset=50");
  });

  it("defaults to a 1s retry delay when Retry-After is absent", async () => {
    vi.useFakeTimers();
    try {
      const noHeaderResponse = {
        ok: false,
        status: 429,
        headers: new Headers(),
        json: () => Promise.resolve({}),
      } as unknown as Response;

      mockSpotifyFetch
        .mockResolvedValueOnce(noHeaderResponse)
        .mockResolvedValueOnce(
          makeOkResponse({ items: [], next: null, offset: 0, limit: 50, total: 0 }),
        );

      const p = listOwnPlaylists(makeEnv());
      await vi.advanceTimersByTimeAsync(1100);
      await p;

      expect(mockSpotifyFetch).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries once on 429 honoring Retry-After", async () => {
    vi.useFakeTimers();
    try {
      mockSpotifyFetch
        .mockResolvedValueOnce(make429Response("1"))
        .mockResolvedValueOnce(
          makeOkResponse({ items: [], next: null, offset: 0, limit: 50, total: 0 }),
        );

      const p = listOwnPlaylists(makeEnv());
      await vi.advanceTimersByTimeAsync(1100);
      await p;

      expect(mockSpotifyFetch).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("throws when Spotify returns 429 twice in a row", async () => {
    vi.useFakeTimers();
    try {
      mockSpotifyFetch
        .mockResolvedValueOnce(make429Response("1"))
        .mockResolvedValueOnce(make429Response("1"));

      const p = listOwnPlaylists(makeEnv());
      await vi.advanceTimersByTimeAsync(1100);
      await expect(p).rejects.toThrow(/rate limit|429/i);
    } finally {
      vi.useRealTimers();
    }
  });

  it("throws on non-OK, non-429 response", async () => {
    mockSpotifyFetch.mockResolvedValueOnce(
      new Response("server error", { status: 500 }) as unknown as Response,
    );
    await expect(listOwnPlaylists(makeEnv())).rejects.toThrow(/500/);
  });

  it("throws when the 429 retry itself returns a non-OK response", async () => {
    vi.useFakeTimers();
    try {
      mockSpotifyFetch
        .mockResolvedValueOnce(make429Response("1"))
        .mockResolvedValueOnce(new Response("server error", { status: 500 }) as unknown as Response);

      const p = listOwnPlaylists(makeEnv());
      await vi.advanceTimersByTimeAsync(1100);
      await expect(p).rejects.toThrow(/API error on retry.*500/);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("T-017-19: one fetch_page log line per page with playlist_id", () => {
  it("emits exactly one log line per page", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    mockQuery
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    mockSpotifyFetch.mockResolvedValueOnce(
      makeOkResponse(makePage([makeTrack("t1", "2026-05-09T10:00:00Z")], null)),
    );

    txQueryResults.push([{ spotify_id: "t1" }], [], [], [], []);

    await fetchPlaylistTracks(makeEnv(), "abc123", 1);

    const fetchPageLogs = logSpy.mock.calls
      .map((c) => c[0] as string)
      .filter((l) => l.includes("fetch_page"));
    expect(fetchPageLogs).toHaveLength(1);
    expect(fetchPageLogs[0]).toContain('"playlist_id":"abc123"');

    logSpy.mockRestore();
  });
});

describe("fetchSpotifyPlaylistName — playlist id encoding", () => {
  it("percent-encodes the playlist id in the request URL", async () => {
    mockSpotifyFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ name: "X" }), { status: 200 }),
    );
    const { fetchSpotifyPlaylistName } = await import(
      "../../../src/providers/spotify/playlists"
    );
    await fetchSpotifyPlaylistName(makeEnv(), "p l/1");
    const url = mockSpotifyFetch.mock.calls[0][1] as string;
    expect(url).toContain("/playlists/p%20l%2F1?fields=name");
  });
});
