import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Env } from "../../src/env";

const mockClient = { query: vi.fn(), release: vi.fn() };
const mockPool = { connect: vi.fn(), end: vi.fn() };
vi.mock("@neondatabase/serverless", () => ({
  Pool: vi.fn().mockImplementation(() => mockPool),
}));

import { acquireLock, releaseLock, LOCK_KEY } from "../../src/sync/lock";
import { Pool } from "@neondatabase/serverless";

const PoolCtor = Pool as unknown as ReturnType<typeof vi.fn>;

function makeEnv(): Env {
  return { DATABASE_URL: "postgresql://test" } as Env;
}

beforeEach(() => {
  vi.resetAllMocks();
  // resetAllMocks clears every mock's implementation, including the Pool
  // constructor inside the vi.mock factory. Re-establish baseline behaviours.
  PoolCtor.mockImplementation(() => mockPool);
  mockPool.connect.mockResolvedValue(mockClient);
  mockPool.end.mockResolvedValue(undefined);
});

describe("LOCK_KEY", () => {
  it("is a stable 31-bit-safe integer derived from 'sync_run_lock'", () => {
    expect(Number.isSafeInteger(LOCK_KEY)).toBe(true);
    expect(LOCK_KEY).toBeGreaterThan(0);
    // Deterministic across imports/processes — same djb2 hash every time.
    expect(LOCK_KEY).toBe(990374334);
  });
});

describe("acquireLock", () => {
  it("returns a session when pg_try_advisory_lock reports acquired", async () => {
    mockClient.query.mockResolvedValueOnce({ rows: [{ acquired: true }] });
    const session = await acquireLock(makeEnv());
    expect(session).not.toBeNull();
    expect(session?.client).toBe(mockClient);
    expect(mockClient.query).toHaveBeenCalledWith(
      expect.stringContaining("pg_try_advisory_lock"),
      [LOCK_KEY],
    );
  });

  it("releases the client and ends the pool, returning null, when the lock is already held", async () => {
    mockClient.query.mockResolvedValueOnce({ rows: [{ acquired: false }] });
    const session = await acquireLock(makeEnv());
    expect(session).toBeNull();
    expect(mockClient.release).toHaveBeenCalledOnce();
    expect(mockPool.end).toHaveBeenCalledOnce();
  });

  it("releases the client and pool, then rethrows, when the query fails", async () => {
    mockClient.query.mockRejectedValueOnce(new Error("connection reset"));
    await expect(acquireLock(makeEnv())).rejects.toThrow("connection reset");
    expect(mockClient.release).toHaveBeenCalledOnce();
    expect(mockPool.end).toHaveBeenCalledOnce();
  });

  it("constructs the Pool with the env's DATABASE_URL", async () => {
    mockClient.query.mockResolvedValueOnce({ rows: [{ acquired: true }] });
    await acquireLock(makeEnv());
    expect(PoolCtor).toHaveBeenCalledWith({ connectionString: "postgresql://test" });
  });
});

describe("releaseLock", () => {
  it("issues pg_advisory_unlock, then releases the client and ends the pool", async () => {
    mockClient.query.mockResolvedValueOnce({ rows: [{ pg_advisory_unlock: true }] });
    await releaseLock({ pool: mockPool as never, client: mockClient as never });
    expect(mockClient.query).toHaveBeenCalledWith(
      expect.stringContaining("pg_advisory_unlock"),
      [LOCK_KEY],
    );
    expect(mockClient.release).toHaveBeenCalledOnce();
    expect(mockPool.end).toHaveBeenCalledOnce();
  });

  it("still releases the client and ends the pool when the unlock query throws", async () => {
    mockClient.query.mockRejectedValueOnce(new Error("session gone"));
    await expect(
      releaseLock({ pool: mockPool as never, client: mockClient as never }),
    ).rejects.toThrow("session gone");
    expect(mockClient.release).toHaveBeenCalledOnce();
    expect(mockPool.end).toHaveBeenCalledOnce();
  });
});
