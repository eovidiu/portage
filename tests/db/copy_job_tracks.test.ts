import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Env } from "../../src/env";

// Mirrors tests/providers/spotify/playlists.test.ts's db.transaction mock.
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

import {
  insertFetchedPage,
  countPending,
  listPendingForMatch,
  listMatchedForWrite,
  getTrack,
  listTracksPage,
  updateTrackMatch,
  updateTracksState,
  type CopyJobTrackRow,
} from "../../src/db/copy_job_tracks";

const mockEnv = { DATABASE_URL: "postgresql://test" } as Env;

beforeEach(() => {
  mockQuery.mockReset();
  mockTxSql.mockClear();
  mockTransaction.mockClear();
  txQueryResults.length = 0;
});

function makeRow(overrides: Partial<CopyJobTrackRow> = {}): CopyJobTrackRow {
  return {
    job_id: "job-1",
    position: 0,
    source_track_id: "sp1",
    isrc: "USABC1234567",
    title: "Song",
    artist: "Artist",
    album: "Album",
    duration_ms: 200000,
    state: "pending",
    match_method: null,
    confidence: null,
    dest_track_id: null,
    candidates: null,
    reason: null,
    updated_at: "2026-07-18T00:00:00Z",
    ...overrides,
  };
}

describe("insertFetchedPage", () => {
  it("inserts each track and advances the cursor+status atomically for a non-last page", async () => {
    txQueryResults.push([{ id: "sp1" }], []);
    await insertFetchedPage(mockEnv, "job-1", {
      tracks: [
        {
          source_track_id: "sp1",
          isrc: "USABC1234567",
          title: "Song",
          artist: "Artist",
          album: "Album",
          duration_ms: 200000,
        },
      ],
      positionStart: 0,
      cursor: "cursor-2",
      isLastPage: false,
    });

    expect(mockTransaction).toHaveBeenCalledOnce();
    // First query: track insert; second: job cursor/status update.
    expect(mockTxSql.mock.calls[0][0]).toContain("INSERT INTO copy_job_tracks");
    const [jobQuery, jobParams] = mockTxSql.mock.calls[1] as [string, unknown[]];
    expect(jobQuery).toContain("UPDATE copy_jobs");
    expect(jobQuery).toContain("status = 'fetching'");
    expect(jobParams).toContain("cursor-2");
  });

  it("sets status='matching' and total_tracks on the last page", async () => {
    txQueryResults.push([{ id: "sp1" }], []);
    await insertFetchedPage(mockEnv, "job-1", {
      tracks: [
        {
          source_track_id: "sp1",
          isrc: null,
          title: "Song",
          artist: null,
          album: null,
          duration_ms: null,
        },
      ],
      positionStart: 5,
      cursor: null,
      isLastPage: true,
      totalTracks: 6,
    });

    const [jobQuery, jobParams] = mockTxSql.mock.calls[1] as [string, unknown[]];
    expect(jobQuery).toContain("status = 'matching'");
    expect(jobParams).toContain(6);
  });

  it("positions rows sequentially starting from positionStart", async () => {
    txQueryResults.push([{}], [{}], []);
    await insertFetchedPage(mockEnv, "job-1", {
      tracks: [
        { source_track_id: "a", isrc: null, title: "A", artist: null, album: null, duration_ms: null },
        { source_track_id: "b", isrc: null, title: "B", artist: null, album: null, duration_ms: null },
      ],
      positionStart: 10,
      cursor: "c",
      isLastPage: false,
    });
    const firstParams = mockTxSql.mock.calls[0][1] as unknown[];
    const secondParams = mockTxSql.mock.calls[1][1] as unknown[];
    expect(firstParams).toContain(10);
    expect(secondParams).toContain(11);
  });
});

