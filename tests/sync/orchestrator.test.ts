import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Env } from "../../src/env";

// All upstream modules are mocked so F-009 never touches real DB or providers.
// The orchestrator uses BOTH the HTTP driver (`neon()`) for stateless queries
// and the WebSocket driver (`Pool`) for the session-scoped advisory lock pair.
// We mock both surfaces. mockSql controls the HTTP path (fetchNewTracks,
// listPlaylistConfigs, membership upsert); mockClient.query controls the lock
// pair (pg_try_advisory_lock + pg_advisory_unlock).
const mockSql = vi.fn();
const mockClient = {
  query: vi.fn(),
  release: vi.fn(),
};
const mockPool = {
  connect: vi.fn(),
  end: vi.fn(),
};
vi.mock("@neondatabase/serverless", () => ({
  neon: () => mockSql,
  Pool: vi.fn().mockImplementation(() => mockPool),
}));

vi.mock("../../src/db/sync_runs", () => ({
  insertRun: vi.fn(),
  updateRun: vi.fn(),
  markAbandonedRuns: vi.fn(),
}));

vi.mock("../../src/providers/spotify/liked", () => ({
  fetchLikedSongs: vi.fn(),
}));

vi.mock("../../src/match/isrc", () => ({
  matchByIsrc: vi.fn(),
}));

vi.mock("../../src/match/fuzzy", () => ({
  matchByFuzzy: vi.fn(),
}));

vi.mock("../../src/sync/playlist-writer", () => ({
  writePlaylist: vi.fn(),
}));

// F-016b: new mocks for seeder, playlist configs DB, and multi-playlist fetch.
vi.mock("../../src/sync/playlist-config-seeder", () => ({
  seedPlaylistConfigs: vi.fn(),
}));

vi.mock("../../src/db/playlist_configs", () => ({
  listPlaylistConfigs: vi.fn(),
}));

vi.mock("../../src/providers/spotify/playlists", () => ({
  fetchPlaylistTracks: vi.fn(),
  fetchSpotifyPlaylistName: vi.fn(),
}));

import { runSync } from "../../src/sync/orchestrator";
import { Pool } from "@neondatabase/serverless";
import { insertRun, updateRun, markAbandonedRuns } from "../../src/db/sync_runs";
import { fetchLikedSongs } from "../../src/providers/spotify/liked";
import { matchByIsrc } from "../../src/match/isrc";
import { matchByFuzzy } from "../../src/match/fuzzy";
import { writePlaylist } from "../../src/sync/playlist-writer";
import { seedPlaylistConfigs } from "../../src/sync/playlist-config-seeder";
import { listPlaylistConfigs } from "../../src/db/playlist_configs";
import { fetchPlaylistTracks } from "../../src/providers/spotify/playlists";

const PoolCtor = Pool as unknown as ReturnType<typeof vi.fn>;

const mockInsertRun = vi.mocked(insertRun);
const mockUpdateRun = vi.mocked(updateRun);
const mockMarkAbandoned = vi.mocked(markAbandonedRuns);
const mockFetchLikedSongs = vi.mocked(fetchLikedSongs);
const mockMatchByIsrc = vi.mocked(matchByIsrc);
const mockMatchByFuzzy = vi.mocked(matchByFuzzy);
const mockWritePlaylist = vi.mocked(writePlaylist);
const mockSeedPlaylistConfigs = vi.mocked(seedPlaylistConfigs);
const mockListPlaylistConfigs = vi.mocked(listPlaylistConfigs);
const mockFetchPlaylistTracks = vi.mocked(fetchPlaylistTracks);

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

// Default playlist configs returned by listPlaylistConfigs mock: just __liked__.
const DEFAULT_CONFIGS = [
  {
    spotify_playlist_id: "__liked__",
    spotify_name: "Spotify Liked",
    tidal_playlist_id: "tidal-liked-001",
    created_at: "2026-05-01T00:00:00Z",
    last_synced_at: null,
  },
];

// Set up the lock + HTTP-query sequence for a standard successful run.
// mockClient.query handles the WS-session lock pair (acquire + unlock).
// mockSql handles the HTTP-driver queries (listPlaylistConfigs SELECT,
// membership upsert INSERT, fetchPendingMatchQueue SELECT).
function setupSqlSuccess() {
  mockClient.query
    .mockResolvedValueOnce({ rows: [{ acquired: true }] }) // pg_try_advisory_lock
    .mockResolvedValueOnce({ rows: [{ pg_advisory_unlock: true }] }); // pg_advisory_unlock
  // mockSql call sequence inside runSyncBody:
  // 1. listPlaylistConfigs SELECT (returns playlist rows)
  // 2. __liked__ membership upsert INSERT...SELECT (R18)
  // 3. fetchPendingMatchQueue SELECT (returns [] for no pending tracks)
  mockSql
    .mockResolvedValueOnce(DEFAULT_CONFIGS)  // listPlaylistConfigs
    .mockResolvedValueOnce([])               // __liked__ membership upsert
    .mockResolvedValueOnce([]);              // fetchPendingMatchQueue
}

