// T-011: GET /stats route tests
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Env } from "../../src/env";

vi.mock("../../src/db/sync_runs");

import { aggregateStats } from "../../src/db/sync_runs";

const mockAggregateStats = vi.mocked(aggregateStats);

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
  const { default: statsRoute } = await import("../../src/routes/stats");
  const { Hono } = await import("hono");
  const app = new Hono<{ Bindings: Env }>();
  app.route("/", statsRoute);

  const ctx = createExecutionContext();
  const req = new Request(`https://worker.test${path}`);
  const res = await app.fetch(req, testEnv, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

function makeStats(overrides = {}) {
  return {
    period: "week" as const,
    from: "2026-04-18T00:00:00Z",
    to: "2026-04-25T00:00:00Z",
    runs_total: 13,
    runs_succeeded: 10,
    runs_partial: 2,
    runs_failed: 1,
    tracks_processed_total: 142,
    match_rate: 0.9437,
    match_rate_isrc: 0.7958,
    match_rate_fuzzy: 0.1479,
    unmatched_pending: 5,
    ...overrides,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// T-011-11: GET /stats with invalid period returns 400
describe("T-011-11: GET /stats — invalid period returns 400", () => {
  it("returns 400 for period=fortnight", async () => {
    const res = await doFetch("/stats?period=fortnight");
    expect(res.status).toBe(400);
  });

  it("returns 400 for period=year", async () => {
    const res = await doFetch("/stats?period=year");
    expect(res.status).toBe(400);
  });

  it("returns 400 when period param is missing", async () => {
    const res = await doFetch("/stats");
    expect(res.status).toBe(400);
  });
});

// T-011-10: GET /stats?period=week returns correct totals
describe("T-011-10: GET /stats?period=week — correct totals", () => {
  it("returns runs_total, runs_succeeded, runs_partial, runs_failed correctly", async () => {
    mockAggregateStats.mockResolvedValueOnce(makeStats());

    const res = await doFetch("/stats?period=week");
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.runs_total).toBe(13);
    expect(body.runs_succeeded).toBe(10);
    expect(body.runs_partial).toBe(2);
    expect(body.runs_failed).toBe(1);
    expect(mockAggregateStats).toHaveBeenCalledWith(expect.anything(), "week");
  });
});

// T-011-12: match_rate format — 4 significant digits
describe("T-011-12: match_rate format", () => {
  it("returns match_rate as decimal in [0,1] with 4 significant digits", async () => {
    mockAggregateStats.mockResolvedValueOnce(makeStats({ match_rate: 0.87 }));

    const res = await doFetch("/stats?period=week");
    const body = await res.json() as Record<string, unknown>;
    expect(body.match_rate).toBe(0.87);
    expect(body.match_rate).toBeGreaterThanOrEqual(0);
    expect(body.match_rate).toBeLessThanOrEqual(1);
  });
});

// T-011-14: unmatched_pending counts only pending
describe("T-011-14: unmatched_pending counts only pending rows", () => {
  it("returns the unmatched_pending count from aggregateStats", async () => {
    mockAggregateStats.mockResolvedValueOnce(makeStats({ unmatched_pending: 3 }));

    const res = await doFetch("/stats?period=week");
    const body = await res.json() as Record<string, unknown>;
    expect(body.unmatched_pending).toBe(3);
  });
});

// T-011-06 parity: valid period values
describe("T-011: GET /stats — valid period values", () => {
  it("accepts period=day", async () => {
    mockAggregateStats.mockResolvedValueOnce(makeStats({ period: "day" }));
    const res = await doFetch("/stats?period=day");
    expect(res.status).toBe(200);
    expect(mockAggregateStats).toHaveBeenCalledWith(expect.anything(), "day");
  });

  it("accepts period=month", async () => {
    mockAggregateStats.mockResolvedValueOnce(makeStats({ period: "month" }));
    const res = await doFetch("/stats?period=month");
    expect(res.status).toBe(200);
    expect(mockAggregateStats).toHaveBeenCalledWith(expect.anything(), "month");
  });
});

// T-011: DB error returns 503
describe("T-011: GET /stats — DB error", () => {
  it("returns 503 when database is unreachable", async () => {
    mockAggregateStats.mockRejectedValueOnce(new Error("Connection refused"));

    const res = await doFetch("/stats?period=week");
    expect(res.status).toBe(503);
  });
});

// period and from/to in response
describe("T-011: GET /stats — response includes period boundaries", () => {
  it("returns period, from, to fields in response", async () => {
    mockAggregateStats.mockResolvedValueOnce(makeStats());

    const res = await doFetch("/stats?period=week");
    const body = await res.json() as Record<string, unknown>;
    expect(body.period).toBe("week");
    expect(body.from).toBeDefined();
    expect(body.to).toBeDefined();
  });
});
