import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Env } from "../../../src/env";

// Mock @neondatabase/serverless before importing the module under test
const mockQuery = vi.fn();
const mockTransaction = vi.fn();

vi.mock("@neondatabase/serverless", () => ({
  neon: () => {
    const fn = mockQuery;
    (fn as unknown as Record<string, unknown>).transaction = mockTransaction;
    return fn;
  },
}));

vi.mock("../../../src/providers/spotify/oauth", () => ({
  ensureFreshToken: vi.fn().mockResolvedValue("mock-access-token"),
}));

import { fetchLikedSongs } from "../../../src/providers/spotify/liked";
import { ensureFreshToken } from "../../../src/providers/spotify/oauth";

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

function makeTrack(id: string, addedAt: string, overrides: Record<string, unknown> = {}): object {
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

function makeSpotifyPage(items: object[], next: string | null = null): object {
  return { items, next };
}

// Helper: mock neon cursor read (returns cold start) then upsert (noop)
function setupColdStart() {
  // readCursor SELECT → no rows (cold start)
  mockQuery.mockResolvedValueOnce([]);
}

function setupCursorAt(ts: string) {
  // readCursor SELECT → returns cursor row
  mockQuery.mockResolvedValueOnce([{ value: ts }]);
}

beforeEach(() => {
  mockQuery.mockReset();
  mockTransaction.mockReset();
  vi.mocked(ensureFreshToken).mockResolvedValue("mock-access-token");
});

afterEach(() => {
  vi.restoreAllMocks();
});

// T-005-01: Cold start fetches all tracks
describe("T-005-01: cold start fetches all tracks", () => {
  it("inserts all 73 tracks across two pages", async () => {
    // Cold start — no cursor row
    setupColdStart();

    // Build 73 tracks: page 1 = 50, page 2 = 23
    const page1Items = Array.from({ length: 50 }, (_, i) =>
      makeTrack(`t${i + 1}`, `2026-04-25T07:00:${String(i).padStart(2, "0")}Z`),
    );
    const page2Items = Array.from({ length: 23 }, (_, i) =>
      makeTrack(`t${i + 51}`, `2026-04-20T00:00:${String(i).padStart(2, "0")}Z`),
    );

    global.fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve(makeSpotifyPage(page1Items, "https://api.spotify.com/next")),
      } as unknown as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve(makeSpotifyPage(page2Items, null)),
      } as unknown as Response);

    // upsertTracks calls: 50 RETURNING rows for page1, 23 for page2
    // But page2 is the last page — uses transaction
    // page1 upsert: 50 INSERT calls each returning a row
    for (let i = 0; i < 50; i++) {
      mockQuery.mockResolvedValueOnce([{ spotify_id: `t${i + 1}` }]);
    }

    // last page uses transaction
    mockTransaction.mockImplementationOnce(async (cb: (sql: typeof mockQuery) => Promise<void>) => {
      // simulate the transaction sql: 23 inserts + 1 cursor UPSERT
      const txSql = vi.fn();
      for (let i = 0; i < 23; i++) {
        txSql.mockResolvedValueOnce([{ spotify_id: `t${i + 51}` }]);
      }
      txSql.mockResolvedValueOnce([]); // cursor writeCursor
      await cb(txSql);
    });

    const result = await fetchLikedSongs(makeEnv());
    expect(result.tracksInserted).toBe(73);
  });
});

// T-005-02: Cold start advances cursor
describe("T-005-02: cold start advances cursor to max added_at", () => {
  it("writes cursor = max added_at after all pages succeed", async () => {
    setupColdStart();

    const items = [
      makeTrack("a1", "2026-04-25T07:00:00Z"),
      makeTrack("a2", "2026-04-25T06:00:00Z"),
    ];

    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve(makeSpotifyPage(items, null)),
    } as unknown as Response);

    let cursorWritten: string | undefined;
    mockTransaction.mockImplementationOnce(async (cb: (sql: typeof mockQuery) => Promise<void>) => {
      const txSql = vi.fn();
      txSql.mockResolvedValueOnce([{ spotify_id: "a1" }]); // insert a1
      txSql.mockResolvedValueOnce([{ spotify_id: "a2" }]); // insert a2
      txSql.mockImplementationOnce((_sql: string, params: unknown[]) => {
        cursorWritten = params[1] as string;
        return Promise.resolve([]);
      });
      await cb(txSql);
    });

    await fetchLikedSongs(makeEnv());
    expect(cursorWritten).toBe("2026-04-25T07:00:00.000Z");
  });
});

