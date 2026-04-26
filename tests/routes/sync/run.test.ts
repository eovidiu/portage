import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { Env } from "../../../src/env";

vi.mock("../../../src/sync/orchestrator", () => ({
  runSync: vi.fn(),
}));

import syncRunRoute from "../../../src/routes/sync/run";
import { runSync } from "../../../src/sync/orchestrator";

const mockRunSync = runSync as ReturnType<typeof vi.fn>;

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

describe("POST /sync/run — F-009 HTTP handler", () => {
  it("returns 200 with outcome=succeeded on success", async () => {
    mockRunSync.mockResolvedValue({ outcome: "succeeded", run_id: "run-001" });

    const app = makeApp();
    const res = await app.request("/sync/run", { method: "POST" }, makeEnv());

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.outcome).toBe("succeeded");
    expect(body.run_id).toBe("run-001");
  });

  it("returns 200 with outcome=partial on partial run", async () => {
    mockRunSync.mockResolvedValue({ outcome: "partial", run_id: "run-002", errors: 2 });

    const app = makeApp();
    const res = await app.request("/sync/run", { method: "POST" }, makeEnv());

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.outcome).toBe("partial");
  });

  it("returns 409 when lock is busy (skipped_locked)", async () => {
    mockRunSync.mockResolvedValue({ outcome: "skipped_locked" });

    const app = makeApp();
    const res = await app.request("/sync/run", { method: "POST" }, makeEnv());

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.outcome).toBe("skipped_locked");
  });

  it("returns 200 with outcome=failed on hard failure", async () => {
    mockRunSync.mockResolvedValue({
      outcome: "failed",
      run_id: "run-003",
      error_code: "spotify_reauth_required",
    });

    const app = makeApp();
    const res = await app.request("/sync/run", { method: "POST" }, makeEnv());

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.outcome).toBe("failed");
    expect(body.error_code).toBe("spotify_reauth_required");
  });
});