// Set up provider/db mocks for a successful run with optional overrides.
function setupProviders(overrides: {
  tracksInserted?: number;
  isrcMatched?: number;
  isrcErrors?: Array<{ spotify_id: string; error_code: string; message: string }>;
  fuzzyMatched?: number;
  fuzzyUnmatched?: number;
  fuzzyErrors?: Array<{ spotify_id: string; error_code: string; message: string }>;
  playlistConfigs?: Array<{
    spotify_playlist_id: string;
    spotify_name: string;
    tidal_playlist_id: string | null;
    created_at: string;
    last_synced_at: string | null;
  }>;
} = {}) {
  mockMarkAbandoned.mockResolvedValue(0);
  mockInsertRun.mockResolvedValue({ run_id: "run-001" });
  mockUpdateRun.mockResolvedValue(undefined);
  mockSeedPlaylistConfigs.mockResolvedValue(undefined);
  mockListPlaylistConfigs.mockResolvedValue(
    overrides.playlistConfigs ?? DEFAULT_CONFIGS,
  );
  mockFetchLikedSongs.mockResolvedValue({
    pagesProcessed: 1,
    tracksInserted: overrides.tracksInserted ?? 5,
    tracksSkipped: 0,
  });
  mockFetchPlaylistTracks.mockResolvedValue({
    pagesProcessed: 1,
    tracksInserted: 0,
    tracksSkipped: 0,
    morePagesPending: false,
  });
  mockMatchByIsrc.mockResolvedValue({
    matched: overrides.isrcMatched ?? 3,
    skipped: 0,
    errors: overrides.isrcErrors ?? [],
  });
  mockMatchByFuzzy.mockResolvedValue({
    matched: overrides.fuzzyMatched ?? 1,
    unmatched: overrides.fuzzyUnmatched ?? 1,
    errors: overrides.fuzzyErrors ?? [],
  });
  mockWritePlaylist.mockResolvedValue({
    playlistId: "playlist-1",
    added: 4,
    skippedDuplicates: 0,
    invalidIds: [],
    errors: 0,
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  // resetAllMocks clears every mock's implementation, including the Pool
  // constructor inside the vi.mock factory. Re-establish baseline behaviours.
  PoolCtor.mockImplementation(() => mockPool);
  mockPool.connect.mockResolvedValue(mockClient);
  mockPool.end.mockResolvedValue(undefined);
  // F-016b: mockSql is also used by listPlaylistConfigs inside the module,
  // but those calls go through the module mock; mockSql is the raw neon() surface
  // for direct SQL calls in the orchestrator (membership upsert, fetchPendingMatchQueue).
  mockSql.mockResolvedValue([]);
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// T-009-01: Run row created before any provider call
// ---------------------------------------------------------------------------
describe("T-009-01: Run row created before any provider call", () => {
  it("calls insertRun before fetchLikedSongs", async () => {
    setupSqlSuccess();
    setupProviders();

    const callOrder: string[] = [];
    mockInsertRun.mockImplementation(() => {
      callOrder.push("insertRun");
      return Promise.resolve({ run_id: "run-001" });
    });
    mockFetchLikedSongs.mockImplementation(() => {
      callOrder.push("fetchLikedSongs");
      return Promise.resolve({ pagesProcessed: 1, tracksInserted: 0, tracksSkipped: 0 });
    });

    await runSync(makeEnv());

    const insertIdx = callOrder.indexOf("insertRun");
    const fetchIdx = callOrder.indexOf("fetchLikedSongs");
    expect(insertIdx).toBeGreaterThanOrEqual(0);
    expect(fetchIdx).toBeGreaterThanOrEqual(0);
    expect(insertIdx).toBeLessThan(fetchIdx);
  });
});

// ---------------------------------------------------------------------------
// T-009-02: Successful run reaches succeeded status
// ---------------------------------------------------------------------------
describe("T-009-02: Successful run reaches succeeded status", () => {
  it("calls updateRun with status=succeeded and finished_at set", async () => {
    setupSqlSuccess();
    setupProviders();

    const result = await runSync(makeEnv());

    expect(result.outcome).toBe("succeeded");
    expect(mockUpdateRun).toHaveBeenCalledWith(
      expect.anything(),
      "run-001",
      expect.objectContaining({ status: "succeeded", finished_at: expect.any(String) }),
    );
  });
});

// ---------------------------------------------------------------------------
// T-009-03: Run counts populated correctly
// ---------------------------------------------------------------------------
describe("T-009-03: Run counts populated correctly", () => {
  it("passes correct track/match counts to updateRun (10 seen, 7 ISRC, 2 fuzzy, 1 unmatched)", async () => {
    setupSqlSuccess();
    setupProviders({
      tracksInserted: 10,
      isrcMatched: 7,
      fuzzyMatched: 2,
      fuzzyUnmatched: 1,
    });

    const result = await runSync(makeEnv());

    expect(result.tracks_seen).toBe(10);
    expect(result.matched_isrc).toBe(7);
    expect(result.matched_fuzzy).toBe(2);
    expect(result.unmatched).toBe(1);
    expect(result.errors).toBe(0);

    expect(mockUpdateRun).toHaveBeenCalledWith(
      expect.anything(),
      "run-001",
      expect.objectContaining({
        tracks_seen: 10,
        matched_isrc: 7,
        matched_fuzzy: 2,
        unmatched: 1,
        errors: 0,
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// T-009-04: Per-track error transitions to partial
// ---------------------------------------------------------------------------
describe("T-009-04: Per-track error transitions to partial", () => {
  it("sets status=partial and errors>=1 when matchByIsrc has errors", async () => {
    setupSqlSuccess();
    setupProviders({
      isrcErrors: [{ spotify_id: "sp1", error_code: "tidal_429", message: "rate limited" }],
    });

    const result = await runSync(makeEnv());

    expect(result.outcome).toBe("partial");
    expect(result.errors).toBeGreaterThanOrEqual(1);
    expect(mockUpdateRun).toHaveBeenCalledWith(
      expect.anything(),
      "run-001",
      expect.objectContaining({ status: "partial", errors: 1 }),
    );
  });
});

// ---------------------------------------------------------------------------
// T-009-05: F-005 hard failure marks run failed (R15 discriminating classifier)
// ---------------------------------------------------------------------------
describe("T-009-05: F-005 hard failure marks run failed", () => {
  it("T-009-05a: SpotifyAuthError(reauth_required) -> spotify_reauth_required", async () => {
    setupSqlSuccess();
    setupProviders();
    const { SpotifyAuthError } = await import("../../src/providers/spotify/oauth");
    mockFetchLikedSongs.mockRejectedValue(
      new SpotifyAuthError("reauth_required", "Spotify refresh token revoked (invalid_grant)"),
    );

    const result = await runSync(makeEnv());

    expect(result.outcome).toBe("failed");
    expect(result.error_code).toBe("spotify_reauth_required");
    expect(mockUpdateRun).toHaveBeenCalledWith(
      expect.anything(),
      "run-001",
      expect.objectContaining({ status: "failed", error_code: "spotify_reauth_required" }),
    );
    expect(mockMatchByIsrc).not.toHaveBeenCalled();
    expect(mockMatchByFuzzy).not.toHaveBeenCalled();
  });

  it("T-009-05b: SpotifyAuthError(refresh_failed) -> spotify_transient", async () => {
    setupSqlSuccess();
    setupProviders();
    const { SpotifyAuthError } = await import("../../src/providers/spotify/oauth");
    mockFetchLikedSongs.mockRejectedValue(
      new SpotifyAuthError("refresh_failed", "Spotify refresh failed: 503"),
    );

    const result = await runSync(makeEnv());

    expect(result.outcome).toBe("failed");
    expect(result.error_code).toBe("spotify_transient");
    expect(mockUpdateRun).toHaveBeenCalledWith(
      expect.anything(),
      "run-001",
      expect.objectContaining({ status: "failed", error_code: "spotify_transient" }),
    );
  });

  it("T-009-05c: IntegrityError -> decrypt_failed", async () => {
    setupSqlSuccess();
    setupProviders();
    const { IntegrityError } = await import("../../src/crypto");
    mockFetchLikedSongs.mockRejectedValue(
      new IntegrityError("decryption failed: token_integrity_failure"),
    );

    const result = await runSync(makeEnv());

    expect(result.outcome).toBe("failed");
    expect(result.error_code).toBe("decrypt_failed");
    expect(mockUpdateRun).toHaveBeenCalledWith(
      expect.anything(),
      "run-001",
      expect.objectContaining({ status: "failed", error_code: "decrypt_failed" }),
    );
  });

  it("T-009-05d: Spotify 5xx Error -> spotify_transient", async () => {
    setupSqlSuccess();
    setupProviders();
    mockFetchLikedSongs.mockRejectedValue(new Error("Spotify API error: 503"));

    const result = await runSync(makeEnv());

    expect(result.outcome).toBe("failed");
    expect(result.error_code).toBe("spotify_transient");
  });

  it("T-009-05e: Spotify rate-limit Error -> spotify_transient", async () => {
    setupSqlSuccess();
    setupProviders();
    mockFetchLikedSongs.mockRejectedValue(
      new Error("Spotify rate limit: second 429 received, aborting run"),
    );

    const result = await runSync(makeEnv());

    expect(result.outcome).toBe("failed");
    expect(result.error_code).toBe("spotify_transient");
  });

  it("T-009-05f: generic Error -> fetch_failed", async () => {
    setupSqlSuccess();
    setupProviders();
    mockFetchLikedSongs.mockRejectedValue(new Error("Spotify API error: 404"));

    const result = await runSync(makeEnv());

    expect(result.outcome).toBe("failed");
    expect(result.error_code).toBe("fetch_failed");
  });
});

// ---------------------------------------------------------------------------
// T-009-06: Concurrent invocation skipped
// ---------------------------------------------------------------------------
describe("T-009-06: Concurrent invocation skipped", () => {
  it("returns skipped_locked with no sync_runs row when lock is busy", async () => {
    mockMarkAbandoned.mockResolvedValue(0);
    mockClient.query.mockResolvedValueOnce({ rows: [{ acquired: false }] });

    const logSpy = vi.spyOn(console, "log");

    const result = await runSync(makeEnv());

    expect(result.outcome).toBe("skipped_locked");
    expect(mockInsertRun).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("sync_skipped_locked"),
    );
    // Pool resources released even when lock not acquired
    expect(mockClient.release).toHaveBeenCalled();
    expect(mockPool.end).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// T-009-07: Lock released after success
// ---------------------------------------------------------------------------
describe("T-009-07: Lock is released after success", () => {
  it("calls pg_advisory_unlock and tears down Pool after successful run", async () => {
    setupSqlSuccess();
    setupProviders();

    await runSync(makeEnv());

    const unlockCall = mockClient.query.mock.calls.find((call) =>
      typeof call[0] === "string" && call[0].includes("pg_advisory_unlock"),
    );
    expect(unlockCall).toBeDefined();
    expect(mockClient.release).toHaveBeenCalled();
    expect(mockPool.end).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// T-009-08: Lock released after exception
// ---------------------------------------------------------------------------
describe("T-009-07b: Pool resources released when lock acquire query throws", () => {
  it("releases client and ends pool when pg_try_advisory_lock query itself rejects", async () => {
    mockMarkAbandoned.mockResolvedValue(0);
    mockClient.query.mockRejectedValueOnce(new Error("connection lost"));

    await expect(runSync(makeEnv())).rejects.toThrow("connection lost");
    expect(mockClient.release).toHaveBeenCalled();
    expect(mockPool.end).toHaveBeenCalled();
    expect(mockInsertRun).not.toHaveBeenCalled();
  });
});

describe("T-009-08: Lock is released after exception", () => {
  it("calls pg_advisory_unlock and tears down Pool even when matchByIsrc throws", async () => {
    setupSqlSuccess();
    setupProviders();
    mockMatchByIsrc.mockRejectedValue(new Error("unexpected network failure"));

    await runSync(makeEnv());

    const unlockCall = mockClient.query.mock.calls.find((call) =>
      typeof call[0] === "string" && call[0].includes("pg_advisory_unlock"),
    );
    expect(unlockCall).toBeDefined();
    expect(mockClient.release).toHaveBeenCalled();
    expect(mockPool.end).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// T-009-09: Abandoned run cleaned up
// ---------------------------------------------------------------------------
describe("T-009-09: Abandoned run cleaned up", () => {
  it("calls markAbandonedRuns before acquiring lock", async () => {
    const callOrder: string[] = [];

    mockMarkAbandoned.mockImplementation(() => {
      callOrder.push("markAbandonedRuns");
      return Promise.resolve(1);
    });
    // Return lock-not-acquired so we don't need to set up the whole run
    mockClient.query.mockResolvedValueOnce({ rows: [{ acquired: false }] });

    await runSync(makeEnv());

    expect(callOrder[0]).toBe("markAbandonedRuns");
    // markAbandonedRuns was called before lock attempt (lock returned false, still called first)
    expect(callOrder).toContain("markAbandonedRuns");
  });
});

// ---------------------------------------------------------------------------
// T-009-11: Wall-time cap reflected in run status (T-009-10 timing deferred to e2e)
// ---------------------------------------------------------------------------
describe("T-009-11: Wall-time cap reflected in run status", () => {
  it("sets status=partial and error_code=wall_time_exceeded when 300s timer fires", async () => {
    // Set up all mocks BEFORE enabling fake timers
    mockMarkAbandoned.mockResolvedValue(0);
    mockInsertRun.mockResolvedValue({ run_id: "run-timeout" });
    mockUpdateRun.mockResolvedValue(undefined);
    // F-016b: seed + list needed before fetchLikedSongs is reached
    mockSeedPlaylistConfigs.mockResolvedValue(undefined);
    mockListPlaylistConfigs.mockResolvedValue(DEFAULT_CONFIGS);
    // fetchLikedSongs never resolves (simulates long-running fetch)
    mockFetchLikedSongs.mockImplementation(
      () => new Promise<never>(() => { /* intentionally hangs */ }),
    );
    // Lock pair on Pool/client; HTTP-driver query on mockSql.
    mockClient.query.mockResolvedValue({ rows: [{ acquired: true, pg_advisory_unlock: true }] });
    mockSql.mockResolvedValue([]);

    vi.useFakeTimers();

    const promise = runSync(makeEnv());
    await vi.advanceTimersByTimeAsync(300_001);
    const result = await promise;

    expect(result.outcome).toBe("partial");
    expect(result.error_code).toBe("wall_time_exceeded");
    expect(mockUpdateRun).toHaveBeenCalledWith(
      expect.anything(),
      "run-timeout",
      expect.objectContaining({ status: "partial", error_code: "wall_time_exceeded" }),
    );
  });
});

// ---------------------------------------------------------------------------
// T-009-08b: Lock released after fuzzy match exception (covers fuzzy catch branch)
// ---------------------------------------------------------------------------
describe("T-009-08b: fuzzy match exception handled gracefully", () => {
  it("counts fuzzy fatal error and still completes run when matchByFuzzy throws", async () => {
    setupSqlSuccess();
    setupProviders();
    mockMatchByFuzzy.mockRejectedValue(new Error("fuzzy network error"));

    const result = await runSync(makeEnv());

    // Should be partial (errors > 0 from fuzzy fatal)
    expect(result.outcome).toBe("partial");
    expect(result.errors).toBeGreaterThanOrEqual(1);
    // unlock still called via the WS client
    const unlockCall = mockClient.query.mock.calls.find((call) =>
      typeof call[0] === "string" && call[0].includes("pg_advisory_unlock"),
    );
    expect(unlockCall).toBeDefined();
  });

  it("handles non-Error throw from matchByFuzzy", async () => {
    setupSqlSuccess();
    setupProviders();
    mockMatchByFuzzy.mockRejectedValue("string-error");

    const result = await runSync(makeEnv());
    expect(result.outcome).toBe("partial");
    expect(result.errors).toBeGreaterThanOrEqual(1);
  });

  it("handles non-Error throw from matchByIsrc", async () => {
    setupSqlSuccess();
    setupProviders();
    mockMatchByIsrc.mockRejectedValue("string-isrc-error");

    const result = await runSync(makeEnv());
    expect(result.outcome).toBe("partial");
    expect(result.errors).toBeGreaterThanOrEqual(1);
  });

  it("handles non-Error throw from writePlaylist", async () => {
    setupSqlSuccess();
    setupProviders();
    mockWritePlaylist.mockRejectedValue("string-playlist-error");

    const result = await runSync(makeEnv());
    // Playlist failure doesn't affect the run outcome (non-fatal)
    expect(result.outcome).toBe("succeeded");
  });

  it("T-009-05g: non-Error throw from fetchLikedSongs -> fetch_failed", async () => {
    setupSqlSuccess();
    setupProviders();
    mockFetchLikedSongs.mockRejectedValue("string-fetch-error");

    const result = await runSync(makeEnv());
    expect(result.outcome).toBe("failed");
    expect(result.error_code).toBe("fetch_failed");
  });
});

// ---------------------------------------------------------------------------
// T-009-12: Idempotent re-run (orchestrator does not introduce duplication)
// ---------------------------------------------------------------------------
describe("T-009-12: Idempotent re-run produces no duplicates", () => {
  it("second run succeeds without duplicate inserts", async () => {
    setupSqlSuccess();
    setupProviders();

    const result1 = await runSync(makeEnv());
    expect(result1.outcome).toBe("succeeded");

    vi.clearAllMocks();
    setupSqlSuccess();
    setupProviders();

    const result2 = await runSync(makeEnv());
    expect(result2.outcome).toBe("succeeded");
    // Each run inserts exactly one sync_runs row
    expect(mockInsertRun).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// T-009-13: F-008 failure does not delete matches
// ---------------------------------------------------------------------------
describe("T-009-13: F-008 failure does not delete matches", () => {
  it("preserves match counts in updateRun when writePlaylist throws", async () => {
    setupSqlSuccess();
    setupProviders({ isrcMatched: 5, fuzzyMatched: 0, fuzzyUnmatched: 0 });
    mockWritePlaylist.mockRejectedValue(new Error("Tidal 500"));

    const result = await runSync(makeEnv());

    expect(result.matched_isrc).toBe(5);
    expect(mockUpdateRun).toHaveBeenCalledWith(
      expect.anything(),
      "run-001",
      expect.objectContaining({ matched_isrc: 5 }),
    );
  });
});

// ---------------------------------------------------------------------------
// T-009-14: Single completion log line
// ---------------------------------------------------------------------------
describe("T-009-14: Single completion log line", () => {
  it("emits exactly one log line with event=sync_run_completed", async () => {
    setupSqlSuccess();
    setupProviders();

    const logSpy = vi.spyOn(console, "log");

    await runSync(makeEnv());

    const completedLines = logSpy.mock.calls.filter((call) => {
      try {
        const parsed = JSON.parse(call[0] as string);
        return parsed.event === "sync_run_completed";
      } catch {
        return false;
      }
    });

    expect(completedLines).toHaveLength(1);
  });
});

// F-015: per-invocation budgets applied to ISRC, fuzzy, and Spotify pages.
describe("F-015: bounded per-invocation budgets", () => {
  it("uses defaults (ISRC=5, fuzzy=5, pages=1) when env not set", async () => {
    setupSqlSuccess();
    setupProviders();

    await runSync(makeEnv());

    // fetchLikedSongs called with maxPages = 1
    expect(mockFetchLikedSongs).toHaveBeenCalledWith(expect.anything(), 1);
    // fetchPendingMatchQueue: find the neon() call whose params are [N] (the queue limit).
    // mockSql call[0] is the __liked__ membership upsert; call[1] is fetchPendingMatchQueue.
    const queueCall = mockSql.mock.calls.find(
      (call) => Array.isArray(call[1]) && (call[1] as unknown[]).length === 1 && typeof (call[1] as unknown[])[0] === "number",
    ) as [string, unknown[]] | undefined;
    expect(queueCall).toBeDefined();
    expect(queueCall![1]).toEqual([5]);
    // matchByFuzzy called with options.limit = 5
    expect(mockMatchByFuzzy).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ limit: 5, syncRunId: "run-001" }),
    );
  });

  it("honours MATCH_BATCH_ISRC, MATCH_BATCH_FUZZY, LIKED_PAGES_PER_RUN env overrides", async () => {
    setupSqlSuccess();
    setupProviders();

    const env = { ...makeEnv(), MATCH_BATCH_ISRC: "8", MATCH_BATCH_FUZZY: "12", LIKED_PAGES_PER_RUN: "3" };
    await runSync(env);

    expect(mockFetchLikedSongs).toHaveBeenCalledWith(expect.anything(), 3);
    const queueCall = mockSql.mock.calls.find(
      (call) => Array.isArray(call[1]) && (call[1] as unknown[]).length === 1 && typeof (call[1] as unknown[])[0] === "number",
    ) as [string, unknown[]] | undefined;
    expect(queueCall![1]).toEqual([8]);
    expect(mockMatchByFuzzy).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ limit: 12 }),
    );
  });

  it("falls back to default when env is invalid (NaN, zero, negative)", async () => {
    setupSqlSuccess();
    setupProviders();

    const env = { ...makeEnv(), MATCH_BATCH_ISRC: "not-a-number", MATCH_BATCH_FUZZY: "0", LIKED_PAGES_PER_RUN: "-2" };
    await runSync(env);

    expect(mockFetchLikedSongs).toHaveBeenCalledWith(expect.anything(), 1);
    const queueCall = mockSql.mock.calls.find(
      (call) => Array.isArray(call[1]) && (call[1] as unknown[]).length === 1 && typeof (call[1] as unknown[])[0] === "number",
    ) as [string, unknown[]] | undefined;
    expect(queueCall![1]).toEqual([5]);
    expect(mockMatchByFuzzy).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ limit: 5 }),
    );
  });
});

// ---------------------------------------------------------------------------
// T-009-15: Partial run persists per-track error_details (F-009-R12)
// ---------------------------------------------------------------------------
describe("T-009-15: Partial run persists per-track error_details", () => {
  it("updateRun receives error_details array with the matcher-reported entry", async () => {
    setupSqlSuccess();
    setupProviders({
      isrcErrors: [
        {
          spotify_id: "spX",
          error_code: "tidal_429",
          message: "Second 429 received; track deferred to F-007",
        },
      ],
    });

    const result = await runSync(makeEnv());

    expect(result.outcome).toBe("partial");
    expect(mockUpdateRun).toHaveBeenCalledWith(
      expect.anything(),
      "run-001",
      expect.objectContaining({
        status: "partial",
        errors: 1,
        error_details: [
          {
            spotify_id: "spX",
            error_code: "tidal_429",
            message: "Second 429 received; track deferred to F-007",
          },
        ],
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// T-009-16: Succeeded run leaves error_details NULL (F-009-R13)
// ---------------------------------------------------------------------------
describe("T-009-16: Succeeded run leaves error_details null", () => {
  it("updateRun receives error_details=null when no errors occurred", async () => {
    setupSqlSuccess();
    setupProviders();

    const result = await runSync(makeEnv());

    expect(result.outcome).toBe("succeeded");
    expect(mockUpdateRun).toHaveBeenCalledWith(
      expect.anything(),
      "run-001",
      expect.objectContaining({ status: "succeeded", errors: 0, error_details: null }),
    );
  });
});

// ---------------------------------------------------------------------------
// T-009-17: error_details length matches errors count (F-009-R12 invariant)
// ---------------------------------------------------------------------------
describe("T-009-17: error_details length matches errors count", () => {
  it("merges isrc and fuzzy errors preserving order; length === errors", async () => {
    setupSqlSuccess();
    setupProviders({
      isrcErrors: [
        { spotify_id: "sp1", error_code: "tidal_429", message: "rate limited" },
        { spotify_id: "sp2", error_code: "tidal_500", message: "Tidal returned HTTP 500" },
      ],
      fuzzyErrors: [
        {
          spotify_id: "sp3",
          error_code: "tidal_parse_error",
          message: "Failed to parse Tidal search response JSON",
        },
      ],
    });

    const result = await runSync(makeEnv());

    expect(result.outcome).toBe("partial");
    expect(result.errors).toBe(3);

    const updateCall = mockUpdateRun.mock.calls.find(
      (call) => (call[2] as { status?: string }).status === "partial",
    );
    expect(updateCall).toBeDefined();
    const patch = updateCall![2] as { error_details: Array<{ error_code: string }> | null };
    expect(patch.error_details).not.toBeNull();
    expect(patch.error_details).toHaveLength(3);
    const codes = patch.error_details!.map((e) => e.error_code).sort();
    expect(codes).toEqual(["tidal_429", "tidal_500", "tidal_parse_error"].sort());
  });
});

// ---------------------------------------------------------------------------
// T-009-21: seedPlaylistConfigs called before the fetch loop (F-009-R16)
// ---------------------------------------------------------------------------
describe("T-009-21: seedPlaylistConfigs called before fetch loop", () => {
  it("calls seedPlaylistConfigs before fetchLikedSongs on every run", async () => {
    setupSqlSuccess();
    setupProviders();

    const callOrder: string[] = [];
    mockSeedPlaylistConfigs.mockImplementation(() => {
      callOrder.push("seed");
      return Promise.resolve(undefined);
    });
    mockFetchLikedSongs.mockImplementation(() => {
      callOrder.push("fetchLiked");
      return Promise.resolve({ pagesProcessed: 1, tracksInserted: 0, tracksSkipped: 0 });
    });

    await runSync(makeEnv());

    expect(callOrder.indexOf("seed")).toBeGreaterThanOrEqual(0);
    expect(callOrder.indexOf("fetchLiked")).toBeGreaterThanOrEqual(0);
    expect(callOrder.indexOf("seed")).toBeLessThan(callOrder.indexOf("fetchLiked"));
  });
});

// ---------------------------------------------------------------------------
// T-009-22: orchestrator processes __liked__ + extras within MAX_PLAYLISTS_PER_RUN cap
// ---------------------------------------------------------------------------
describe("T-009-22: processes __liked__ + extras within cap", () => {
  it("fetches __liked__ plus up to (cap-1) extras, skipping remainder", async () => {
    // 5 extras + __liked__ but cap=3 means __liked__ + 2 extras
    const configs = [
      {
        spotify_playlist_id: "__liked__",
        spotify_name: "Spotify Liked",
        tidal_playlist_id: "t-liked",
        created_at: "2026-01-01T00:00:00Z",
        last_synced_at: null,
      },
      {
        spotify_playlist_id: "extra1",
        spotify_name: "Workout",
        tidal_playlist_id: null,
        created_at: "2026-01-02T00:00:00Z",
        last_synced_at: null,
      },
      {
        spotify_playlist_id: "extra2",
        spotify_name: "Chill",
        tidal_playlist_id: null,
        created_at: "2026-01-03T00:00:00Z",
        last_synced_at: null,
      },
      {
        spotify_playlist_id: "extra3",
        spotify_name: "Roadtrip",
        tidal_playlist_id: null,
        created_at: "2026-01-04T00:00:00Z",
        last_synced_at: null,
      },
    ];
    // mockSql: membership upsert + fetchPendingMatchQueue
    mockClient.query
      .mockResolvedValueOnce({ rows: [{ acquired: true }] })
      .mockResolvedValueOnce({ rows: [{ pg_advisory_unlock: true }] });
    mockSql
      .mockResolvedValueOnce([])    // __liked__ membership upsert
      .mockResolvedValueOnce([]);   // fetchPendingMatchQueue
    setupProviders({ playlistConfigs: configs });

    const env = { ...makeEnv(), MAX_PLAYLISTS_PER_RUN: "3" };
    await runSync(env);

    // fetchLikedSongs called once for __liked__
    expect(mockFetchLikedSongs).toHaveBeenCalledTimes(1);
    // fetchPlaylistTracks called exactly cap-1 = 2 times for extras
    expect(mockFetchPlaylistTracks).toHaveBeenCalledTimes(2);
    expect(mockFetchPlaylistTracks).toHaveBeenCalledWith(env, "extra1", expect.any(Number));
    expect(mockFetchPlaylistTracks).toHaveBeenCalledWith(env, "extra2", expect.any(Number));
    expect(mockFetchPlaylistTracks).not.toHaveBeenCalledWith(env, "extra3", expect.any(Number));
  });

  it("calls writePlaylist for __liked__ and each fetched extra", async () => {
    const configs = [
      {
        spotify_playlist_id: "__liked__",
        spotify_name: "Spotify Liked",
        tidal_playlist_id: "t-liked",
        created_at: "2026-01-01T00:00:00Z",
        last_synced_at: null,
      },
      {
        spotify_playlist_id: "extra1",
        spotify_name: "Workout",
        tidal_playlist_id: "t-extra1",
        created_at: "2026-01-02T00:00:00Z",
        last_synced_at: null,
      },
    ];
    mockClient.query
      .mockResolvedValueOnce({ rows: [{ acquired: true }] })
      .mockResolvedValueOnce({ rows: [{ pg_advisory_unlock: true }] });
    mockSql
      .mockResolvedValueOnce([])   // __liked__ membership upsert
      .mockResolvedValueOnce([]);  // fetchPendingMatchQueue
    setupProviders({ playlistConfigs: configs });

    await runSync(makeEnv());

    expect(mockWritePlaylist).toHaveBeenCalledTimes(2);
    expect(mockWritePlaylist).toHaveBeenCalledWith(
      expect.anything(), "__liked__", "t-liked",
    );
    expect(mockWritePlaylist).toHaveBeenCalledWith(
      expect.anything(), "extra1", "t-extra1",
    );
  });
});

// ---------------------------------------------------------------------------
// T-009-23: orchestrator emits the post-fetch __liked__ membership upsert (R18)
// ---------------------------------------------------------------------------
describe("T-009-23: post-fetch __liked__ membership upsert emitted", () => {
  it("calls mockSql with an INSERT...SELECT...LEFT JOIN for __liked__ membership after fetchLikedSongs", async () => {
    setupSqlSuccess();
    setupProviders();

    await runSync(makeEnv());

    // The R18 upsert is the first direct mockSql call in runSyncBody.
    // Its SQL contains the __liked__ literal and the LEFT JOIN pattern.
    const membershipUpsertCall = mockSql.mock.calls.find(
      (call) =>
        typeof call[0] === "string" &&
        (call[0] as string).includes("__liked__") &&
        (call[0] as string).toLowerCase().includes("left join"),
    );
    expect(membershipUpsertCall).toBeDefined();
    const sql = membershipUpsertCall![0] as string;
    expect(sql).toMatch(/INSERT INTO playlist_membership/i);
    expect(sql).toMatch(/'__liked__'/);
    expect(sql).toMatch(/ON CONFLICT DO NOTHING/i);
  });
});

// ---------------------------------------------------------------------------
// T-009-24b: per-playlist FETCH failure does NOT abort the run (R17)
// ---------------------------------------------------------------------------
describe("T-009-24b: per-playlist fetch failure does not abort run", () => {
  it("logs fetch error for extra and continues to matching + write", async () => {
    const configs = [
      {
        spotify_playlist_id: "__liked__",
        spotify_name: "Spotify Liked",
        tidal_playlist_id: "t-liked",
        created_at: "2026-01-01T00:00:00Z",
        last_synced_at: null,
      },
      {
        spotify_playlist_id: "extra1",
        spotify_name: "Workout",
        tidal_playlist_id: "t-extra1",
        created_at: "2026-01-02T00:00:00Z",
        last_synced_at: null,
      },
    ];
    mockClient.query
      .mockResolvedValueOnce({ rows: [{ acquired: true }] })
      .mockResolvedValueOnce({ rows: [{ pg_advisory_unlock: true }] });
    mockSql
      .mockResolvedValueOnce([])   // __liked__ membership upsert
      .mockResolvedValueOnce([]);  // fetchPendingMatchQueue
    setupProviders({ playlistConfigs: configs });

    mockFetchPlaylistTracks.mockRejectedValueOnce(new Error("Spotify API error: 503"));

    const logSpy = vi.spyOn(console, "log");
    const result = await runSync(makeEnv());

    // Run still completes and succeeds
    expect(result.outcome).toBe("succeeded");
    // Error logged for the failing extra
    const fetchFailedLog = logSpy.mock.calls.find((call) => {
      try {
        const p = JSON.parse(call[0] as string);
        return p.event === "playlist_fetch_failed" && p.spotify_playlist_id === "extra1";
      } catch { return false; }
    });
    expect(fetchFailedLog).toBeDefined();
    // __liked__ write still proceeds
    expect(mockWritePlaylist).toHaveBeenCalledWith(
      expect.anything(), "__liked__", "t-liked",
    );
  });
});

// ---------------------------------------------------------------------------
// T-009-24: per-playlist write failure does NOT abort the run (R19)
// ---------------------------------------------------------------------------
describe("T-009-24: per-playlist write failure does not abort run", () => {
  it("continues to subsequent playlists and succeeds when one writePlaylist throws", async () => {
    const configs = [
      {
        spotify_playlist_id: "__liked__",
        spotify_name: "Spotify Liked",
        tidal_playlist_id: "t-liked",
        created_at: "2026-01-01T00:00:00Z",
        last_synced_at: null,
      },
      {
        spotify_playlist_id: "extra1",
        spotify_name: "Workout",
        tidal_playlist_id: "t-extra1",
        created_at: "2026-01-02T00:00:00Z",
        last_synced_at: null,
      },
    ];
    mockClient.query
      .mockResolvedValueOnce({ rows: [{ acquired: true }] })
      .mockResolvedValueOnce({ rows: [{ pg_advisory_unlock: true }] });
    mockSql
      .mockResolvedValueOnce([])   // __liked__ membership upsert
      .mockResolvedValueOnce([]);  // fetchPendingMatchQueue
    setupProviders({ playlistConfigs: configs });

    // First writePlaylist (__liked__) throws; second (extra1) should still be called.
    mockWritePlaylist
      .mockRejectedValueOnce(new Error("Tidal 500 on __liked__"))
      .mockResolvedValueOnce({
        playlistId: "t-extra1",
        added: 1,
        skippedDuplicates: 0,
        invalidIds: [],
        errors: 0,
      });

    const result = await runSync(makeEnv());

    // Run still completes; second writePlaylist was called
    expect(mockWritePlaylist).toHaveBeenCalledTimes(2);
    // Run outcome is still succeeded (write failures don't affect sync_runs status per R19)
    expect(result.outcome).toBe("succeeded");
  });
});

// ---------------------------------------------------------------------------
// T-009-25: 0 extras (env var empty) preserves pre-multi-playlist behaviour
// ---------------------------------------------------------------------------
describe("T-009-25: 0 extras — pre-multi-playlist behaviour preserved", () => {
  it("only calls fetchLikedSongs when configs has just __liked__", async () => {
    setupSqlSuccess();
    setupProviders(); // DEFAULT_CONFIGS = [__liked__] only

    await runSync(makeEnv());

    expect(mockFetchLikedSongs).toHaveBeenCalledTimes(1);
    expect(mockFetchPlaylistTracks).not.toHaveBeenCalled();
    expect(mockWritePlaylist).toHaveBeenCalledTimes(1);
    expect(mockWritePlaylist).toHaveBeenCalledWith(
      expect.anything(), "__liked__", "tidal-liked-001",
    );
  });
});

// ---------------------------------------------------------------------------
// T-009-26: legacy single-arg writePlaylist replaced with per-playlist loop
// ---------------------------------------------------------------------------
describe("T-009-26: writePlaylist called per-playlist, not single-arg legacy", () => {
  it("writePlaylist receives spotifyPlaylistId and tidalPlaylistId, not just env", async () => {
    setupSqlSuccess();
    setupProviders();

    await runSync(makeEnv());

    // writePlaylist must be called with (env, spotifyId, tidalId) — 3 args, not 1
    const calls = mockWritePlaylist.mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0]).toHaveLength(3);
    expect(calls[0][1]).toBe("__liked__");
    expect(calls[0][2]).toBe("tidal-liked-001");
  });
});

// ---------------------------------------------------------------------------
// T-009-20: MAX_PLAYLISTS_PER_RUN env var respected (default 3)
// ---------------------------------------------------------------------------
describe("MAX_PLAYLISTS_PER_RUN: default 3 and env override", () => {
  it("defaults to 3 when env var absent (fetches __liked__ + up to 2 extras)", async () => {
    const configs = [
      {
        spotify_playlist_id: "__liked__",
        spotify_name: "Spotify Liked",
        tidal_playlist_id: "t-liked",
        created_at: "2026-01-01T00:00:00Z",
        last_synced_at: null,
      },
      {
        spotify_playlist_id: "e1",
        spotify_name: "P1",
        tidal_playlist_id: null,
        created_at: "2026-01-02T00:00:00Z",
        last_synced_at: null,
      },
      {
        spotify_playlist_id: "e2",
        spotify_name: "P2",
        tidal_playlist_id: null,
        created_at: "2026-01-03T00:00:00Z",
        last_synced_at: null,
      },
      {
        spotify_playlist_id: "e3",
        spotify_name: "P3",
        tidal_playlist_id: null,
        created_at: "2026-01-04T00:00:00Z",
        last_synced_at: null,
      },
    ];
    mockClient.query
      .mockResolvedValueOnce({ rows: [{ acquired: true }] })
      .mockResolvedValueOnce({ rows: [{ pg_advisory_unlock: true }] });
    mockSql
      .mockResolvedValueOnce([])   // __liked__ membership upsert
      .mockResolvedValueOnce([]);  // fetchPendingMatchQueue
    setupProviders({ playlistConfigs: configs });

    // No MAX_PLAYLISTS_PER_RUN set — defaults to 3
    await runSync(makeEnv());

    // __liked__ + 2 extras = 3 total; 4th extra (e3) deferred
    expect(mockFetchPlaylistTracks).toHaveBeenCalledTimes(2);
    expect(mockFetchPlaylistTracks).not.toHaveBeenCalledWith(
      expect.anything(), "e3", expect.any(Number),
    );
  });

  it("respects env override of 1 (only __liked__, no extras)", async () => {
    const configs = [
      {
        spotify_playlist_id: "__liked__",
        spotify_name: "Spotify Liked",
        tidal_playlist_id: "t-liked",
        created_at: "2026-01-01T00:00:00Z",
        last_synced_at: null,
      },
      {
        spotify_playlist_id: "e1",
        spotify_name: "P1",
        tidal_playlist_id: null,
        created_at: "2026-01-02T00:00:00Z",
        last_synced_at: null,
      },
    ];
    mockClient.query
      .mockResolvedValueOnce({ rows: [{ acquired: true }] })
      .mockResolvedValueOnce({ rows: [{ pg_advisory_unlock: true }] });
    mockSql
      .mockResolvedValueOnce([])   // __liked__ membership upsert
      .mockResolvedValueOnce([]);  // fetchPendingMatchQueue
    setupProviders({ playlistConfigs: configs });

    await runSync({ ...makeEnv(), MAX_PLAYLISTS_PER_RUN: "1" });

    expect(mockFetchLikedSongs).toHaveBeenCalledTimes(1);
    expect(mockFetchPlaylistTracks).not.toHaveBeenCalled();
  });

  it("falls back to 3 when env value is invalid", async () => {
    setupSqlSuccess();
    setupProviders();

    const env = { ...makeEnv(), MAX_PLAYLISTS_PER_RUN: "not-a-number" };
    const result = await runSync(env);
    expect(result.outcome).toBe("succeeded");
  });
});
