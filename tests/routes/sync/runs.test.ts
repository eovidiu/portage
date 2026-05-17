// T-011: GET /sync/runs route tests
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Env } from "../../../src/env";

vi.mock("../../../src/db/sync_runs");

import {
  getRecentRuns,
  listRunTracks,
  runExists,
  type RunTrackRow,
} from "../../../src/db/sync_runs";

const mockGetRecentRuns = vi.mocked(getRecentRuns);
const mockListRunTracks = vi.mocked(listRunTracks);
const mockRunExists = vi.mocked(runExists);

const VALID_RUN_ID = "8e2f39ae-d1f2-4009-abc4-0738284b2ea9";

const MATCHED_ROW: RunTrackRow = {
  spotify_id: "0123456789abcdefghijkl",
  title: "Watermelon Sugar",
  artist: "Harry Styles",
  album: "Fine Line",
  isrc: "USSM12000001",
  status: "matched",
  tidal_id: "12345678",
  method: "isrc",
  confidence: 1.0,
};

const UNMATCHED_ROW: RunTrackRow = {
  spotify_id: "abcdefghij0123456789kl",
  title: "Some Track",
  artist: "Some Artist",
  album: null,
  isrc: null,
  status: "unmatched",
  reason: "no_candidates",
};

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    DATABASE_URL: "postgresql://test",
    JWT_SECRET: "test-jwt-secret-32-bytes-long-ok!",
    TOKEN_ENCRYPTION_KEY: "dGVzdC1lbmNyeXB0aW9uLWtleS0zMmJ5dGVzLWxvbmc=",
    SPOTIFY_CLIENT_ID: "test-spotify-client-id",
    SPOTIFY_CLIENT_SECRET: "test-spotify-client-secret",
    SPOTIFY_REDIRECT_URI: "https://portage.eovidiu.co.uk/auth/spotify/callback",
    TIDAL_CLIENT_ID: "tidal-client-id",
    TIDAL_CLIENT_SECRET: "tidal-client-secret",
    TIDAL_REDIRECT_URI: "https://portage.eovidiu.co.uk/auth/tidal/callback",
    TIDAL_COUNTRY_CODE: "RO",
    TIDAL_PLAYLIST_TITLE: "Spotify Liked",
    ...overrides,
  };
}

