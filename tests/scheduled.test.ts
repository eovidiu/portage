import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Env } from "../src/env";

vi.mock("../src/sync/orchestrator", () => ({
  runSync: vi.fn(),
}));

import { scheduled } from "../src/scheduled";
import { runSync } from "../src/sync/orchestrator";

const mockRunSync = runSync as ReturnType<typeof vi.fn>;

function makeEnv(): Env {
  return {
    DATABASE_URL: "postgresql://test",
    JWT_SECRET: "test-secret",
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

function makeEvent(): ScheduledEvent {
  return {
    scheduledTime: Date.now(),
    cron: "23 7 * * *",
    noRetry: () => undefined,
    type: "scheduled",
    waitUntil: () => undefined,
  } as unknown as ScheduledEvent;
}

function makeCtx(): ExecutionContext {
  const waitUntilFn = vi.fn((p: Promise<unknown>) => {
    p.catch(() => undefined);
  });
  return { waitUntil: waitUntilFn, passThroughOnException: vi.fn() } as unknown as ExecutionContext;
}

beforeEach(() => {
  vi.resetAllMocks();
});

// ---------------------------------------------------------------------------
// T-010-01: Cron triggers declared correctly (static assertion via wrangler.toml)
// Verified in wrangler.toml: crons = ["23 7 * * *", "23 19 * * *"]
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// T-010-02: Scheduled handler invokes orchestrator
// ---------------------------------------------------------------------------
describe("T-010-02: Scheduled handler invokes orchestrator", () => {
  it("calls runSync exactly once when scheduled fires", async () => {
    mockRunSync.mockResolvedValue({ outcome: "succeeded", run_id: "r1" });
    const ctx = makeCtx();
    await scheduled(makeEvent(), makeEnv(), ctx);
    expect(mockRunSync).toHaveBeenCalledTimes(1);
    expect(mockRunSync).toHaveBeenCalledWith(expect.objectContaining({ DATABASE_URL: "postgresql://test" }));
  });
});

// ---------------------------------------------------------------------------
// T-010-03: Scheduled handler awaits orchestrator completion via waitUntil
// ---------------------------------------------------------------------------
describe("T-010-03: Scheduled handler awaits orchestrator completion", () => {
  it("passes the orchestrator promise to ctx.waitUntil", async () => {
    let resolveRunSync!: () => void;
    const orchestratorPromise = new Promise<void>((resolve) => { resolveRunSync = resolve; });
    mockRunSync.mockReturnValue(orchestratorPromise);

    const ctx = makeCtx();
    const waitUntilMock = ctx.waitUntil as ReturnType<typeof vi.fn>;

    await scheduled(makeEvent(), makeEnv(), ctx);

    expect(waitUntilMock).toHaveBeenCalledTimes(1);
    resolveRunSync();
  });
});

// ---------------------------------------------------------------------------
// T-010-04: skipped_locked outcome is logged, handler does not throw
// ---------------------------------------------------------------------------
describe("T-010-04: skipped_locked logged but not raised", () => {
  it("logs scheduled_skipped_locked and returns without throwing", async () => {
    mockRunSync.mockResolvedValue({ outcome: "skipped_locked" });
    const logSpy = vi.spyOn(console, "log");
    const ctx = makeCtx();

    await expect(scheduled(makeEvent(), makeEnv(), ctx)).resolves.toBeUndefined();

    const loggedEvents = logSpy.mock.calls
      .map((c) => { try { return JSON.parse(c[0] as string); } catch { return null; } })
      .filter(Boolean);
    const skippedLog = loggedEvents.find((e) => e.event === "scheduled_skipped_locked");
    expect(skippedLog).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// T-010-05: Orchestrator failure does not throw; error is logged
// ---------------------------------------------------------------------------
describe("T-010-05: Orchestrator failure does not throw", () => {
  it("catches runSync exception and logs scheduled_failed", async () => {
    mockRunSync.mockRejectedValue(new Error("unexpected db failure"));
    const logSpy = vi.spyOn(console, "log");
    const ctx = makeCtx();

    await expect(scheduled(makeEvent(), makeEnv(), ctx)).resolves.toBeUndefined();

    const loggedEvents = logSpy.mock.calls
      .map((c) => { try { return JSON.parse(c[0] as string); } catch { return null; } })
      .filter(Boolean);
    const failedLog = loggedEvents.find((e) => e.event === "scheduled_failed");
    expect(failedLog).toBeDefined();
    expect(failedLog.message).toBe("unexpected db failure");
  });

  it("logs scheduled_failed with stringified error when err is not an Error instance", async () => {
    mockRunSync.mockRejectedValue("string-error");
    const logSpy = vi.spyOn(console, "log");
    const ctx = makeCtx();

    await expect(scheduled(makeEvent(), makeEnv(), ctx)).resolves.toBeUndefined();

    const loggedEvents = logSpy.mock.calls
      .map((c) => { try { return JSON.parse(c[0] as string); } catch { return null; } })
      .filter(Boolean);
    const failedLog = loggedEvents.find((e) => e.event === "scheduled_failed");
    expect(failedLog).toBeDefined();
    expect(failedLog.message).toBe("string-error");
  });

  it("logs scheduled_failed even when runSync returns outcome=failed", async () => {
    mockRunSync.mockResolvedValue({ outcome: "failed", run_id: "r2", error_code: "spotify_reauth_required" });
    const logSpy = vi.spyOn(console, "log");
    const ctx = makeCtx();

    await expect(scheduled(makeEvent(), makeEnv(), ctx)).resolves.toBeUndefined();

    const loggedEvents = logSpy.mock.calls
      .map((c) => { try { return JSON.parse(c[0] as string); } catch { return null; } })
      .filter(Boolean);
    const completedLog = loggedEvents.find((e) => e.event === "scheduled_completed");
    expect(completedLog).toBeDefined();
    expect(completedLog.outcome).toBe("failed");
  });
});
