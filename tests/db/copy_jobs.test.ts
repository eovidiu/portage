import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Env } from "../../src/env";

const mockSql = vi.fn();
vi.mock("@neondatabase/serverless", () => ({
  neon: () => mockSql,
}));

import {
  createJob,
  loadActiveJob,
  getJob,
  listJobs,
  cancelJob,
  setDestPlaylist,
  setStatus,
  recomputeCounters,
  recomputeCountersForJobs,
  countSkipped,
  setWriteBatchPositions,
  resolveWriteBatch,
  incrementConsecutiveErrors,
  resetConsecutiveErrors,
  NON_TERMINAL_STATUSES,
  type CopyJobRow,
} from "../../src/db/copy_jobs";

const mockEnv = { DATABASE_URL: "postgresql://test" } as Env;

beforeEach(() => {
  vi.clearAllMocks();
});

function makeRow(overrides: Partial<CopyJobRow> = {}): CopyJobRow {
  return {
    job_id: "job-1",
    direction: "spotify_to_tidal",
    source_playlist_id: "src-1",
    source_name: "My Playlist",
    dest_mode: "new",
    dest_playlist_id: null,
    dest_name: "My Playlist",
    status: "queued",
    error_code: null,
    fetch_cursor: null,
    dest_known_ids: null,
    total_tracks: null,
    fetched: 0,
    matched: 0,
    written: 0,
    unmatched: 0,
    write_batch_positions: null,
    consecutive_errors: 0,
    created_at: "2026-07-18T00:00:00Z",
    updated_at: "2026-07-18T00:00:00Z",
    finished_at: null,
    ...overrides,
  };
}

describe("createJob", () => {
  it("inserts a queued row and returns it", async () => {
    const row = makeRow();
    mockSql.mockResolvedValueOnce([row]);

    const result = await createJob(mockEnv, {
      direction: "spotify_to_tidal",
      source_playlist_id: "src-1",
      source_name: "My Playlist",
      dest_mode: "new",
      dest_name: "My Playlist",
    });

    expect(result).toEqual(row);
    const [query, params] = mockSql.mock.calls[0] as [string, unknown[]];
    expect(query).toContain("INSERT INTO copy_jobs");
    expect(params[0]).toBe("spotify_to_tidal");
    expect(params).toContain("src-1");
  });

  it("persists dest_known_ids as JSON when provided (append mode)", async () => {
    const row = makeRow({ dest_mode: "append", dest_known_ids: ["t1", "t2"] });
    mockSql.mockResolvedValueOnce([row]);

    await createJob(mockEnv, {
      direction: "tidal_to_spotify",
      source_playlist_id: "src-2",
      source_name: "Src",
      dest_mode: "append",
      dest_playlist_id: "dest-1",
      dest_known_ids: ["t1", "t2"],
    });

    const [, params] = mockSql.mock.calls[0] as [string, unknown[]];
    expect(params).toContain(JSON.stringify(["t1", "t2"]));
  });
});

describe("loadActiveJob", () => {
  it("returns the single non-terminal job ordered newest first", async () => {
    const row = makeRow({ status: "fetching" });
    mockSql.mockResolvedValueOnce([row]);

    const result = await loadActiveJob(mockEnv);
    expect(result).toEqual(row);
    const [query, params] = mockSql.mock.calls[0] as [string, unknown[]];
    expect(query).toContain("WHERE status = ANY");
    expect(query).toContain("ORDER BY created_at DESC");
    expect(params[0]).toEqual(NON_TERMINAL_STATUSES);
  });

  it("returns null when no active job exists (idle fast-path)", async () => {
    mockSql.mockResolvedValueOnce([]);
    const result = await loadActiveJob(mockEnv);
    expect(result).toBeNull();
    expect(mockSql).toHaveBeenCalledOnce();
  });
});

describe("getJob", () => {
  it("returns the row for a known job_id", async () => {
    const row = makeRow();
    mockSql.mockResolvedValueOnce([row]);
    const result = await getJob(mockEnv, "job-1");
    expect(result).toEqual(row);
  });

  it("returns null for an unknown job_id", async () => {
    mockSql.mockResolvedValueOnce([]);
    const result = await getJob(mockEnv, "missing");
    expect(result).toBeNull();
  });
});

describe("listJobs", () => {
  it("returns rows newest first, capped at the given limit", async () => {
    const rows = [makeRow({ job_id: "job-2" }), makeRow({ job_id: "job-1" })];
    mockSql.mockResolvedValueOnce(rows);
    const result = await listJobs(mockEnv, 20);
    expect(result).toEqual(rows);
    const [query, params] = mockSql.mock.calls[0] as [string, unknown[]];
    expect(query).toContain("ORDER BY created_at DESC");
    expect(params).toEqual([20]);
  });
});

