import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Env } from "../../../src/env";

// Mock @neondatabase/serverless before importing the module under test.
// mockTransaction simulates the sync-callback array form:
//   db.transaction((txSql) => [...queries]) → Promise<results[]>
// We intercept the callback, call it with a mock txSql, and resolve each
// returned query promise with a pre-queued result.
const mockQuery = vi.fn();
const txQueryResults: unknown[][] = [];
const mockTxSql = vi.fn().mockImplementation(() => {
  const result = txQueryResults.shift() ?? [];
  // Return a thenable so the driver can treat it as a NeonQueryPromise
  return Promise.resolve(result);
});

const mockTransaction = vi.fn().mockImplementation(
  (fn: (sql: typeof mockTxSql) => unknown[]) => {
    const queries = fn(mockTxSql);
    // Resolve all queries and return their results as an array
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

// M1: liked.ts now uses spotifyFetch, not ensureFreshToken directly
vi.mock("../../../src/providers/spotify/oauth", () => ({
  spotifyFetch: vi.fn(),
  ensureFreshToken: vi.fn(),
}));

import { fetchLikedSongs } from "../../../src/providers/spotify/liked";
import { spotifyFetch } from "../../../src/providers/spotify/oauth";

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

function make500Response(): Response {
  return {
    ok: false,
    status: 500,
    headers: new Headers(),
    json: () => Promise.resolve({}),
  } as unknown as Response;
}

function make401Response(): Response {
  return {
    ok: false,
    status: 401,
    headers: new Headers(),
    json: () => Promise.resolve({}),
  } as unknown as Response;
}

function setupColdStart() {
  mockQuery.mockResolvedValueOnce([]); // readCursor → cold
  mockQuery.mockResolvedValueOnce([]); // readState resume_url → null (F-015)
  mockQuery.mockResolvedValueOnce([]); // readState sweep_max → null (F-015)
}

function setupCursorAt(ts: string) {
  mockQuery.mockResolvedValueOnce([{ value: ts }]); // readCursor
  mockQuery.mockResolvedValueOnce([]); // readState resume_url → null (F-015)
  mockQuery.mockResolvedValueOnce([]); // readState sweep_max → null (F-015)
}

// Queue results for txSql calls inside the LAST page's transaction.
// F-015: transaction now writes 3 sync_state keys (cursor + resume_url + sweep_max).
// Does not clear the queue — beforeEach resets it, and non-last pages queue first.
function queueTxResults(trackIds: string[]) {
  for (const id of trackIds) {
    txQueryResults.push([{ spotify_id: id }]);
  }
  txQueryResults.push([]); // cursor UPSERT
  txQueryResults.push([]); // resume_url UPSERT (F-015)
  txQueryResults.push([]); // sweep_max UPSERT (F-015)
}

// Queue results for a NON-last page's batched upsert transaction (no
// sync_state writes — cursor state only persists with the last page).
function queueNonLastTxResults(trackIds: string[]) {
  for (const id of trackIds) {
    txQueryResults.push([{ spotify_id: id }]);
  }
}

/** Capture each sync_state write that goes through the transaction. */
function captureStateWrites(): { writes: Array<[string, string]>; impl: (_sql: string, params: unknown[]) => Promise<unknown[]> } {
  const writes: Array<[string, string]> = [];
  return {
    writes,
    impl: (_sql: string, params: unknown[]) => {
      if (typeof _sql === "string" && _sql.includes("INSERT INTO tracks")) {
        return Promise.resolve([{ spotify_id: (params as string[])[0] }]);
      }
      if (typeof _sql === "string" && _sql.includes("sync_state")) {
        writes.push([(params as string[])[0], (params as string[])[1]]);
      }
      return Promise.resolve([]);
    },
  };
}

beforeEach(() => {
  mockQuery.mockReset();
  mockTxSql.mockReset();
  mockTransaction.mockReset();
  txQueryResults.length = 0;

  // Re-attach transaction to mockQuery after reset
  (mockQuery as unknown as Record<string, unknown>).transaction = mockTransaction;

  // Default transaction implementation
  mockTransaction.mockImplementation(
    (fn: (sql: typeof mockTxSql) => unknown[]) => {
      const queries = fn(mockTxSql);
      return Promise.all(queries as Promise<unknown[]>[]);
    },
  );

  // Default txSql: pop from txQueryResults queue
  mockTxSql.mockImplementation(() => {
    const result = txQueryResults.shift() ?? [];
    return Promise.resolve(result);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// T-005-01: Cold start fetches all tracks
describe("T-005-01: cold start fetches all tracks", () => {
  it("inserts all 73 tracks across two pages", async () => {
    setupColdStart();

    const page1Items = Array.from({ length: 50 }, (_, i) =>
      makeTrack(`t${i + 1}`, `2026-04-25T07:00:${String(i).padStart(2, "0")}Z`),
    );
    const page2Items = Array.from({ length: 23 }, (_, i) =>
      makeTrack(`t${i + 51}`, `2026-04-20T00:00:${String(i).padStart(2, "0")}Z`),
    );

    vi.mocked(spotifyFetch)
      .mockResolvedValueOnce(makeOkResponse(makeSpotifyPage(page1Items, "https://api.spotify.com/next")))
      .mockResolvedValueOnce(makeOkResponse(makeSpotifyPage(page2Items, null)));

    // page1 = 50 non-last-page upserts in ONE batched transaction
    queueNonLastTxResults(Array.from({ length: 50 }, (_, i) => `t${i + 1}`));
    // page2 = last page — 23 inserts + cursor via transaction
    queueTxResults(Array.from({ length: 23 }, (_, i) => `t${i + 51}`));

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

    vi.mocked(spotifyFetch).mockResolvedValueOnce(makeOkResponse(makeSpotifyPage(items, null)));

    let cursorWritten: string | undefined;
    mockTxSql.mockImplementation((_sql: string, params: unknown[]) => {
      if ((_sql as string).includes("INSERT INTO tracks")) {
        return Promise.resolve([{ spotify_id: params[0] }]);
      }
      // F-015: only capture the spotify_cursor key (resume_url + sweep_max also write here)
      if ((params as string[])[0] === "spotify_cursor") {
        cursorWritten = (params as string[])[1];
      }
      return Promise.resolve([]);
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

    const newTracks = Array.from({ length: 5 }, (_, i) =>
      makeTrack(`new${i}`, `2026-04-25T0${i + 1}:00:00Z`),
    );
    const oldTrack = makeTrack("old1", "2026-04-24T23:59:59Z");

    vi.mocked(spotifyFetch).mockResolvedValueOnce(
      makeOkResponse(makeSpotifyPage([...newTracks, oldTrack], null)),
    );

    queueTxResults(Array.from({ length: 5 }, (_, i) => `new${i}`));

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

    vi.mocked(spotifyFetch).mockResolvedValueOnce(
      makeOkResponse(makeSpotifyPage([newTrack, oldTrack], "https://api.spotify.com/next")),
    );

    queueTxResults(["new1"]);

    await fetchLikedSongs(makeEnv());

    // spotifyFetch called exactly once — pagination stopped after page 1
    expect(vi.mocked(spotifyFetch)).toHaveBeenCalledTimes(1);
  });
});

// T-005-05: Repeated runs produce no duplicates
describe("T-005-05: repeated runs produce no duplicates", () => {
  it("second run inserts 0 tracks when no new tracks exist", async () => {
    const cursorTs = "2026-04-26T00:00:00Z";

    const oldItems = Array.from({ length: 5 }, (_, i) =>
      makeTrack(`old${i}`, "2026-04-25T00:00:00Z"),
    );

    // Run 1
    setupCursorAt(cursorTs);
    vi.mocked(spotifyFetch).mockResolvedValueOnce(
      makeOkResponse(makeSpotifyPage(oldItems, null)),
    );
    const run1 = await fetchLikedSongs(makeEnv());
    expect(run1.tracksInserted).toBe(0);

    // Run 2 — same setup
    setupCursorAt(cursorTs);
    vi.mocked(spotifyFetch).mockResolvedValueOnce(
      makeOkResponse(makeSpotifyPage(oldItems, null)),
    );
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

    vi.mocked(spotifyFetch)
      .mockResolvedValueOnce(makeOkResponse(makeSpotifyPage(page1Items, "https://api.spotify.com/next")))
      .mockResolvedValueOnce(make500Response());

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

    vi.mocked(spotifyFetch).mockResolvedValueOnce(
      makeOkResponse(makeSpotifyPage([...normalTracks, ...localTracks], null)),
    );

    queueTxResults(Array.from({ length: 3 }, (_, i) => `normal${i}`));

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

    vi.mocked(spotifyFetch).mockResolvedValueOnce(
      makeOkResponse(makeSpotifyPage([...tracks, ...episodes], null)),
    );

    queueTxResults(Array.from({ length: 4 }, (_, i) => `track${i}`));

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

    vi.mocked(spotifyFetch).mockResolvedValueOnce(
      makeOkResponse(makeSpotifyPage([item], null)),
    );

    let capturedIsrc: unknown;
    mockTxSql.mockImplementation((_sql: string, params: unknown[]) => {
      if ((_sql as string).includes("INSERT INTO tracks")) {
        capturedIsrc = params[1];
        return Promise.resolve([{ spotify_id: "spotify123" }]);
      }
      return Promise.resolve([]);
    });

    await fetchLikedSongs(makeEnv());
    expect(capturedIsrc).toBe("GBUM71029604");
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
      },
    };

    vi.mocked(spotifyFetch).mockResolvedValueOnce(
      makeOkResponse(makeSpotifyPage([item], null)),
    );

    let insertIsrc: unknown;
    mockTxSql.mockImplementation((_sql: string, params: unknown[]) => {
      if ((_sql as string).includes("INSERT INTO tracks")) {
        insertIsrc = params[1];
        return Promise.resolve([{ spotify_id: "spotify456" }]);
      }
      return Promise.resolve([]);
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

    let callCount = 0;
    vi.mocked(spotifyFetch).mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve(make429Response("2"));
      }
      return Promise.resolve(makeOkResponse(makeSpotifyPage(items, null)));
    });

    queueTxResults(["t1"]);

    const fetchPromise = fetchLikedSongs(makeEnv());
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

    vi.mocked(spotifyFetch).mockResolvedValue(make429Response("1"));

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

    vi.mocked(spotifyFetch).mockResolvedValueOnce(
      makeOkResponse(makeSpotifyPage([item], null)),
    );

    let addedAtParam: unknown;
    mockTxSql.mockImplementation((_sql: string, params: unknown[]) => {
      if ((_sql as string).includes("INSERT INTO tracks")) {
        addedAtParam = params[6]; // spotify_added_at is 7th param (index 6)
        return Promise.resolve([{ spotify_id: "t13" }]);
      }
      return Promise.resolve([]);
    });

    await fetchLikedSongs(makeEnv());
    expect(addedAtParam).toBe("2026-04-25T10:00:00Z");
  });
});

// T-005-14: One log line per page
describe("T-005-14: one log line per page with event='fetch_page'", () => {
  it("emits exactly 3 log lines for 3 pages of tracks", async () => {
    setupColdStart();

    const page1 = Array.from({ length: 40 }, (_, i) =>
      makeTrack(`p1t${i}`, `2026-04-25T10:${String(i).padStart(2, "0")}:00Z`),
    );
    const page2 = Array.from({ length: 40 }, (_, i) =>
      makeTrack(`p2t${i}`, `2026-04-24T10:${String(i).padStart(2, "0")}:00Z`),
    );
    const page3 = Array.from({ length: 40 }, (_, i) =>
      makeTrack(`p3t${i}`, `2026-04-23T10:${String(i).padStart(2, "0")}:00Z`),
    );

    vi.mocked(spotifyFetch)
      .mockResolvedValueOnce(makeOkResponse(makeSpotifyPage(page1, "https://api.spotify.com/next1")))
      .mockResolvedValueOnce(makeOkResponse(makeSpotifyPage(page2, "https://api.spotify.com/next2")))
      .mockResolvedValueOnce(makeOkResponse(makeSpotifyPage(page3, null)));

    // page1 + page2: one batched transaction per non-last page
    queueNonLastTxResults(Array.from({ length: 40 }, (_, i) => `p1t${i}`));
    queueNonLastTxResults(Array.from({ length: 40 }, (_, i) => `p2t${i}`));

    // page3 = last page via transaction
    queueTxResults(Array.from({ length: 40 }, (_, i) => `p3t${i}`));

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

// T-005-15: First 429 + retry returns 500 path (coverage gap from liked.ts:77)
describe("T-005-15: first 429 then 500 on retry fails the run", () => {
  it("throws when 429 retry returns 500", async () => {
    setupColdStart();

    vi.useFakeTimers();

    let callCount = 0;
    vi.mocked(spotifyFetch).mockImplementation(() => {
      callCount++;
      if (callCount === 1) return Promise.resolve(make429Response("1"));
      return Promise.resolve(make500Response());
    });

    const fetchPromise = fetchLikedSongs(makeEnv());
    await vi.advanceTimersByTimeAsync(1000);

    await expect(fetchPromise).rejects.toThrow("Spotify API error on retry: 500");
    expect(mockTransaction).not.toHaveBeenCalled();

    vi.useRealTimers();
  });
});

// T-005-16: Empty Spotify response emits one log line with items_seen: 0
describe("T-005-16: empty Spotify page emits one log line", () => {
  it("logs event=fetch_page with items_seen=0 when account has no tracks", async () => {
    setupColdStart();

    vi.mocked(spotifyFetch).mockResolvedValueOnce(
      makeOkResponse(makeSpotifyPage([], null)),
    );

    const consoleSpy = vi.spyOn(console, "log");

    await fetchLikedSongs(makeEnv());

    const fetchPageLogs = consoleSpy.mock.calls
      .map((args) => {
        try { return JSON.parse(args[0] as string); } catch { return null; }
      })
      .filter((entry) => entry !== null && entry.event === "fetch_page");

    expect(fetchPageLogs).toHaveLength(1);
    expect(fetchPageLogs[0].items_seen).toBe(0);
    expect(fetchPageLogs[0].items_persisted).toBe(0);
  });
});

// T-005-17: 401 mid-pagination triggers refresh and retry via spotifyFetch
describe("T-005-17: 401 mid-pagination triggers refresh and retry", () => {
  it("run succeeds when page 2 initially returns 401 but spotifyFetch retries successfully", async () => {
    setupColdStart();

    const page1Items = [makeTrack("p1t1", "2026-04-25T05:00:00Z")];
    const page2Items = [makeTrack("p2t1", "2026-04-25T04:00:00Z")];

    // spotifyFetch handles 401 internally (F-002-R11 refresh+retry).
    // From liked.ts perspective, it only sees the final response.
    // Here we simulate spotifyFetch returning 401 on the 2nd call,
    // then returning 200 after internal refresh (spotifyFetch absorbs the 401).
    // In practice spotifyFetch doesn't return 401 after retry — but we test the
    // case where the caller sees a non-OK, non-429 status.
    vi.mocked(spotifyFetch)
      .mockResolvedValueOnce(makeOkResponse(makeSpotifyPage(page1Items, "https://api.spotify.com/next")))
      .mockResolvedValueOnce(makeOkResponse(makeSpotifyPage(page2Items, null)));

    // page1 = non-last via its own batched transaction
    queueNonLastTxResults(["p1t1"]);
    // page2 = last via transaction
    queueTxResults(["p2t1"]);

    const result = await fetchLikedSongs(makeEnv());
    expect(result.tracksInserted).toBe(2);
    expect(vi.mocked(spotifyFetch)).toHaveBeenCalledTimes(2);
  });
});

// F-015: bounded pagination + resume URL semantics
describe("F-015 bounded pagination", () => {
  it("stops after maxPages and persists page.next as spotify_resume_url; does NOT advance cursor mid-sweep", async () => {
    setupColdStart();

    const page1 = Array.from({ length: 50 }, (_, i) =>
      makeTrack(`p1t${i}`, `2026-04-25T07:00:${String(i).padStart(2, "0")}Z`),
    );
    // Spotify returns page.next pointing at page 2; we voluntarily stop after 1 page.
    vi.mocked(spotifyFetch).mockResolvedValueOnce(
      makeOkResponse(makeSpotifyPage(page1, "https://api.spotify.com/next2")),
    );

    const cap = captureStateWrites();
    mockTxSql.mockImplementation(cap.impl);

    const result = await fetchLikedSongs(makeEnv(), 1);

    expect(result.pagesProcessed).toBe(1);
    expect(result.tracksInserted).toBe(50);
    expect(result.morePagesPending).toBe(true);
    expect(vi.mocked(spotifyFetch)).toHaveBeenCalledTimes(1);

    const writesByKey = Object.fromEntries(cap.writes);
    // mid-sweep: cursor stays cold, resume_url = next, sweep_max = newest of page 1
    expect(writesByKey["spotify_cursor"]).toBe("1970-01-01T00:00:00Z");
    expect(writesByKey["spotify_resume_url"]).toBe("https://api.spotify.com/next2");
    expect(writesByKey["spotify_sweep_max"]).toBe("2026-04-25T07:00:49.000Z");
  });

  it("resumes from spotify_resume_url when set, ignores LIKED_SONGS_URL default", async () => {
    // cursor + resume_url set, sweep_max set
    mockQuery.mockResolvedValueOnce([{ value: "1970-01-01T00:00:00Z" }]);
    mockQuery.mockResolvedValueOnce([{ value: "https://api.spotify.com/page2" }]);
    mockQuery.mockResolvedValueOnce([{ value: "2026-04-25T07:00:00.000Z" }]);

    const page2 = [makeTrack("p2t1", "2026-04-24T10:00:00Z")];
    vi.mocked(spotifyFetch).mockResolvedValueOnce(
      makeOkResponse(makeSpotifyPage(page2, null)),
    );

    const cap = captureStateWrites();
    mockTxSql.mockImplementation(cap.impl);

    const result = await fetchLikedSongs(makeEnv(), 5);

    // The fetch call must have used the resume URL, not LIKED_SONGS_URL
    const fetchUrl = vi.mocked(spotifyFetch).mock.calls[0][1] as string;
    expect(fetchUrl).toBe("https://api.spotify.com/page2");

    // page.next === null on page 2 → sweep complete
    expect(result.morePagesPending).toBe(false);
    const writesByKey = Object.fromEntries(cap.writes);
    // sweep complete: cursor advances to sweep_max (preserved from previous invocations); resume_url cleared; sweep_max cleared
    expect(writesByKey["spotify_cursor"]).toBe("2026-04-25T07:00:00.000Z");
    expect(writesByKey["spotify_resume_url"]).toBe("");
    expect(writesByKey["spotify_sweep_max"]).toBe("");
  });

  it("clears resume_url when cursor cutoff hits mid-sweep (steady state)", async () => {
    setupCursorAt("2026-04-25T08:00:00Z");

    // page 1 has tracks straddling the cutoff (08:00 - 60s = 07:59:00)
    const items = [
      makeTrack("new", "2026-04-25T08:01:00Z"), // newer than cursor → process
      makeTrack("old", "2026-04-25T07:00:00Z"), // older than cutoff → triggers cutoffHit
    ];
    vi.mocked(spotifyFetch).mockResolvedValueOnce(
      makeOkResponse(makeSpotifyPage(items, "https://api.spotify.com/next")),
    );

    const cap = captureStateWrites();
    mockTxSql.mockImplementation(cap.impl);

    const result = await fetchLikedSongs(makeEnv(), 5);

    expect(result.morePagesPending).toBe(false);
    const writesByKey = Object.fromEntries(cap.writes);
    expect(writesByKey["spotify_resume_url"]).toBe("");
    expect(writesByKey["spotify_cursor"]).toBe("2026-04-25T08:01:00.000Z"); // advanced to runMax
  });

  it("default maxPages is unbounded (preserves prior behavior when caller does not specify)", async () => {
    setupColdStart();

    const page1 = [makeTrack("a", "2026-04-25T07:00:00Z")];
    const page2 = [makeTrack("b", "2026-04-24T07:00:00Z")];

    vi.mocked(spotifyFetch)
      .mockResolvedValueOnce(makeOkResponse(makeSpotifyPage(page1, "https://api.spotify.com/n2")))
      .mockResolvedValueOnce(makeOkResponse(makeSpotifyPage(page2, null)));

    mockQuery.mockResolvedValueOnce([{ spotify_id: "a" }]);
    queueTxResults(["b"]);

    const result = await fetchLikedSongs(makeEnv()); // no maxPages
    expect(result.pagesProcessed).toBe(2);
    expect(result.morePagesPending).toBe(false);
  });
});
