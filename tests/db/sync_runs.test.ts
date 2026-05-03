import { describe, it, expect, vi, beforeEach } from "vitest";

const mockSql = vi.fn();
vi.mock("@neondatabase/serverless", () => ({
  neon: () => mockSql,
}));

import {
  insertRun,
  updateRun,
  markAbandonedRuns,
  getLatestRun,
  getLatestSucceededAt,
  getRecentRuns,
  aggregateStats,
} from "../../src/db/sync_runs";
import type { Env } from "../../src/env";

function makeEnv(): Env {
  return {
    DATABASE_URL: "postgresql://test",
    JWT_SECRET: "secret",
    TOKEN_ENCRYPTION_KEY: "dGVzdA==",
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

beforeEach(() => {
  vi.clearAllMocks();
});

// ---- Write helpers ----------------------------------------------------------

describe("T-011: insertRun", () => {
  it("inserts a running row and returns run_id", async () => {
    mockSql.mockResolvedValueOnce([{ run_id: "uuid-123" }]);
    const result = await insertRun(makeEnv());
    expect(result.run_id).toBe("uuid-123");
    const [query, params] = mockSql.mock.calls[0] as [string, unknown[]];
    expect(query).toContain("INSERT INTO sync_runs");
    expect(params).toContain("running");
  });
});

describe("T-011: updateRun", () => {
  it("updates provided fields on a run row", async () => {
    mockSql.mockResolvedValueOnce([]);
    await updateRun(makeEnv(), "run-id", {
      status: "succeeded",
      finished_at: "2026-04-26T10:00:00Z",
      tracks_seen: 42,
    });
    const [query, params] = mockSql.mock.calls[0] as [string, unknown[]];
    expect(query).toContain("UPDATE sync_runs");
    expect(params).toContain("run-id");
    expect(params).toContain("succeeded");
    expect(params).toContain(42);
  });

  it("does nothing when patch is empty", async () => {
    await updateRun(makeEnv(), "run-id", {});
    expect(mockSql).not.toHaveBeenCalled();
  });

  it("serialises error_details as JSON with ::jsonb cast", async () => {
    mockSql.mockResolvedValueOnce([]);
    await updateRun(makeEnv(), "run-id", {
      status: "partial",
      errors: 1,
      error_details: [
        { spotify_id: "spX", error_code: "tidal_429", message: "rate limited" },
      ],
    });
    const [query, params] = mockSql.mock.calls[0] as [string, unknown[]];
    expect(query).toContain("UPDATE sync_runs");
    expect(query).toContain("error_details = ");
    expect(query).toMatch(/error_details\s*=\s*\$\d+::jsonb/);
    const jsonString = JSON.stringify([
      { spotify_id: "spX", error_code: "tidal_429", message: "rate limited" },
    ]);
    expect(params).toContain(jsonString);
  });

  it("passes error_details=null through unchanged (no jsonb cast required for NULL but accepted)", async () => {
    mockSql.mockResolvedValueOnce([]);
    await updateRun(makeEnv(), "run-id", {
      status: "succeeded",
      errors: 0,
      error_details: null,
    });
    const [, params] = mockSql.mock.calls[0] as [string, unknown[]];
    expect(params).toContain(null);
  });
});

describe("T-011: markAbandonedRuns", () => {
  it("updates stale running rows and returns updated count", async () => {
    mockSql.mockResolvedValueOnce([{ run_id: "a" }, { run_id: "b" }, { run_id: "c" }]);
    const count = await markAbandonedRuns(makeEnv());
    expect(count).toBe(3);
    const [query] = mockSql.mock.calls[0] as [string, unknown[]];
    expect(query).toContain("UPDATE sync_runs");
    expect(query).toContain("failed");
  });
});

// ---- Read helpers -----------------------------------------------------------

describe("T-011-05/06: getLatestRun", () => {
  it("returns the most recent run row", async () => {
    const row = {
      run_id: "run-abc",
      started_at: "2026-04-26T07:00:00Z",
      finished_at: "2026-04-26T07:01:00Z",
      status: "succeeded",
      tracks_seen: 10,
      matched_isrc: 8,
      matched_fuzzy: 1,
      unmatched: 1,
      errors: 0,
    };
    mockSql.mockResolvedValueOnce([row]);
    const result = await getLatestRun(makeEnv());
    expect(result).toMatchObject(row);
    const [query] = mockSql.mock.calls[0] as [string, unknown[]];
    expect(query).toContain("ORDER BY started_at DESC");
    expect(query).toContain("LIMIT 1");
  });

  it("returns null when table is empty (T-011-06)", async () => {
    mockSql.mockResolvedValueOnce([]);
    const result = await getLatestRun(makeEnv());
    expect(result).toBeNull();
  });
});

describe("T-011: getLatestSucceededAt", () => {
  it("returns finished_at of most recent succeeded run", async () => {
    mockSql.mockResolvedValueOnce([{ finished_at: "2026-04-26T07:01:00Z" }]);
    const result = await getLatestSucceededAt(makeEnv());
    expect(result).toBe("2026-04-26T07:01:00Z");
    const [query] = mockSql.mock.calls[0] as [string, unknown[]];
    expect(query).toContain("succeeded");
  });

  it("returns null when no succeeded run exists", async () => {
    mockSql.mockResolvedValueOnce([]);
    const result = await getLatestSucceededAt(makeEnv());
    expect(result).toBeNull();
  });
});

describe("T-011-08/09: getRecentRuns", () => {
  it("returns runs ordered by started_at DESC with given limit", async () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({
      run_id: `run-${i}`,
      started_at: `2026-04-26T0${i}:00:00Z`,
      finished_at: null,
      status: "succeeded",
      tracks_seen: i,
      matched_isrc: i,
      matched_fuzzy: 0,
      unmatched: 0,
      errors: 0,
    }));
    mockSql.mockResolvedValueOnce(rows);
    const result = await getRecentRuns(makeEnv(), 10);
    expect(result).toHaveLength(10);
    const [query, params] = mockSql.mock.calls[0] as [string, unknown[]];
    expect(query).toContain("ORDER BY started_at DESC");
    expect(params).toContain(10);
  });
});

