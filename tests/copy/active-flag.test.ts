import { describe, it, expect, vi, beforeEach } from "vitest";
import { env as workerEnv } from "cloudflare:test";
import type { Env } from "../../src/env";
import {
  mayHaveActiveCopyJob,
  markCopyJobActive,
  clearCopyJobActive,
} from "../../src/copy/active-flag";

const kvGet = vi.fn();
const kvPut = vi.fn();
const kvDelete = vi.fn();

const mockEnv = {
  COPY_STATE: { get: kvGet, put: kvPut, delete: kvDelete },
} as unknown as Env;

const unboundEnv = {} as Env;

beforeEach(() => {
  vi.clearAllMocks();
  kvGet.mockResolvedValue(null);
  kvPut.mockResolvedValue(undefined);
  kvDelete.mockResolvedValue(undefined);
});

describe("mayHaveActiveCopyJob", () => {
  it("reports no active job only when KV positively says the key is absent", async () => {
    kvGet.mockResolvedValue(null);
    expect(await mayHaveActiveCopyJob(mockEnv)).toBe(false);
    expect(kvGet).toHaveBeenCalledWith("active_job");
  });

  it("reports a possible active job when the key is present", async () => {
    kvGet.mockResolvedValue("1");
    expect(await mayHaveActiveCopyJob(mockEnv)).toBe(true);
  });

  it("fails open when the KV read throws", async () => {
    kvGet.mockRejectedValue(new Error("kv unavailable"));
    expect(await mayHaveActiveCopyJob(mockEnv)).toBe(true);
  });

  it("fails open when the namespace is not bound at all", async () => {
    expect(await mayHaveActiveCopyJob(unboundEnv)).toBe(true);
  });
});

describe("markCopyJobActive", () => {
  it("arms the flag", async () => {
    await markCopyJobActive(mockEnv);
    expect(kvPut).toHaveBeenCalledWith("active_job", "1");
  });

  it("swallows a write failure so a caller can never fail on the flag", async () => {
    kvPut.mockRejectedValue(new Error("kv unavailable"));
    await expect(markCopyJobActive(mockEnv)).resolves.toBeUndefined();
  });

  it("swallows a missing binding", async () => {
    await expect(markCopyJobActive(unboundEnv)).resolves.toBeUndefined();
  });
});

describe("clearCopyJobActive", () => {
  it("releases the flag", async () => {
    await clearCopyJobActive(mockEnv);
    expect(kvDelete).toHaveBeenCalledWith("active_job");
  });

  it("swallows a delete failure", async () => {
    kvDelete.mockRejectedValue(new Error("kv unavailable"));
    await expect(clearCopyJobActive(mockEnv)).resolves.toBeUndefined();
  });

  it("swallows a missing binding", async () => {
    await expect(clearCopyJobActive(unboundEnv)).resolves.toBeUndefined();
  });
});

describe("the COPY_STATE binding declared in wrangler config", () => {
  // Canary: fails if the [[kv_namespaces]] block is ever dropped from
  // wrangler.toml.example, which CI copies into place.
  it("round-trips arm -> present -> release -> absent against the real namespace", async () => {
    const realEnv = workerEnv as unknown as Env;

    await clearCopyJobActive(realEnv);
    expect(await mayHaveActiveCopyJob(realEnv)).toBe(false);

    await markCopyJobActive(realEnv);
    expect(await mayHaveActiveCopyJob(realEnv)).toBe(true);

    await clearCopyJobActive(realEnv);
    expect(await mayHaveActiveCopyJob(realEnv)).toBe(false);
  });
});