describe("countPending", () => {
  it("returns the count of pending rows for a job", async () => {
    mockQuery.mockResolvedValueOnce([{ n: 4 }]);
    const result = await countPending(mockEnv, "job-1");
    expect(result).toBe(4);
    const [query, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(query).toContain("state = 'pending'");
    expect(params).toEqual(["job-1"]);
  });
});

describe("listPendingForMatch / listMatchedForWrite", () => {
  it("listPendingForMatch orders by position ascending, capped at limit", async () => {
    const rows = [makeRow({ position: 0 }), makeRow({ position: 1 })];
    mockQuery.mockResolvedValueOnce(rows);
    const result = await listPendingForMatch(mockEnv, "job-1", 2);
    expect(result).toEqual(rows);
    const [query, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(query).toContain("state = 'pending'");
    expect(query).toContain("ORDER BY position ASC");
    expect(params).toEqual(["job-1", 2]);
  });

  it("listMatchedForWrite selects state='matched' rows", async () => {
    const rows = [makeRow({ position: 0, state: "matched" })];
    mockQuery.mockResolvedValueOnce(rows);
    const result = await listMatchedForWrite(mockEnv, "job-1", 20);
    expect(result).toEqual(rows);
    const [query] = mockQuery.mock.calls[0] as [string];
    expect(query).toContain("state = 'matched'");
  });
});

describe("getTrack", () => {
  it("returns the row at job_id+position", async () => {
    const row = makeRow();
    mockQuery.mockResolvedValueOnce([row]);
    const result = await getTrack(mockEnv, "job-1", 0);
    expect(result).toEqual(row);
  });

  it("returns null when no row matches", async () => {
    mockQuery.mockResolvedValueOnce([]);
    const result = await getTrack(mockEnv, "job-1", 999);
    expect(result).toBeNull();
  });
});

describe("listTracksPage", () => {
  it("filters by state and pages via position cursor", async () => {
    const rows = [makeRow({ position: 5 }), makeRow({ position: 6 })];
    mockQuery.mockResolvedValueOnce(rows);
    const result = await listTracksPage(mockEnv, "job-1", {
      state: "unmatched",
      afterPosition: 4,
      limit: 2,
    });
    expect(result.tracks).toEqual(rows);
    expect(result.next_cursor).toBe("6");
    const [query, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(query).toContain("state = $2");
    expect(query).toContain("position > $3");
    expect(params).toEqual(["job-1", "unmatched", 4, 2]);
  });

  it("returns next_cursor null when fewer rows than limit come back", async () => {
    mockQuery.mockResolvedValueOnce([makeRow({ position: 0 })]);
    const result = await listTracksPage(mockEnv, "job-1", { limit: 5 });
    expect(result.next_cursor).toBeNull();
  });

  it("omits the state filter when not provided", async () => {
    mockQuery.mockResolvedValueOnce([]);
    await listTracksPage(mockEnv, "job-1", { limit: 5 });
    const [query, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(query).not.toContain("state = $2");
    expect(params).toEqual(["job-1", 5]);
  });
});

describe("updateTrackMatch", () => {
  it("updates a single row's match fields", async () => {
    mockQuery.mockResolvedValueOnce([]);
    await updateTrackMatch(mockEnv, "job-1", 3, {
      state: "matched",
      match_method: "isrc",
      confidence: 0.95,
      dest_track_id: "td-1",
    });
    const [query, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(query).toContain("UPDATE copy_job_tracks");
    expect(params).toEqual(["job-1", 3, "matched", "isrc", 0.95, "td-1", null, null]);
  });

  it("persists candidates as JSON on rejection", async () => {
    mockQuery.mockResolvedValueOnce([]);
    const candidates = [{ id: "td-2", title: "T", artist: "A", album: null, duration_ms: null }];
    await updateTrackMatch(mockEnv, "job-1", 4, {
      state: "unmatched",
      reason: "fuzzy_below_threshold",
      candidates,
    });
    const [, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(params[6]).toBe(JSON.stringify(candidates));
    expect(params[7]).toBe("fuzzy_below_threshold");
  });
});

describe("updateTracksState", () => {
  it("batch-flips a set of positions to a new state", async () => {
    mockQuery.mockResolvedValueOnce([]);
    await updateTracksState(mockEnv, "job-1", [1, 2, 3], "written");
    const [query, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(query).toContain("UPDATE copy_job_tracks");
    expect(query).toContain("position = ANY($2)");
    expect(params).toEqual(["job-1", [1, 2, 3], "written", null]);
  });

  it("persists an optional reason (e.g. already_present)", async () => {
    mockQuery.mockResolvedValueOnce([]);
    await updateTracksState(mockEnv, "job-1", [5], "skipped", "already_present");
    const [, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(params).toEqual(["job-1", [5], "skipped", "already_present"]);
  });
});