function makeAggRow(overrides = {}) {
  return {
    runs_total: "13",
    runs_succeeded: "10",
    runs_partial: "2",
    runs_failed: "1",
    tracks_processed_total: "100",
    matched_total: "87",
    matched_isrc_total: "70",
    matched_fuzzy_total: "17",
    ...overrides,
  };
}

describe("T-011-10/12/14: aggregateStats", () => {
  it("returns aggregate stats for a given period (week)", async () => {
    mockSql.mockResolvedValueOnce([makeAggRow()]);
    mockSql.mockResolvedValueOnce([{ unmatched_pending: "5" }]);

    const result = await aggregateStats(makeEnv(), "week");
    expect(result.runs_total).toBe(13);
    expect(result.runs_succeeded).toBe(10);
    expect(result.runs_partial).toBe(2);
    expect(result.runs_failed).toBe(1);
    expect(result.tracks_processed_total).toBe(100);
    expect(result.match_rate).toBe(0.87);
    expect(result.match_rate_isrc).toBe(0.7);
    expect(result.match_rate_fuzzy).toBe(0.17);
    expect(result.unmatched_pending).toBe(5);
    expect(result.period).toBe("week");
    expect(result.from).toBeDefined();
    expect(result.to).toBeDefined();
  });

  it("returns aggregate stats for period=month", async () => {
    mockSql.mockResolvedValueOnce([makeAggRow()]);
    mockSql.mockResolvedValueOnce([{ unmatched_pending: "2" }]);

    const result = await aggregateStats(makeEnv(), "month");
    expect(result.period).toBe("month");
    expect(result.runs_total).toBe(13);
    const [query] = mockSql.mock.calls[0] as [string, unknown[]];
    expect(query).toContain("1 month");
  });

  it("returns zero match_rate when no tracks processed", async () => {
    mockSql.mockResolvedValueOnce([
      makeAggRow({
        tracks_processed_total: "0",
        matched_total: "0",
        matched_isrc_total: "0",
        matched_fuzzy_total: "0",
      }),
    ]);
    mockSql.mockResolvedValueOnce([{ unmatched_pending: "0" }]);

    const result = await aggregateStats(makeEnv(), "day");
    expect(result.match_rate).toBe(0);
    expect(result.match_rate_isrc).toBe(0);
    expect(result.match_rate_fuzzy).toBe(0);
  });
});
