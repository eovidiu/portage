// T-011: GET /sync/runs route tests
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Env } from "../../../src/env";

vi.mock("../../../src/db/sync_runs");

import { getRecentRuns } from "../../../src/db/sync_runs";

const mockGetRecentRuns = vi.mocked(getRecentRuns);

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