// T-005-03: Incremental fetch returns only new tracks
describe("T-005-03: incremental fetch returns only new tracks", () => {
  it("inserts only 5 new tracks when 50 are already known", async () => {
    const cursorTs = "2026-04-25T00:00:00Z";
    setupCursorAt(cursorTs);

    // 5 new tracks (after cursor), then 1 old track that triggers stop
    const newTracks = Array.from({ length: 5 }, (_, i) =>
      makeTrack(`new${i}`, `2026-04-25T0${i + 1}:00:00Z`),
    );
    const oldTrack = makeTrack("old1", "2026-04-24T23:59:59Z");

    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve(makeSpotifyPage([...newTracks, oldTrack], null)),
    } as unknown as Response);

    mockTransaction.mockImplementationOnce(async (cb: (sql: typeof mockQuery) => Promise<void>) => {
      const txSql = vi.fn();
      for (let i = 0; i < 5; i++) {
        txSql.mockResolvedValueOnce([{ spotify_id: `new${i}` }]);
      }
      txSql.mockResolvedValueOnce([]);
      await cb(txSql);
    });

    const result = await fetchLikedSongs(makeEnv());
    expect(result.tracksInserted).toBe(5);
  });
});

// T-005-04: Incremental fetch stops paginating early
describe("T-005-04: incremental fetch stops paginating early", () => {
  it("issues only 1 page request when new tracks are on page 1", async () => {
    const cursorTs = "2026-04-25T00:00:00Z";
    setupCursorAt(cursorTs);

    const newTrack = makeTrack("new1", "2026-04-25T01:00:00Z");
    const oldTrack = makeTrack("old1", "2026-04-24T23:59:00Z");

    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve(makeSpotifyPage([newTrack, oldTrack], "https://api.spotify.com/next")),
    } as unknown as Response);

    global.fetch = fetchMock;

    mockTransaction.mockImplementationOnce(async (cb: (sql: typeof mockQuery) => Promise<void>) => {
      const txSql = vi.fn();
      txSql.mockResolvedValueOnce([{ spotify_id: "new1" }]);
      txSql.mockResolvedValueOnce([]);
      await cb(txSql);
    });

    await fetchLikedSongs(makeEnv());

    // Only 1 fetch request should have been made (pagination stopped early)
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

// T-005-05: Repeated runs produce no duplicates
describe("T-005-05: repeated runs produce no duplicates", () => {
  it("second run inserts 0 tracks when no new tracks exist", async () => {
    const cursorTs = "2026-04-26T00:00:00Z";

    // Two runs — both hit a page with only old tracks
    setupCursorAt(cursorTs);
    setupCursorAt(cursorTs);

    // All tracks are older than cursor on both runs
    const oldItems = Array.from({ length: 5 }, (_, i) =>
      makeTrack(`old${i}`, "2026-04-25T00:00:00Z"),
    );

    global.fetch = vi.fn()
      .mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve(makeSpotifyPage(oldItems, null)),
      } as unknown as Response);

    // First run — no tracks inserted (stopped immediately), uses transaction with no tracks
    mockTransaction.mockImplementationOnce(async (cb: (sql: typeof mockQuery) => Promise<void>) => {
      const txSql = vi.fn();
      txSql.mockResolvedValueOnce([]); // cursor write (no tracks)
      await cb(txSql);
    });

    const run1 = await fetchLikedSongs(makeEnv());
    expect(run1.tracksInserted).toBe(0);

    mockTransaction.mockImplementationOnce(async (cb: (sql: typeof mockQuery) => Promise<void>) => {
      const txSql = vi.fn();
      txSql.mockResolvedValueOnce([]);
      await cb(txSql);
    });

    const run2 = await fetchLikedSongs(makeEnv());
    expect(run2.tracksInserted).toBe(0);
  });
});

