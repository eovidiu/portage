import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Env } from "../../src/env";

// All upstream modules are mocked so F-009 never touches real DB or providers.
const mockSql = vi.fn();
vi.mock("@neondatabase/serverless", () => ({
  neon: () => mockSql,
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

import { runSync } from "../../src/sync/orchestrator";
import { insertRun, updateRun, markAbandonedRuns } from "../../src/db/sync_runs";
import { fetchLikedSongs } from "../../src/providers/spotify/liked";
import { matchByIsrc } from "../../src/match/isrc";
import { matchByFuzzy } from "../../src/match/fuzzy";
import { writePlaylist } from "../../src/sync/playlist-writer";

const mockInsertRun = insertRun as ReturnType<typeof vi.fn>;
const mockUpdateRun = updateRun as ReturnType<typeof vi.fn>;
const mockMarkAbandoned = markAbandonedRuns as ReturnType<typeof vi.fn>;
const mockFetchLikedSongs = fetchLikedSongs as ReturnType<typeof vi.fn>;
const mockMatchByIsrc = matchByIsrc as ReturnType<typeof vi.fn>;
const mockMatchByFuzzy = matchByFuzzy as ReturnType<typeof vi.fn>;
const mockWritePlaylist = writePlaylist as ReturnType<typeof vi.fn>;

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

// Set up mockSql for a standard successful lock/fetchTracks/unlock sequence.
// pg_try_advisory_lock → acquired:true
// fetchNewTracks (SELECT from tracks) → []
// pg_advisory_unlock → [] (default fallback for any extra calls)
function setupSqlSuccess() {
  mockSql
    .mockResolvedValueOnce([{ acquired: true }])
    .mockResolvedValueOnce([])
    .mockResolvedValue([]); // default for unlock + any extra queries
}

// Set up provider/db mocks for a successful run with optional overrides.
function setupProviders(overrides: {
  tracksInserted?: number;
  isrcMatched?: number;
  isrcErrors?: Array<{ spotify_id: string; error_code: string; message: string }>;
  fuzzyMatched?: number;
  fuzzyUnmatched?: number;
  fuzzyErrors?: Array<{ spotify_id: string; error_code: string; message: string }>;
} = {}) {
  mockMarkAbandoned.mockResolvedValue(0);
  mockInsertRun.mockResolvedValue({ run_id: "run-001" });
  mockUpdateRun.mockResolvedValue(undefined);
  mockFetchLikedSongs.mockResolvedValue({
    pagesProcessed: 1,
    tracksInserted: overrides.tracksInserted ?? 5,
    tracksSkipped: 0,
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
// T-009-05: F-005 hard failure marks run failed
// ---------------------------------------------------------------------------
describe("T-009-05: F-005 hard failure marks run failed", () => {
  it("sets status=failed with spotify_reauth_required when fetchLikedSongs throws", async () => {
    setupSqlSuccess();
    setupProviders();
    mockFetchLikedSongs.mockRejectedValue(new Error("invalid_grant"));

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
});

// ---------------------------------------------------------------------------
// T-009-06: Concurrent invocation skipped
// ---------------------------------------------------------------------------
describe("T-009-06: Concurrent invocation skipped", () => {
  it("returns skipped_locked with no sync_runs row when lock is busy", async () => {
    mockMarkAbandoned.mockResolvedValue(0);
    mockSql.mockResolvedValue([{ acquired: false }]); // use mockResolvedValue not Once

    const logSpy = vi.spyOn(console, "log");

    const result = await runSync(makeEnv());

    expect(result.outcome).toBe("skipped_locked");
    expect(mockInsertRun).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("sync_skipped_locked"),
    );
  });
});

// ---------------------------------------------------------------------------
// T-009-07: Lock released after success
// ---------------------------------------------------------------------------
describe("T-009-07: Lock is released after success", () => {
  it("calls pg_advisory_unlock after successful run", async () => {
    setupSqlSuccess();
    setupProviders();

    await runSync(makeEnv());

    // The unlock call uses neon() → mockSql with a query containing pg_advisory_unlock
    const unlockCall = mockSql.mock.calls.find((call) =>
      typeof call[0] === "string" && call[0].includes("pg_advisory_unlock"),
    );
    expect(unlockCall).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// T-009-08: Lock released after exception
// ---------------------------------------------------------------------------
describe("T-009-08: Lock is released after exception", () => {
  it("calls pg_advisory_unlock even when matchByIsrc throws", async () => {
    setupSqlSuccess();
    setupProviders();
    mockMatchByIsrc.mockRejectedValue(new Error("unexpected network failure"));

    await runSync(makeEnv());

    const unlockCall = mockSql.mock.calls.find((call) =>
      typeof call[0] === "string" && call[0].includes("pg_advisory_unlock"),
    );
    expect(unlockCall).toBeDefined();
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
    mockSql.mockResolvedValue([{ acquired: false }]);

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
    // fetchLikedSongs never resolves (simulates long-running fetch)
    mockFetchLikedSongs.mockImplementation(
      () => new Promise<never>(() => { /* intentionally hangs */ }),
    );
    // mockSql: lock acquired for all calls (unlock in finally also uses mockSql)
    mockSql.mockResolvedValue([{ acquired: true, pg_advisory_unlock: true }]);

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
    // unlock still called
    const unlockCall = mockSql.mock.calls.find((call) =>
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

  it("handles non-Error throw from fetchLikedSongs", async () => {
    setupSqlSuccess();
    setupProviders();
    mockFetchLikedSongs.mockRejectedValue("string-fetch-error");

    const result = await runSync(makeEnv());
    expect(result.outcome).toBe("failed");
    expect(result.error_code).toBe("spotify_reauth_required");
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
