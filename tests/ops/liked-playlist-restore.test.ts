import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Env } from "../../src/env";

const mockSql = vi.fn();
vi.mock("@neondatabase/serverless", () => ({ neon: () => mockSql }));
vi.mock("../../src/providers/tidal/client", () => ({ tidalFetch: vi.fn() }));

import { runLikedCleanupTick } from "../../src/ops/liked-playlist-restore";
import { tidalFetch } from "../../src/providers/tidal/client";

const mockTidalFetch = vi.mocked(tidalFetch);
const mockEnv = { DATABASE_URL: "postgresql://test" } as Env;
const PLAYLIST = "tidal-liked-1";

// Routes the module's Neon calls by SQL shape.
function setupSql(opts: { done?: string | null; cursor?: string | null; foreign?: string[] }) {
  const writes: Array<[string, string]> = [];
  mockSql.mockImplementation((sql: string, params: unknown[]) => {
    if (/SELECT value FROM sync_state/.test(sql)) {
      const key = (params as string[])[0];
      if (key === "liked_cleanup_done") {
        return Promise.resolve(opts.done != null ? [{ value: opts.done }] : []);
      }
      return Promise.resolve(opts.cursor != null ? [{ value: opts.cursor }] : []);
    }
    if (/SELECT m\.tidal_id/.test(sql)) {
      return Promise.resolve((opts.foreign ?? []).map((id) => ({ tidal_id: id })));
    }
    if (/INSERT INTO sync_state/.test(sql)) {
      writes.push([(params as string[])[0], (params as string[])[1]]);
      return Promise.resolve([]);
    }
    return Promise.resolve([]);
  });
  return writes;
}