// T-005-06: Cursor unchanged on partial failure
describe("T-005-06: cursor unchanged on partial failure", () => {
  it("throws when page 2 returns 500, and transaction is never called", async () => {
    setupColdStart();

    const page1Items = Array.from({ length: 3 }, (_, i) =>
      makeTrack(`t${i}`, `2026-04-25T0${i + 1}:00:00Z`),
    );

    global.fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve(makeSpotifyPage(page1Items, "https://api.spotify.com/next")),
      } as unknown as Response)
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        headers: new Headers(),
      } as unknown as Response);

    // page1 upserts
    for (let i = 0; i < 3; i++) {
      mockQuery.mockResolvedValueOnce([{ spotify_id: `t${i}` }]);
    }

    await expect(fetchLikedSongs(makeEnv())).rejects.toThrow();
    // Transaction (cursor advance) must not have been called
    expect(mockTransaction).not.toHaveBeenCalled();
  });
});

// T-005-07: Local tracks are skipped
describe("T-005-07: local tracks are skipped", () => {
  it("inserts 3 normal tracks, skips 5 local tracks", async () => {
    setupColdStart();

    const localTracks = Array.from({ length: 5 }, (_, i) =>
      makeTrack(`local${i}`, "2026-04-25T01:00:00Z", { is_local: true }),
    );
    const normalTracks = Array.from({ length: 3 }, (_, i) =>
      makeTrack(`normal${i}`, `2026-04-25T0${i + 2}:00:00Z`),
    );

    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve(makeSpotifyPage([...normalTracks, ...localTracks], null)),
    } as unknown as Response);

    mockTransaction.mockImplementationOnce(async (cb: (sql: typeof mockQuery) => Promise<void>) => {
      const txSql = vi.fn();
      for (let i = 0; i < 3; i++) {
        txSql.mockResolvedValueOnce([{ spotify_id: `normal${i}` }]);
      }
      txSql.mockResolvedValueOnce([]);
      await cb(txSql);
    });

    const result = await fetchLikedSongs(makeEnv());
    expect(result.tracksInserted).toBe(3);
    expect(result.tracksSkipped).toBe(5);
  });
});

// T-005-08: Non-track items are skipped
describe("T-005-08: non-track items are skipped", () => {
  it("inserts 4 tracks, skips 2 episodes", async () => {
    setupColdStart();

    const episodes = Array.from({ length: 2 }, (_, i) =>
      makeTrack(`ep${i}`, "2026-04-25T01:00:00Z", { type: "episode" }),
    );
    const tracks = Array.from({ length: 4 }, (_, i) =>
      makeTrack(`track${i}`, `2026-04-25T0${i + 2}:00:00Z`),
    );

    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve(makeSpotifyPage([...tracks, ...episodes], null)),
    } as unknown as Response);

    mockTransaction.mockImplementationOnce(async (cb: (sql: typeof mockQuery) => Promise<void>) => {
      const txSql = vi.fn();
      for (let i = 0; i < 4; i++) {
        txSql.mockResolvedValueOnce([{ spotify_id: `track${i}` }]);
      }
      txSql.mockResolvedValueOnce([]);
      await cb(txSql);
    });

    const result = await fetchLikedSongs(makeEnv());
    expect(result.tracksInserted).toBe(4);
    expect(result.tracksSkipped).toBe(2);
  });
});

