import { describe, it, expect, vi, beforeEach } from "vitest";

const mockSql = vi.fn();
vi.mock("@neondatabase/serverless", () => ({
  neon: () => mockSql,
}));

import { insertMatch, findMatchedIds } from "../../src/db/matches";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("insertMatch", () => {
  it("executes INSERT with correct parameters", async () => {
    mockSql.mockResolvedValue([]);
    await insertMatch(mockSql as never, {
      spotify_id: "sp1",
      tidal_id: "td1",
      method: "isrc",
      confidence: 0.95,
      sync_run_id: "run-uuid",
    });
    const [query, params] = mockSql.mock.calls[0] as [string, unknown[]];
    expect(query).toContain("INSERT INTO matches");
    expect(params).toEqual(["sp1", "td1", "isrc", 0.95, "run-uuid"]);
  });

  it("accepts null sync_run_id", async () => {
    mockSql.mockResolvedValue([]);
    await insertMatch(mockSql as never, {
      spotify_id: "sp2",
      tidal_id: "td2",
      method: "isrc",
      confidence: 0.95,
      sync_run_id: null,
    });
    const [, params] = mockSql.mock.calls[0] as [string, unknown[]];
    expect(params[4]).toBeNull();
  });

  // I-001 invariant: matches and unmatched-pending must be mutually exclusive.
  // Without the second UPDATE, fuzzy-retry-after-ISRC-fail produces dual-
  // membership rows. Regression discovered 2026-05-04 (46 violations in prod).
  it("evicts the unmatched-pending row in the same call (I-001 enforcement)", async () => {
    mockSql.mockResolvedValue([]);
    await insertMatch(mockSql as never, {
      spotify_id: "spX",
      tidal_id: "tdX",
      method: "fuzzy",
      confidence: 0.92,
      sync_run_id: "run-9",
    });

    expect(mockSql).toHaveBeenCalledTimes(2);
    const [insertQuery] = mockSql.mock.calls[0] as [string, unknown[]];
    const [updateQuery, updateParams] = mockSql.mock.calls[1] as [string, unknown[]];
    expect(insertQuery).toContain("INSERT INTO matches");
    expect(updateQuery).toContain("UPDATE unmatched");
    expect(updateQuery).toContain("status = 'matched'");
    expect(updateQuery).toContain("status = 'pending'");
    expect(updateParams).toEqual(["spX"]);
  });
});

describe("findMatchedIds", () => {
  it("returns empty set for empty input without querying DB", async () => {
    const result = await findMatchedIds(mockSql as never, []);
    expect(result.size).toBe(0);
    expect(mockSql).not.toHaveBeenCalled();
  });

  it("returns set of matched spotify_ids", async () => {
    mockSql.mockResolvedValueOnce([{ spotify_id: "sp1" }, { spotify_id: "sp3" }]);
    const result = await findMatchedIds(mockSql as never, ["sp1", "sp2", "sp3"]);
    expect(result).toEqual(new Set(["sp1", "sp3"]));
  });

  it("passes spotify ids as array parameter to SQL", async () => {
    mockSql.mockResolvedValueOnce([]);
    await findMatchedIds(mockSql as never, ["a", "b"]);
    const [, params] = mockSql.mock.calls[0] as [string, unknown[][]];
    expect(params[0]).toEqual(["a", "b"]);
  });
});
