import { describe, it, expect, vi, beforeEach } from "vitest";

const mockSql = vi.fn();
vi.mock("@neondatabase/serverless", () => ({
  neon: () => mockSql,
}));

import { upsertUnmatched, getUnmatchedCount } from "../../src/db/unmatched";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("upsertUnmatched", () => {
  it("executes INSERT ... ON CONFLICT with correct parameters", async () => {
    mockSql.mockResolvedValueOnce([]);
    await upsertUnmatched(mockSql as never, { spotify_id: "sp1", reason: "no_candidates" });

    expect(mockSql).toHaveBeenCalledOnce();
    const [query, params] = mockSql.mock.calls[0] as [string, unknown[]];
    expect(query).toContain("INSERT INTO unmatched");
    expect(query).toContain("ON CONFLICT");
    expect(params[0]).toBe("sp1");
    expect(params[1]).toBe("no_candidates");
  });

  it("upsert increments attempts on conflict", async () => {
    mockSql.mockResolvedValueOnce([]);
    await upsertUnmatched(mockSql as never, { spotify_id: "sp2", reason: "fuzzy_below_threshold" });
    const [query] = mockSql.mock.calls[0] as [string];
    expect(query).toContain("attempts + 1");
  });

  it("upsert only updates when status = 'pending'", async () => {
    mockSql.mockResolvedValueOnce([]);
    await upsertUnmatched(mockSql as never, { spotify_id: "sp3", reason: "no_candidates" });
    const [query] = mockSql.mock.calls[0] as [string];
    expect(query).toContain("WHERE unmatched.status = 'pending'");
  });
});

describe("getUnmatchedCount", () => {
  it("returns count of pending unmatched rows", async () => {
    mockSql.mockResolvedValueOnce([{ n: 7 }]);
    const count = await getUnmatchedCount(mockSql as never);
    expect(count).toBe(7);
  });

  it("returns 0 when no rows exist", async () => {
    mockSql.mockResolvedValueOnce([]);
    const count = await getUnmatchedCount(mockSql as never);
    expect(count).toBe(0);
  });
});