function itemsPage(
  refs: Array<{ id: string; itemId?: string; itemCursor?: string }>,
  nextCursor: string | null,
): Response {
  return new Response(
    JSON.stringify({
      data: refs.map((r) => ({
        id: r.id,
        type: "tracks",
        meta: { itemId: r.itemId ?? `item-${r.id}`, itemCursor: r.itemCursor ?? `cur-${r.id}` },
      })),
      links: nextCursor ? { meta: { nextCursor } } : {},
    }),
    { status: 200 },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("runLikedCleanupTick", () => {
  it("short-circuits without network calls when the done marker is set", async () => {
    setupSql({ done: "1" });
    const result = await runLikedCleanupTick(mockEnv, PLAYLIST);
    expect(result.outcome).toBe("done_marker_present");
    expect(mockTidalFetch).not.toHaveBeenCalled();
  });

  it("pure-scan tick (budget exhausted mid-playlist) advances the cursor to the last kept item's itemCursor", async () => {
    vi.useFakeTimers();
    try {
      const writes = setupSql({ foreign: ["F1"] });
      // 35 pages of kept items, every page pointing at another — budget stops the scan.
      let page = 0;
      mockTidalFetch.mockImplementation(async () => {
        page++;
        return itemsPage([{ id: `K${page}`, itemCursor: `cur-K${page}` }], `next-${page}`);
      });

      const promise = runLikedCleanupTick(mockEnv, PLAYLIST);
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result).toEqual({ outcome: "scan_advanced", pagesScanned: 35, deleted: 0 });
      // Anchors on the page-level nextCursor — the only value page[cursor]
      // accepts (an item-level itemCursor gets HTTP 400 from Tidal).
      expect(writes).toContainEqual(["liked_cleanup_cursor", "next-35"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears the cursor and exits when Tidal answers 400 to a persisted cursor", async () => {
    const writes = setupSql({ cursor: "stale-cursor", foreign: ["F1"] });
    mockTidalFetch.mockResolvedValueOnce(new Response("", { status: 400 }));

    const result = await runLikedCleanupTick(mockEnv, PLAYLIST);

    expect(result).toEqual({ outcome: "scan_advanced", pagesScanned: 0, deleted: 0 });
    expect(writes).toContainEqual(["liked_cleanup_cursor", ""]);
    expect(writes.find(([k]) => k === "liked_cleanup_done")).toBeUndefined();
  });

  it("stops the scan gracefully on a 429 and leaves the cursor untouched when nothing was scanned", async () => {
    const writes = setupSql({ cursor: "resume-here", foreign: ["F1"] });
    mockTidalFetch.mockResolvedValueOnce(new Response("", { status: 429 }));

    const result = await runLikedCleanupTick(mockEnv, PLAYLIST);

    expect(result).toEqual({ outcome: "scan_advanced", pagesScanned: 0, deleted: 0 });
    expect(writes.find(([k]) => k === "liked_cleanup_cursor")).toBeUndefined();
    expect(writes.find(([k]) => k === "liked_cleanup_done")).toBeUndefined();
  });

  it("processes items found before a mid-scan 429 and keeps the incoming cursor after deleting", async () => {
    vi.useFakeTimers();
    try {
      const writes = setupSql({ cursor: "resume-here", foreign: ["F1"] });
      mockTidalFetch
        .mockResolvedValueOnce(itemsPage([{ id: "F1" }], "next-1"))
        .mockResolvedValueOnce(new Response("", { status: 429 })) // scan stops here
        .mockResolvedValueOnce(new Response("", { status: 200 })); // DELETE

      const promise = runLikedCleanupTick(mockEnv, PLAYLIST);
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result.outcome).toBe("deleted");
      expect(result.deleted).toBe(1);
      expect(writes.find(([k]) => k === "liked_cleanup_cursor")).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("deletes foreign items with the OAS remove payload and does NOT advance the cursor", async () => {
    const writes = setupSql({ cursor: "resume-here", foreign: ["F1", "F2"] });
    mockTidalFetch
      .mockResolvedValueOnce(itemsPage([{ id: "K1" }, { id: "F1" }, { id: "F2" }], null))
      .mockResolvedValueOnce(new Response("", { status: 200 })); // DELETE

    const result = await runLikedCleanupTick(mockEnv, PLAYLIST);

    expect(result.outcome).toBe("deleted");
    expect(result.deleted).toBe(2);
    // First call is the page read with the resume cursor.
    expect(mockTidalFetch.mock.calls[0][1]).toContain("page[cursor]=resume-here");
    // Second call is the DELETE with { id, type, meta: { itemId } } entries.
    const [, , init] = mockTidalFetch.mock.calls[1] as [Env, string, RequestInit];
    expect(init.method).toBe("DELETE");
    expect(JSON.parse(init.body as string)).toEqual({
      data: [
        { id: "F1", type: "tracks", meta: { itemId: "item-F1" } },
        { id: "F2", type: "tracks", meta: { itemId: "item-F2" } },
      ],
    });
    expect(writes.find(([k]) => k === "liked_cleanup_cursor")).toBeUndefined();
  });

  it("splits more than 20 found items across DELETE batches", async () => {
    setupSql({ foreign: Array.from({ length: 25 }, (_, i) => `F${i}`) });
    mockTidalFetch
      .mockResolvedValueOnce(
        itemsPage(Array.from({ length: 25 }, (_, i) => ({ id: `F${i}` })), null),
      )
      .mockResolvedValueOnce(new Response("", { status: 200 }))
      .mockResolvedValueOnce(new Response("", { status: 200 }));

    const result = await runLikedCleanupTick(mockEnv, PLAYLIST);

    expect(result.deleted).toBe(25);
    const deleteCalls = mockTidalFetch.mock.calls.filter(
      (c) => (c[2] as RequestInit | undefined)?.method === "DELETE",
    );
    expect(deleteCalls).toHaveLength(2);
  });

  it("writes the done marker when a scan reaches the end with nothing found", async () => {
    const writes = setupSql({ foreign: ["F1"] });
    mockTidalFetch.mockResolvedValueOnce(itemsPage([{ id: "K1" }], null));

    const result = await runLikedCleanupTick(mockEnv, PLAYLIST);

    expect(result.outcome).toBe("complete");
    expect(writes).toContainEqual(["liked_cleanup_done", "1"]);
  });

  it("stops scanning at the page budget", async () => {
    vi.useFakeTimers();
    try {
      setupSql({ foreign: ["F-never"] });
      mockTidalFetch.mockImplementation(async () => itemsPage([{ id: "K" }], "more"));

      const promise = runLikedCleanupTick(mockEnv, PLAYLIST);
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result.outcome).toBe("scan_advanced");
      expect(result.pagesScanned).toBe(35);
    } finally {
      vi.useRealTimers();
    }
  });
});