async function doFetch(path: string, testEnv: Env = makeEnv()) {
  const { default: runsRoute } = await import("../../../src/routes/sync/runs");
  const { Hono } = await import("hono");
  const app = new Hono<{ Bindings: Env }>();
  app.route("/sync", runsRoute);

  const ctx = createExecutionContext();
  const req = new Request(`https://worker.test${path}`);
  const res = await app.fetch(req, testEnv, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

function makeRun(i: number) {
  return {
    run_id: `run-${i}`,
    started_at: `2026-04-26T0${i % 10}:00:00Z`,
    finished_at: `2026-04-26T0${i % 10}:01:00Z`,
    status: "succeeded" as const,
    tracks_seen: 10,
    matched_isrc: 8,
    matched_fuzzy: 1,
    unmatched: 1,
    errors: 0,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// T-011-08: GET /sync/runs respects limit
describe("T-011-08: GET /sync/runs?limit=10 — respects limit", () => {
  it("returns exactly 10 runs when limit=10 is requested", async () => {
    const rows = Array.from({ length: 10 }, (_, i) => makeRun(i));
    mockGetRecentRuns.mockResolvedValueOnce(rows);

    const res = await doFetch("/sync/runs?limit=10");
    expect(res.status).toBe(200);
    const body = await res.json() as { runs: unknown[] };
    expect(body.runs).toHaveLength(10);
    expect(mockGetRecentRuns).toHaveBeenCalledWith(expect.anything(), 10);
  });
});

// T-011-09: GET /sync/runs caps limit at 100
describe("T-011-09: GET /sync/runs — caps limit at 100", () => {
  it("coerces limit=500 to 100 silently", async () => {
    const rows = Array.from({ length: 100 }, (_, i) => makeRun(i));
    mockGetRecentRuns.mockResolvedValueOnce(rows);

    const res = await doFetch("/sync/runs?limit=500");
    expect(res.status).toBe(200);
    expect(mockGetRecentRuns).toHaveBeenCalledWith(expect.anything(), 100);
  });
});

// Default limit
describe("T-011: GET /sync/runs — default limit 20", () => {
  it("uses limit=20 when no limit param provided", async () => {
    mockGetRecentRuns.mockResolvedValueOnce([]);

    const res = await doFetch("/sync/runs");
    expect(res.status).toBe(200);
    expect(mockGetRecentRuns).toHaveBeenCalledWith(expect.anything(), 20);
  });
});

// T-011: response shape
describe("T-011: GET /sync/runs — response shape", () => {
  it("wraps runs in {runs: [...]} object", async () => {
    mockGetRecentRuns.mockResolvedValueOnce([makeRun(1)]);

    const res = await doFetch("/sync/runs?limit=1");
    const body = await res.json() as Record<string, unknown>;
    expect(Object.keys(body)).toContain("runs");
    expect(Array.isArray(body.runs)).toBe(true);
  });
});

// T-011: DB error returns 503
describe("T-011: GET /sync/runs — DB error", () => {
  it("returns 503 when database is unreachable", async () => {
    mockGetRecentRuns.mockRejectedValueOnce(new Error("Connection refused"));

    const res = await doFetch("/sync/runs");
    expect(res.status).toBe(503);
  });
});

// Coverage: NaN limit falls back to default
describe("T-011: GET /sync/runs — non-numeric limit falls back to default", () => {
  it("uses default limit=20 when limit param is non-numeric", async () => {
    mockGetRecentRuns.mockResolvedValueOnce([]);
    const res = await doFetch("/sync/runs?limit=abc");
    expect(res.status).toBe(200);
    expect(mockGetRecentRuns).toHaveBeenCalledWith(expect.anything(), 20);
  });
});

// ============ T-027: GET /sync/runs/:run_id/tracks ============

describe("T-027-01: run with only matched tracks", () => {
  it("returns 200 with every row carrying status=matched + tidal_id/method/confidence", async () => {
    mockRunExists.mockResolvedValueOnce(true);
    mockListRunTracks.mockResolvedValueOnce({
      total: 2,
      items: [MATCHED_ROW, { ...MATCHED_ROW, spotify_id: "second" }],
    });

    const res = await doFetch(`/sync/runs/${VALID_RUN_ID}/tracks`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { total: number; items: RunTrackRow[] };
    expect(body.total).toBe(2);
    expect(body.items).toHaveLength(2);
    expect(body.items.every((r) => r.status === "matched")).toBe(true);
  });
});

describe("T-027-02: run with mixed matched + unmatched", () => {
  it("returns both row types distinguished by the status field", async () => {
    mockRunExists.mockResolvedValueOnce(true);
    mockListRunTracks.mockResolvedValueOnce({
      total: 2,
      items: [MATCHED_ROW, UNMATCHED_ROW],
    });

    const res = await doFetch(`/sync/runs/${VALID_RUN_ID}/tracks`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: RunTrackRow[] };

    const matched = body.items.find((r) => r.status === "matched");
    const unmatched = body.items.find((r) => r.status === "unmatched");
    expect(matched).toBeDefined();
    expect(unmatched).toBeDefined();
    expect("tidal_id" in matched!).toBe(true);
    expect("reason" in unmatched!).toBe(true);
  });
});

describe("T-027-03: status filter narrows the response", () => {
  it("forwards status=unmatched to the helper", async () => {
    mockRunExists.mockResolvedValueOnce(true);
    mockListRunTracks.mockResolvedValueOnce({ total: 1, items: [UNMATCHED_ROW] });

    const res = await doFetch(`/sync/runs/${VALID_RUN_ID}/tracks?status=unmatched`);
    expect(res.status).toBe(200);
    expect(mockListRunTracks).toHaveBeenCalledWith(
      expect.anything(),
      VALID_RUN_ID,
      expect.objectContaining({ status: "unmatched" }),
    );
  });
});

describe("T-027-04: method filter narrows matched rows", () => {
  it("forwards method=fuzzy to the helper", async () => {
    mockRunExists.mockResolvedValueOnce(true);
    mockListRunTracks.mockResolvedValueOnce({ total: 0, items: [] });

    await doFetch(`/sync/runs/${VALID_RUN_ID}/tracks?status=matched&method=fuzzy`);
    expect(mockListRunTracks).toHaveBeenCalledWith(
      expect.anything(),
      VALID_RUN_ID,
      expect.objectContaining({ status: "matched", method: "fuzzy" }),
    );
  });
});

describe("T-027-05: pagination", () => {
  it("forwards limit + offset to the helper", async () => {
    mockRunExists.mockResolvedValueOnce(true);
    mockListRunTracks.mockResolvedValueOnce({ total: 100, items: [] });

    await doFetch(`/sync/runs/${VALID_RUN_ID}/tracks?limit=20&offset=20`);
    expect(mockListRunTracks).toHaveBeenCalledWith(
      expect.anything(),
      VALID_RUN_ID,
      expect.objectContaining({ limit: 20, offset: 20 }),
    );
  });
});

describe("T-027-06: limit ceiling", () => {
  it("clamps limit=500 to 200", async () => {
    mockRunExists.mockResolvedValueOnce(true);
    mockListRunTracks.mockResolvedValueOnce({ total: 0, items: [] });

    await doFetch(`/sync/runs/${VALID_RUN_ID}/tracks?limit=500`);
    expect(mockListRunTracks).toHaveBeenCalledWith(
      expect.anything(),
      VALID_RUN_ID,
      expect.objectContaining({ limit: 200 }),
    );
  });
});

describe("T-027-07: unknown run id", () => {
  it("returns 404 run_not_found when sync_runs has no matching row", async () => {
    mockRunExists.mockResolvedValueOnce(false);

    const res = await doFetch(`/sync/runs/${VALID_RUN_ID}/tracks`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({ error: "run_not_found" });
    expect(mockListRunTracks).not.toHaveBeenCalled();
  });

  it("returns 404 immediately without DB lookup when run_id is not a UUID", async () => {
    const res = await doFetch(`/sync/runs/not-a-uuid/tracks`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({ error: "run_not_found" });
    expect(mockRunExists).not.toHaveBeenCalled();
    expect(mockListRunTracks).not.toHaveBeenCalled();
  });
});

describe("T-027-08: run with zero tracks", () => {
  it("returns 200 with {total: 0, items: []} — distinct from 404", async () => {
    mockRunExists.mockResolvedValueOnce(true);
    mockListRunTracks.mockResolvedValueOnce({ total: 0, items: [] });

    const res = await doFetch(`/sync/runs/${VALID_RUN_ID}/tracks`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { total: number; items: unknown[] };
    expect(body).toEqual({ total: 0, items: [] });
  });
});

describe("T-027: defaults", () => {
  it("defaults to status=all, limit=50, offset=0 when no params", async () => {
    mockRunExists.mockResolvedValueOnce(true);
    mockListRunTracks.mockResolvedValueOnce({ total: 0, items: [] });

    await doFetch(`/sync/runs/${VALID_RUN_ID}/tracks`);
    expect(mockListRunTracks).toHaveBeenCalledWith(
      expect.anything(),
      VALID_RUN_ID,
      expect.objectContaining({ status: "all", limit: 50, offset: 0, method: undefined }),
    );
  });

  it("ignores unknown status values and falls back to all", async () => {
    mockRunExists.mockResolvedValueOnce(true);
    mockListRunTracks.mockResolvedValueOnce({ total: 0, items: [] });

    await doFetch(`/sync/runs/${VALID_RUN_ID}/tracks?status=bogus`);
    expect(mockListRunTracks).toHaveBeenCalledWith(
      expect.anything(),
      VALID_RUN_ID,
      expect.objectContaining({ status: "all" }),
    );
  });
});

// ============ T-027a: candidates surface on unmatched rows ============

describe("T-027a-03: unmatched row with persisted candidates surfaces them", () => {
  it("response carries the candidates array verbatim", async () => {
    const candidates = [
      { tidal_id: "1", title: "Yesterday A", artist: "Wrong A", album: null, score: 0.84 },
      { tidal_id: "2", title: "Yesterday B", artist: "Wrong B", album: null, score: 0.81 },
      { tidal_id: "3", title: "Yesterday C", artist: "Wrong C", album: null, score: 0.74 },
    ];
    const unmatchedWithCandidates: RunTrackRow = {
      ...(UNMATCHED_ROW as Extract<RunTrackRow, { status: "unmatched" }>),
      reason: "fuzzy_below_threshold",
      candidates,
    };
    mockRunExists.mockResolvedValueOnce(true);
    mockListRunTracks.mockResolvedValueOnce({ total: 1, items: [unmatchedWithCandidates] });

    const res = await doFetch(`/sync/runs/${VALID_RUN_ID}/tracks`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<Record<string, unknown>> };
    expect(body.items[0]).toMatchObject({
      status: "unmatched",
      reason: "fuzzy_below_threshold",
      candidates,
    });
  });
});

describe("T-027a-04: unmatched row without persisted candidates omits the key", () => {
  it("response row carries no candidates field (key absent)", async () => {
    mockRunExists.mockResolvedValueOnce(true);
    mockListRunTracks.mockResolvedValueOnce({ total: 1, items: [UNMATCHED_ROW] });

    const res = await doFetch(`/sync/runs/${VALID_RUN_ID}/tracks`);
    const body = (await res.json()) as { items: Array<Record<string, unknown>> };
    expect("candidates" in body.items[0]).toBe(false);
  });
});

describe("T-027a-05: matched rows never carry candidates", () => {
  it("matched rows in the response omit the candidates key", async () => {
    mockRunExists.mockResolvedValueOnce(true);
    mockListRunTracks.mockResolvedValueOnce({
      total: 2,
      items: [MATCHED_ROW, UNMATCHED_ROW],
    });

    const res = await doFetch(`/sync/runs/${VALID_RUN_ID}/tracks`);
    const body = (await res.json()) as { items: Array<Record<string, unknown>> };
    const matched = body.items.find((r) => r.status === "matched")!;
    expect("candidates" in matched).toBe(false);
  });
});
