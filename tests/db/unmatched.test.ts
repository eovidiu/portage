import { describe, it, expect, vi, beforeEach } from "vitest";

const mockSql = vi.fn();
vi.mock("@neondatabase/serverless", () => ({
  neon: () => mockSql,
}));

import { upsertUnmatched, getUnmatchedCount, markSkipped, markMatched } from "../../src/db/unmatched";

const mockEnv = { DATABASE_URL: "postgresql://test" } as never;

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

// F-012-R10: status='skipped' is set ONLY via the manual route
// (POST /unmatched/:id/skip → markSkipped). No automatic eviction is
// implemented — the system relies on operator/iOS manual intervention.
describe("markSkipped — DB SQL emission (F-012-R10)", () => {
  it("issues UPDATE setting status='skipped' guarded by status='pending'", async () => {
    mockSql.mockResolvedValueOnce([]);
    const result = await markSkipped(mockEnv, "spX");

    expect(mockSql).toHaveBeenCalledOnce();
    const [query, params] = mockSql.mock.calls[0] as [string, unknown[]];
    expect(query).toContain("UPDATE unmatched");
    expect(query).toContain("status = 'skipped'");
    expect(query).toContain("status = 'pending'");
    expect(params).toEqual(["spX"]);
    expect(result).toEqual({ spotify_id: "spX", status: "skipped" });
  });

  it("returns the same shape on idempotent call (no-op when already skipped)", async () => {
    // The SQL guards on status='pending'; if the row is already skipped, the
    // UPDATE matches zero rows and we still return the canonical result.
    mockSql.mockResolvedValueOnce([]);
    const result = await markSkipped(mockEnv, "alreadySkipped");
    expect(result).toEqual({ spotify_id: "alreadySkipped", status: "skipped" });
  });
});

// F-012-R7/R8: manual match writes matches row + transitions unmatched
// status='matched' atomically (transaction).
describe("markMatched — atomic transaction (F-012-R8)", () => {
  it("runs both INSERT INTO matches and UPDATE unmatched inside sql.transaction", async () => {
    const txCalls: Array<[string, unknown[]]> = [];
    const txSql = vi.fn().mockImplementation((q: string, p: unknown[]) => {
      txCalls.push([q, p]);
      return Promise.resolve([]);
    });
    const mockTransaction = vi.fn().mockImplementation((cb: (s: typeof txSql) => unknown[]) => {
      cb(txSql);
      return Promise.resolve([]);
    });
    (mockSql as unknown as Record<string, unknown>).transaction = mockTransaction;

    const result = await markMatched(mockEnv, "spX", "tdX");

    expect(mockTransaction).toHaveBeenCalledOnce();
    expect(txCalls).toHaveLength(2);
    expect(txCalls[0][0]).toContain("INSERT INTO matches");
    expect(txCalls[0][1]).toEqual(["spX", "tdX"]);
    expect(txCalls[1][0]).toContain("UPDATE unmatched");
    expect(txCalls[1][0]).toContain("status = 'matched'");
    expect(txCalls[1][1]).toEqual(["spX"]);
    expect(result.spotify_id).toBe("spX");
    expect(result.tidal_id).toBe("tdX");
    expect(result.method).toBe("manual");
  });
});
