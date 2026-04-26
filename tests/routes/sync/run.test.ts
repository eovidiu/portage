import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import type { Env } from "../../../src/env";

vi.mock("../../../src/sync/orchestrator", () => ({
  runSync: vi.fn(),
}));

vi.mock("../../../src/db/sync_runs", () => ({
  getLatestRun: vi.fn(),
}));

import syncRunRoute from "../../../src/routes/sync/run";
import { runSync } from "../../../src/sync/orchestrator";
import { getLatestRun } from "../../../src/db/sync_runs";

const mockRunSync = runSync as ReturnType<typeof vi.fn>;
const mockGetLatestRun = getLatestRun as ReturnType<typeof vi.fn>;

function makeApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.route("/sync", syncRunRoute);
  return app;
}

function makeEnv(): Env {
  return {
    DATABASE_URL: "postgresql://test",
    JWT_SECRET: "test-secret-that-is-at-least-32-bytes-long!!",
    TOKEN_ENCRYPTION_KEY: btoa(String.fromCharCode(...new Array(32).fill(0x42))),
    SPOTIFY_CLIENT_ID: "",
    SPOTIFY_CLIENT_SECRET: "",
    SPOTIFY_REDIRECT_URI: "",
    TIDAL_CLIENT_ID: "",
    TIDAL_CLIENT_SECRET: "",
    TIDAL_REDIRECT_URI: "",
    TIDAL_COUNTRY_CODE: "RO",
    TIDAL_PLAYLIST_TITLE: "Spotify Liked",
  };
}

beforeEach(() => {
  vi.resetAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// T-010-06: Manual POST /sync/run requires JWT
// Note: JWT enforcement is via jwtMiddleware in index.ts. The route itself
// does not enforce auth — tests without middleware verify route behaviour only.
// Auth enforcement is tested in tests/auth/auth.test.ts.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// T-010-07: Synchronous response when run finishes within 25 s
// ---------------------------------------------------------------------------
describe("T-010-07: 200 response when run completes within 25 s", () => {
  it("returns 200 with full result body when orchestrator resolves quickly", async () => {
    mockRunSync.mockResolvedValue({
      outcome: "succeeded",
      run_id: "run-007",
      tracks_seen: 12,
      matched_isrc: 10,
      matched_fuzzy: 1,
      unmatched: 1,
      errors: 0,
    });

    const app = makeApp();
    const res = await app.request("/sync/run", { method: "POST" }, makeEnv());

    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.run_id).toBe("run-007");
    expect(body.status).toBe("succeeded");
    expect(body.tracks_seen).toBe(12);
    expect(body.matched_isrc).toBe(10);
    expect(body.matched_fuzzy).toBe(1);
    expect(body.unmatched).toBe(1);
    expect(body.errors).toBe(0);
    expect(typeof body.duration_ms).toBe("number");
  });

  it("returns 200 with status=partial when orchestrator returns partial outcome", async () => {
    mockRunSync.mockResolvedValue({
      outcome: "partial",
      run_id: "run-008",
      errors: 2,
    });

    const app = makeApp();
    const res = await app.request("/sync/run", { method: "POST" }, makeEnv());

    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.status).toBe("partial");
    expect(body.run_id).toBe("run-008");
  });

  it("returns 200 with status=failed when orchestrator returns failed outcome", async () => {
    mockRunSync.mockResolvedValue({
      outcome: "failed",
      run_id: "run-009",
      error_code: "spotify_reauth_required",
    });

    const app = makeApp();
    const res = await app.request("/sync/run", { method: "POST" }, makeEnv());

    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.status).toBe("failed");
    expect(body.run_id).toBe("run-009");
  });
});

// ---------------------------------------------------------------------------
// T-010-08: 202 returned when run exceeds 25 s
// ---------------------------------------------------------------------------
describe("T-010-08: 202 Accepted when orchestrator exceeds 25 s", () => {
  it("returns 202 with run_id and status=running when 25s timer fires first", async () => {
    let resolveRunSync!: (v: unknown) => void;
    mockRunSync.mockReturnValue(new Promise((resolve) => { resolveRunSync = resolve; }));
    mockGetLatestRun.mockResolvedValue({
      run_id: "run-async-001",
      status: "running",
      started_at: new Date().toISOString(),
      finished_at: null,
      tracks_seen: 0,
      matched_isrc: 0,
      matched_fuzzy: 0,
      unmatched: 0,
      errors: 0,
      error_code: null,
    });

    vi.useFakeTimers();

    const app = makeApp();
    const resPromise = app.request("/sync/run", { method: "POST" }, makeEnv());

    await vi.advanceTimersByTimeAsync(25_001);
    const res = await resPromise;

    expect(res.status).toBe(202);
    const body = await res.json() as Record<string, unknown>;
    expect(body.run_id).toBe("run-async-001");
    expect(body.status).toBe("running");

    resolveRunSync({ outcome: "succeeded", run_id: "run-async-001" });
  });

  it("returns 202 with run_id=null when getLatestRun returns no running row", async () => {
    mockRunSync.mockReturnValue(new Promise(() => { /* never resolves */ }));
    mockGetLatestRun.mockResolvedValue(null);

    vi.useFakeTimers();

    const app = makeApp();
    const resPromise = app.request("/sync/run", { method: "POST" }, makeEnv());

    await vi.advanceTimersByTimeAsync(25_001);
    const res = await resPromise;

    expect(res.status).toBe(202);
    const body = await res.json() as Record<string, unknown>;
    expect(body.status).toBe("running");
    expect(body.run_id).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// T-010-09: 409 returned on lock contention
// ---------------------------------------------------------------------------
describe("T-010-09: 409 Conflict on lock contention", () => {
  it("returns 409 with error=run_in_progress and current_run_id when lock busy", async () => {
    mockRunSync.mockResolvedValue({ outcome: "skipped_locked" });
    mockGetLatestRun.mockResolvedValue({
      run_id: "run-in-progress-001",
      status: "running",
      started_at: new Date().toISOString(),
      finished_at: null,
      tracks_seen: 0,
      matched_isrc: 0,
      matched_fuzzy: 0,
      unmatched: 0,
      errors: 0,
      error_code: null,
    });

    const app = makeApp();
    const res = await app.request("/sync/run", { method: "POST" }, makeEnv());

    expect(res.status).toBe(409);
    const body = await res.json() as Record<string, unknown>;
    expect(body.error).toBe("run_in_progress");
    expect(body.current_run_id).toBe("run-in-progress-001");
  });

  it("returns 409 with current_run_id=null when no in-progress row found", async () => {
    mockRunSync.mockResolvedValue({ outcome: "skipped_locked" });
    mockGetLatestRun.mockResolvedValue(null);

    const app = makeApp();
    const res = await app.request("/sync/run", { method: "POST" }, makeEnv());

    expect(res.status).toBe(409);
    const body = await res.json() as Record<string, unknown>;
    expect(body.error).toBe("run_in_progress");
    expect(body.current_run_id).toBeNull();
  });
});
