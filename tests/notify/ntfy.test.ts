// F-029 sync-notifications — unit tests for the ntfy publish module.
// The ntfy publish contract (URL shape, Title/Priority/Tags headers, Bearer
// auth) is grounded against https://docs.ntfy.sh/publish/.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Env } from "../../src/env";
import type { OrchestratorResult } from "../../src/sync/orchestrator";
import {
  sendNtfyNotification,
  notifySyncOutcome,
  notifyAbandonedSweep,
  notifyOrchestratorCrash,
} from "../../src/notify/ntfy";

const mockFetch = vi.fn();

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    DATABASE_URL: "postgresql://test",
    NTFY_TOPIC: "portage-test-topic",
    ...overrides,
  } as Env;
}

function okResponse(): Response {
  return new Response("{}", { status: 200 });
}

const MESSAGE = {
  title: "Test title",
  body: "test body",
  priority: 4 as const,
  tags: "warning",
};

beforeEach(() => {
  vi.stubGlobal("fetch", mockFetch);
  mockFetch.mockImplementation(async () => okResponse());
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("sendNtfyNotification", () => {
  it("is a complete no-op when NTFY_TOPIC is unset", async () => {
    const logSpy = vi.spyOn(console, "log");
    await sendNtfyNotification(makeEnv({ NTFY_TOPIC: undefined }), MESSAGE);
    expect(mockFetch).not.toHaveBeenCalled();
    expect(logSpy).not.toHaveBeenCalled();
  });

  it("POSTs to the default base URL with Title/Priority/Tags headers", async () => {
    await sendNtfyNotification(makeEnv(), MESSAGE);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://ntfy.sh/portage-test-topic");
    expect(init.method).toBe("POST");
    expect(init.body).toBe("test body");
    const headers = init.headers as Record<string, string>;
    expect(headers["Title"]).toBe("Test title");
    expect(headers["Priority"]).toBe("4");
    expect(headers["Tags"]).toBe("warning");
    expect(headers["Authorization"]).toBeUndefined();
  });

  it("honors an NTFY_URL override", async () => {
    await sendNtfyNotification(
      makeEnv({ NTFY_URL: "https://ntfy.example.com" }),
      MESSAGE,
    );
    const [url] = mockFetch.mock.calls[0] as [string];
    expect(url).toBe("https://ntfy.example.com/portage-test-topic");
  });

  it("sends Authorization: Bearer only when NTFY_TOKEN is set", async () => {
    await sendNtfyNotification(makeEnv({ NTFY_TOKEN: "tk_abc" }), MESSAGE);
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer tk_abc");
  });

  it("passes an AbortSignal so a hung publish cannot exceed the timeout", async () => {
    await sendNtfyNotification(makeEnv(), MESSAGE);
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("swallows a rejected fetch and logs ntfy_notify_failed without the topic", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mockFetch.mockRejectedValue(new Error("network down"));
    await expect(sendNtfyNotification(makeEnv(), MESSAGE)).resolves.toBeUndefined();
    const line = logSpy.mock.calls
      .map((c) => String(c[0]))
      .find((l) => l.includes("ntfy_notify_failed"));
    expect(line).toBeDefined();
    expect(line).toContain("network down");
    expect(line).not.toContain("portage-test-topic");
  });

  it("stringifies non-Error rejection values in the failure log", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mockFetch.mockRejectedValue("socket hang up");
    await expect(sendNtfyNotification(makeEnv(), MESSAGE)).resolves.toBeUndefined();
    const line = logSpy.mock.calls
      .map((c) => String(c[0]))
      .find((l) => l.includes("ntfy_notify_failed"));
    expect(line).toContain("socket hang up");
  });

  it("swallows a non-2xx response and logs ntfy_notify_failed", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mockFetch.mockImplementation(
      async () => new Response("limit", { status: 429 }),
    );
    await expect(sendNtfyNotification(makeEnv(), MESSAGE)).resolves.toBeUndefined();
    const line = logSpy.mock.calls
      .map((c) => String(c[0]))
      .find((l) => l.includes("ntfy_notify_failed"));
    expect(line).toBeDefined();
    expect(line).toContain("429");
  });
});

describe("notifySyncOutcome", () => {
  const baseResult: OrchestratorResult = {
    outcome: "succeeded",
    run_id: "run-001",
    tracks_seen: 5,
    matched_isrc: 3,
    matched_fuzzy: 1,
    unmatched: 1,
    errors: 0,
  };

  it("succeeded → Priority 2, white_check_mark, counts + run_id in body", async () => {
    await notifySyncOutcome(makeEnv(), baseResult);
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["Title"]).toBe("Portage sync succeeded");
    expect(headers["Priority"]).toBe("2");
    expect(headers["Tags"]).toBe("white_check_mark");
    const body = String(init.body);
    expect(body).toContain("5");
    expect(body).toContain("run-001");
  });

  it("failed → Priority 4, rotating_light, error_code in body", async () => {
    await notifySyncOutcome(makeEnv(), {
      outcome: "failed",
      run_id: "run-002",
      error_code: "spotify_reauth_required",
    });
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["Title"]).toBe("Portage sync failed");
    expect(headers["Priority"]).toBe("4");
    expect(headers["Tags"]).toBe("rotating_light");
    const body = String(init.body);
    expect(body).toContain("spotify_reauth_required");
    expect(body).toContain("run-002");
  });

  it("partial → Priority 4, warning", async () => {
    await notifySyncOutcome(makeEnv(), { ...baseResult, outcome: "partial" });
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["Title"]).toBe("Portage sync partial");
    expect(headers["Priority"]).toBe("4");
    expect(headers["Tags"]).toBe("warning");
  });

  it("omits counts and run_id lines when the result has neither", async () => {
    await notifySyncOutcome(makeEnv(), {
      outcome: "failed",
      error_code: "orchestrator_fatal",
    });
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(String(init.body)).toBe("error_code: orchestrator_fatal");
  });

  it("skipped_locked publishes nothing", async () => {
    await notifySyncOutcome(makeEnv(), { outcome: "skipped_locked" });
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe("notifyAbandonedSweep", () => {
  it("reports the swept count at Priority 4 with ghost tag", async () => {
    await notifyAbandonedSweep(makeEnv(), 2);
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["Title"]).toContain("2");
    expect(headers["Priority"]).toBe("4");
    expect(headers["Tags"]).toBe("ghost");
  });
});

describe("notifyOrchestratorCrash", () => {
  it("publishes a failed-style notification with the crash message", async () => {
    await notifyOrchestratorCrash(makeEnv(), new Error("neon unreachable"));
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["Title"]).toBe("Portage sync failed");
    expect(headers["Priority"]).toBe("4");
    expect(String(init.body)).toContain("neon unreachable");
  });

  it("stringifies non-Error crash values", async () => {
    await notifyOrchestratorCrash(makeEnv(), "raw string failure");
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(String(init.body)).toContain("raw string failure");
  });

  it("never throws even when the publish fails", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    mockFetch.mockRejectedValue(new Error("down"));
    await expect(
      notifyOrchestratorCrash(makeEnv(), new Error("boom")),
    ).resolves.toBeUndefined();
  });
});
