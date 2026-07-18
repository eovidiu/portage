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
    mockSql.mockResolvedValueOnce([]);
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
    ]);
  });

  it("defaults error_code/finished_at to null when omitted", async () => {
    mockSql.mockResolvedValueOnce([]);
    await setStatus(mockEnv, "job-1", "matching");
    const [, params] = mockSql.mock.calls[0] as [string, unknown[]];
    expect(params).toEqual(["job-1", "matching", null, null]);
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