describe("cancelJob", () => {
  it("moves a non-terminal job to cancelled with finished_at set", async () => {
    mockSql.mockResolvedValueOnce([{ job_id: "job-1" }]);
    const result = await cancelJob(mockEnv, "job-1");
    expect(result).toBe("cancelled");
    const [query] = mockSql.mock.calls[0] as [string];
    expect(query).toContain("status = 'cancelled'");
    expect(query).toContain("finished_at = now()");
  });

  it("returns already_terminal when the job is already in a terminal state", async () => {
    // UPDATE ... WHERE status = ANY(non-terminal) matches zero rows.
    mockSql
      .mockResolvedValueOnce([]) // UPDATE affects nothing
      .mockResolvedValueOnce([{ job_id: "job-1" }]); // job exists, just terminal
    const result = await cancelJob(mockEnv, "job-1");
    expect(result).toBe("already_terminal");
  });

  it("returns not_found when the job_id does not exist", async () => {
    mockSql.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    const result = await cancelJob(mockEnv, "missing");
    expect(result).toBe("not_found");
  });
});

describe("setDestPlaylist", () => {
  it("persists dest_playlist_id and optional dest_name", async () => {
    mockSql.mockResolvedValueOnce([]);
    await setDestPlaylist(mockEnv, "job-1", "dest-99", "Renamed");
    const [query, params] = mockSql.mock.calls[0] as [string, unknown[]];
    expect(query).toContain("UPDATE copy_jobs");
    expect(params).toEqual(["job-1", "dest-99", "Renamed"]);
  });
});

describe("setStatus", () => {
  it("updates status with optional error_code and finished_at", async () => {
    mockSql.mockResolvedValueOnce([{ job_id: "job-1" }]);
    await setStatus(mockEnv, "job-1", "failed", {
      error_code: "spotify_reauth_required",
      finished_at: "2026-07-18T01:00:00Z",
    });
    const [query, params] = mockSql.mock.calls[0] as [string, unknown[]];
    expect(query).toContain("UPDATE copy_jobs");
    expect(params).toEqual([
      "job-1",
      "failed",
      "spotify_reauth_required",
      "2026-07-18T01:00:00Z",
      NON_TERMINAL_STATUSES,
    ]);
  });

  it("defaults error_code/finished_at to null when omitted", async () => {
    mockSql.mockResolvedValueOnce([{ job_id: "job-1" }]);
    await setStatus(mockEnv, "job-1", "matching");
    const [, params] = mockSql.mock.calls[0] as [string, unknown[]];
    expect(params).toEqual(["job-1", "matching", null, null, NON_TERMINAL_STATUSES]);
  });

  it("guards the update with WHERE status = ANY(non-terminal) (S2 cancel race)", async () => {
    mockSql.mockResolvedValueOnce([{ job_id: "job-1" }]);
    await setStatus(mockEnv, "job-1", "writing");
    const [query, params] = mockSql.mock.calls[0] as [string, unknown[]];
    expect(query).toContain("status = ANY($5)");
    expect(params[4]).toEqual(NON_TERMINAL_STATUSES);
  });

  it("returns true when the row was updated", async () => {
    mockSql.mockResolvedValueOnce([{ job_id: "job-1" }]);
    const applied = await setStatus(mockEnv, "job-1", "writing");
    expect(applied).toBe(true);
  });

  it("returns false (no throw) when a concurrent cancel already moved the job to a terminal status", async () => {
    mockSql.mockResolvedValueOnce([]); // 0 rows: WHERE status=ANY(non-terminal) matched nothing
    const applied = await setStatus(mockEnv, "job-1", "writing");
    expect(applied).toBe(false);
  });
});

describe("setWriteBatchPositions (B1 batch-in-flight marker)", () => {
  it("persists a position array as JSON", async () => {
    mockSql.mockResolvedValueOnce([]);
    await setWriteBatchPositions(mockEnv, "job-1", [3, 4, 5]);
    const [query, params] = mockSql.mock.calls[0] as [string, unknown[]];
    expect(query).toContain("write_batch_positions");
    expect(params).toEqual(["job-1", JSON.stringify([3, 4, 5])]);
  });

  it("persists null to clear the marker", async () => {
    mockSql.mockResolvedValueOnce([]);
    await setWriteBatchPositions(mockEnv, "job-1", null);
    const [, params] = mockSql.mock.calls[0] as [string, unknown[]];
    expect(params).toEqual(["job-1", null]);
  });
});

describe("resolveWriteBatch (B1 flip + clear-marker)", () => {
  it("flips written positions, write_failed positions, and always clears the marker", async () => {
    mockSql.mockResolvedValue([]);
    await resolveWriteBatch(mockEnv, "job-1", [0, 1], [2]);

    expect(mockSql).toHaveBeenCalledTimes(3);
    const [writtenQuery, writtenParams] = mockSql.mock.calls[0] as [string, unknown[]];
    expect(writtenQuery).toContain("state = 'written'");
    expect(writtenParams).toEqual(["job-1", [0, 1]]);

    const [failedQuery, failedParams] = mockSql.mock.calls[1] as [string, unknown[]];
    expect(failedQuery).toContain("state = 'write_failed'");
    expect(failedParams).toEqual(["job-1", [2]]);

    const [clearQuery, clearParams] = mockSql.mock.calls[2] as [string, unknown[]];
    expect(clearQuery).toContain("write_batch_positions = NULL");
    expect(clearParams).toEqual(["job-1"]);
  });

  it("clears the marker even when both position lists are empty", async () => {
    mockSql.mockResolvedValue([]);
    await resolveWriteBatch(mockEnv, "job-1", [], []);
    expect(mockSql).toHaveBeenCalledTimes(1);
    const [clearQuery] = mockSql.mock.calls[0] as [string];
    expect(clearQuery).toContain("write_batch_positions = NULL");
  });
});

