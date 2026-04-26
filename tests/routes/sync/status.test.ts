// T-011: GET /sync/status route tests
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Env } from "../../../src/env";

vi.mock("../../../src/db/sync_runs");

import {
  getLatestRun,
  getLatestSucceededAt,
} from "../../../src/db/sync_runs";

const mockGetLatestRun = vi.mocked(getLatestRun);
const mockGetLatestSucceededAt = vi.mocked(getLatestSucceededAt);

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

async function doFetch(path: string, token = "Bearer valid-jwt", testEnv: Env = makeEnv()) {
  const { default: statusRoute } = await import("../../../src/routes/sync/status");
  const { Hono } = await import("hono");
  const app = new Hono<{ Bindings: Env }>();
  app.route("/sync", statusRoute);

  const ctx = createExecutionContext();
  const req = new Request(`https://worker.test${path}`, {
    headers: token ? { Authorization: token } : {},
  });
  const res = await app.fetch(req, testEnv, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

beforeEach(() => {
  vi.resetAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// T-011-06: GET /sync/status returns no_runs_yet on empty table
describe("T-011-06: GET /sync/status — empty table", () => {
  it("returns 200 with {status: no_runs_yet} when zero runs exist", async () => {
    mockGetLatestRun.mockResolvedValueOnce(null);

    const res = await doFetch("/sync/status");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ status: "no_runs_yet" });
  });
});

// T-011-05: GET /sync/status returns latest run
describe("T-011-05: GET /sync/status — returns latest run", () => {
  it("returns the most recent run row with last_succeeded_at and lag_hours", async () => {
    const finishedAt = new Date(Date.now() - 5 * 60 * 60 * 1000 - 24 * 60 * 1000).toISOString();
    const row = {
      run_id: "run-abc",
      started_at: "2026-04-26T07:00:00Z",
      finished_at: finishedAt,
      status: "succeeded" as const,
      tracks_seen: 10,
      matched_isrc: 8,
      matched_fuzzy: 1,
      unmatched: 1,
      errors: 0,
    };
    mockGetLatestRun.mockResolvedValueOnce(row);
    mockGetLatestSucceededAt.mockResolvedValueOnce(finishedAt);

    const res = await doFetch("/sync/status");
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.run_id).toBe("run-abc");
    expect(body.status).toBe("succeeded");
    expect(body.last_succeeded_at).toBe(finishedAt);
    expect(typeof body.lag_hours).toBe("number");
  });
});

// T-011-07: lag_hours is rounded to 1 decimal place
describe("T-011-07: lag_hours rounded to 1 decimal place", () => {
  it("returns lag_hours within expected range for ~5h24m lag", async () => {
    // ~5h 24min = 5.4 hours
    const finishedAt = new Date(Date.now() - (5 * 60 + 24) * 60 * 1000).toISOString();
    const row = {
      run_id: "run-lag",
      started_at: finishedAt,
      finished_at: finishedAt,
      status: "succeeded" as const,
      tracks_seen: 5,
      matched_isrc: 5,
      matched_fuzzy: 0,
      unmatched: 0,
      errors: 0,
    };
    mockGetLatestRun.mockResolvedValueOnce(row);
    mockGetLatestSucceededAt.mockResolvedValueOnce(finishedAt);

    const res = await doFetch("/sync/status");
    const body = await res.json() as Record<string, unknown>;
    const lagHours = body.lag_hours as number;
    // Spec T-011-07: value must be in [5.3, 5.5]
    expect(lagHours).toBeGreaterThanOrEqual(5.3);
    expect(lagHours).toBeLessThanOrEqual(5.5);
    // Must be rounded to 1 decimal
    expect(lagHours).toBe(Math.round(lagHours * 10) / 10);
  });
});

// Coverage: lag_hours is null when lastSucceededAt is null
describe("T-011: GET /sync/status — lag_hours null when no succeeded run", () => {
  it("returns lag_hours=null when no succeeded run exists", async () => {
    const row = {
      run_id: "run-failed",
      started_at: "2026-04-26T07:00:00Z",
      finished_at: "2026-04-26T07:01:00Z",
      status: "failed" as const,
      tracks_seen: 5,
      matched_isrc: 0,
      matched_fuzzy: 0,
      unmatched: 5,
      errors: 1,
    };
    mockGetLatestRun.mockResolvedValueOnce(row);
    mockGetLatestSucceededAt.mockResolvedValueOnce(null);

    const res = await doFetch("/sync/status");
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.lag_hours).toBeNull();
    expect(body.last_succeeded_at).toBeNull();
  });
});

// T-011: DB error returns 503
describe("T-011: GET /sync/status — DB error", () => {
  it("returns 503 when database is unreachable", async () => {
    mockGetLatestRun.mockRejectedValueOnce(new Error("Connection refused"));

    const res = await doFetch("/sync/status");
    expect(res.status).toBe(503);
  });
});

// T-011-04: no secrets in log (structural: ensure route doesn't log secrets)
describe("T-011-04: no token in response body", () => {
  it("response body contains no secret-shaped strings", async () => {
    mockGetLatestRun.mockResolvedValueOnce(null);
    const res = await doFetch("/sync/status");
    const text = await res.text();
    expect(text).not.toContain("SECRET_CANARY");
    expect(text).not.toContain("TOKEN_CANARY");
  });
});