// T-005-09: ISRC is captured when present
describe("T-005-09: ISRC captured when present", () => {
  it("passes isrc to the upsert", async () => {
    setupColdStart();

    const item = {
      added_at: "2026-04-25T07:00:00Z",
      track: {
        id: "spotify123",
        name: "Test Track",
        artists: [{ name: "Artist" }],
        album: { name: "Album" },
        duration_ms: 210000,
        external_ids: { isrc: "GBUM71029604" },
        type: "track",
        is_local: false,
      },
    };

    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve(makeSpotifyPage([item], null)),
    } as unknown as Response);

    let capturedParams: unknown[][] = [];
    mockTransaction.mockImplementationOnce(async (cb: (sql: typeof mockQuery) => Promise<void>) => {
      const txSql = vi.fn().mockImplementation((_sql: string, params: unknown[]) => {
        capturedParams.push(params);
        return Promise.resolve([{ spotify_id: "spotify123" }]);
      });
      // last call is cursor write — return empty
      txSql.mockImplementationOnce((_sql: string, params: unknown[]) => {
        capturedParams.push(params);
        return Promise.resolve([]);
      });
      await cb(txSql);
    });

    await fetchLikedSongs(makeEnv());

    // First call should be the INSERT with isrc as second param
    const insertParams = capturedParams[0];
    expect(insertParams[1]).toBe("GBUM71029604");
  });
});

// T-005-10: Missing ISRC stored as NULL
describe("T-005-10: missing ISRC stored as NULL", () => {
  it("passes null isrc when external_ids is absent", async () => {
    setupColdStart();

    const item = {
      added_at: "2026-04-25T07:00:00Z",
      track: {
        id: "spotify456",
        name: "No ISRC Track",
        artists: [{ name: "Artist" }],
        album: { name: "Album" },
        duration_ms: 200000,
        type: "track",
        is_local: false,
        // no external_ids
      },
    };

    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve(makeSpotifyPage([item], null)),
    } as unknown as Response);

    let insertIsrc: unknown;
    mockTransaction.mockImplementationOnce(async (cb: (sql: typeof mockQuery) => Promise<void>) => {
      const txSql = vi.fn().mockImplementation((_sql: string, params: unknown[]) => {
        if ((_sql as string).includes("INSERT INTO tracks")) {
          insertIsrc = params[1];
          return Promise.resolve([{ spotify_id: "spotify456" }]);
        }
        return Promise.resolve([]);
      });
      await cb(txSql);
    });

    await fetchLikedSongs(makeEnv());
    expect(insertIsrc).toBeNull();
  });
});

// T-005-11: Spotify 429 honours Retry-After
describe("T-005-11: Spotify 429 honours Retry-After", () => {
  it("waits at least Retry-After seconds before retry", async () => {
    setupColdStart();

    vi.useFakeTimers();

    const items = [makeTrack("t1", "2026-04-25T07:00:00Z")];
    let resolveRetry!: () => void;
    const retryPromise = new Promise<void>((r) => { resolveRetry = r; });

    let callCount = 0;
    global.fetch = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve({
          ok: false,
          status: 429,
          headers: new Headers({ "Retry-After": "2" }),
        } as unknown as Response);
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(makeSpotifyPage(items, null)),
      } as unknown as Response);
    });

    mockTransaction.mockImplementationOnce(async (cb: (sql: typeof mockQuery) => Promise<void>) => {
      const txSql = vi.fn();
      txSql.mockResolvedValueOnce([{ spotify_id: "t1" }]);
      txSql.mockResolvedValueOnce([]);
      await cb(txSql);
    });

    const fetchPromise = fetchLikedSongs(makeEnv());

    // Advance fake timers by 2000ms to release the setTimeout
    await vi.advanceTimersByTimeAsync(2000);

    const result = await fetchPromise;
    expect(result.tracksInserted).toBe(1);
    expect(callCount).toBe(2);

    vi.useRealTimers();
  });
});