describe("incrementConsecutiveErrors / resetConsecutiveErrors (B3)", () => {
  it("increments and returns the new streak count", async () => {
    mockSql.mockResolvedValueOnce([{ consecutive_errors: 3 }]);
    const streak = await incrementConsecutiveErrors(mockEnv, "job-1");
    expect(streak).toBe(3);
    const [query, params] = mockSql.mock.calls[0] as [string, unknown[]];
    expect(query).toContain("consecutive_errors = consecutive_errors + 1");
    expect(params).toEqual(["job-1"]);
  });

  it("resets the streak to 0 on a successful tick", async () => {
    mockSql.mockResolvedValueOnce([]);
    await resetConsecutiveErrors(mockEnv, "job-1");
    const [query, params] = mockSql.mock.calls[0] as [string, unknown[]];
    expect(query).toContain("consecutive_errors = 0");
    expect(params).toEqual(["job-1"]);
  });
});

describe("recomputeCountersForJobs (S3 batch aggregate for GET /jobs)", () => {
  it("groups copy_job_tracks by job_id + state in one query", async () => {
    mockSql.mockResolvedValueOnce([
      { job_id: "job-1", state: "matched", n: 2 },
      { job_id: "job-1", state: "written", n: 3 },
      { job_id: "job-2", state: "unmatched", n: 1 },
    ]);

    const result = await recomputeCountersForJobs(mockEnv, ["job-1", "job-2"]);

    expect(mockSql).toHaveBeenCalledOnce();
    const [query, params] = mockSql.mock.calls[0] as [string, unknown[]];
    expect(query).toContain("GROUP BY job_id, state");
    expect(params).toEqual([["job-1", "job-2"]]);
    expect(result.get("job-1")).toEqual({ fetched: 5, matched: 2, written: 3, unmatched: 0 });
    expect(result.get("job-2")).toEqual({ fetched: 1, matched: 0, written: 0, unmatched: 1 });
  });

  it("returns an empty map without querying when jobIds is empty", async () => {
    const result = await recomputeCountersForJobs(mockEnv, []);
    expect(result.size).toBe(0);
    expect(mockSql).not.toHaveBeenCalled();
  });
});

describe("recomputeCounters", () => {
  it("groups copy_job_tracks by state and updates the job row", async () => {
    mockSql
      .mockResolvedValueOnce([
        { state: "matched", n: 3 },
        { state: "written", n: 5 },
        { state: "unmatched", n: 2 },
      ])
      .mockResolvedValueOnce([]);

    const result = await recomputeCounters(mockEnv, "job-1");

    expect(result).toEqual({ fetched: 10, matched: 3, written: 5, unmatched: 2 });
    expect(mockSql).toHaveBeenCalledTimes(2);
    const [updateQuery, updateParams] = mockSql.mock.calls[1] as [string, unknown[]];
    expect(updateQuery).toContain("UPDATE copy_jobs");
    expect(updateParams).toEqual(["job-1", 3, 5, 2, 10]);
  });

  it("returns zeros when the job has no tracks yet", async () => {
    mockSql.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    const result = await recomputeCounters(mockEnv, "job-1");
    expect(result).toEqual({ fetched: 0, matched: 0, written: 0, unmatched: 0 });
  });
});

describe("countSkipped", () => {
  it("returns the count of skipped rows for a job (not a persisted job counter)", async () => {
    mockSql.mockResolvedValueOnce([{ n: 2 }]);
    const result = await countSkipped(mockEnv, "job-1");
    expect(result).toBe(2);
    const [query, params] = mockSql.mock.calls[0] as [string, unknown[]];
    expect(query).toContain("state = 'skipped'");
    expect(params).toEqual(["job-1"]);
  });

  it("returns 0 when there are no skipped rows", async () => {
    mockSql.mockResolvedValueOnce([]);
    const result = await countSkipped(mockEnv, "job-1");
    expect(result).toBe(0);
  });
});

describe("createJob — single-active unique index", () => {
  const input = {
    direction: "spotify_to_tidal",
    source_playlist_id: "src-1",
    source_name: "P",
    dest_mode: "new",
  } as const;

  it("returns null when the partial unique index rejects a second active job", async () => {
    mockSql.mockRejectedValueOnce(
      Object.assign(new Error("duplicate key value"), { code: "23505" }),
    );
    expect(await createJob(mockEnv, input)).toBeNull();
  });

  it("rethrows other database errors", async () => {
    mockSql.mockRejectedValueOnce(Object.assign(new Error("boom"), { code: "42P01" }));
    await expect(createJob(mockEnv, input)).rejects.toThrow("boom");
  });
});