// T-005-12: Second 429 fails the run
describe("T-005-12: second 429 fails the run", () => {
  it("throws when Spotify returns 429 twice", async () => {
    setupColdStart();

    vi.useFakeTimers();

    let callCount = 0;
    global.fetch = vi.fn().mockImplementation(() => {
      callCount++;
      return Promise.resolve({
        ok: false,
        status: 429,
        headers: new Headers({ "Retry-After": "1" }),
      } as unknown as Response);
    });

    const fetchPromise = fetchLikedSongs(makeEnv());
    await vi.advanceTimersByTimeAsync(1000);

    await expect(fetchPromise).rejects.toThrow("second 429");
    expect(mockTransaction).not.toHaveBeenCalled();

    vi.useRealTimers();
  });
});

// T-005-13: spotify_added_at uses envelope value
describe("T-005-13: spotify_added_at uses envelope added_at, not track release date", () => {
  it("persists envelope added_at, ignores album release_date", async () => {
    setupColdStart();

    const item = {
      added_at: "2026-04-25T10:00:00Z",
      track: {
        id: "t13",
        name: "Track",
        artists: [{ name: "Artist" }],
        album: { name: "Album", release_date: "1985-01-01" },
        duration_ms: 200000,
        external_ids: { isrc: "TEST0001" },
        type: "track",
        is_local: false,
      },
    };

    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve(makeSpotifyPage([item], null)),
    } as unknown as Response);

    let addedAtParam: unknown;
    mockTransaction.mockImplementationOnce(async (cb: (sql: typeof mockQuery) => Promise<void>) => {
      const txSql = vi.fn().mockImplementation((_sql: string, params: unknown[]) => {
        if ((_sql as string).includes("INSERT INTO tracks")) {
          addedAtParam = params[6]; // spotify_added_at is 7th param (index 6)
          return Promise.resolve([{ spotify_id: "t13" }]);
        }
        return Promise.resolve([]);
      });
      await cb(txSql);
    });

    await fetchLikedSongs(makeEnv());
    expect(addedAtParam).toBe("2026-04-25T10:00:00Z");
  });
});

// T-005-14: One log line per page
describe("T-005-14: one log line per page with event='fetch_page'", () => {
  it("emits exactly 3 log lines for 3 pages of tracks", async () => {
    setupColdStart();

    // 3 pages of 40 tracks each
    const page1 = Array.from({ length: 40 }, (_, i) =>
      makeTrack(`p1t${i}`, `2026-04-25T10:${String(i).padStart(2, "0")}:00Z`),
    );
    const page2 = Array.from({ length: 40 }, (_, i) =>
      makeTrack(`p2t${i}`, `2026-04-24T10:${String(i).padStart(2, "0")}:00Z`),
    );
    const page3 = Array.from({ length: 40 }, (_, i) =>
      makeTrack(`p3t${i}`, `2026-04-23T10:${String(i).padStart(2, "0")}:00Z`),
    );

    global.fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve(makeSpotifyPage(page1, "https://api.spotify.com/next1")),
      } as unknown as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve(makeSpotifyPage(page2, "https://api.spotify.com/next2")),
      } as unknown as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve(makeSpotifyPage(page3, null)),
      } as unknown as Response);

    // page1 and page2 upserts (non-last pages)
    for (let i = 0; i < 80; i++) {
      mockQuery.mockResolvedValueOnce([{ spotify_id: `pt${i}` }]);
    }

    // page3 is last — uses transaction
    mockTransaction.mockImplementationOnce(async (cb: (sql: typeof mockQuery) => Promise<void>) => {
      const txSql = vi.fn();
      for (let i = 0; i < 40; i++) {
        txSql.mockResolvedValueOnce([{ spotify_id: `p3t${i}` }]);
      }
      txSql.mockResolvedValueOnce([]);
      await cb(txSql);
    });

    const consoleSpy = vi.spyOn(console, "log");

    await fetchLikedSongs(makeEnv());

    const fetchPageLogs = consoleSpy.mock.calls
      .map((args) => {
        try { return JSON.parse(args[0] as string); } catch { return null; }
      })
      .filter((entry) => entry !== null && entry.event === "fetch_page");

    expect(fetchPageLogs).toHaveLength(3);
  });
});
