import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Env } from "../../src/env";
import type { CopyJobRow } from "../../src/db/copy_jobs";

vi.mock("../../src/db/copy_jobs", () => ({
  loadActiveJob: vi.fn(),
  getJob: vi.fn(),
  setStatus: vi.fn().mockResolvedValue(true),
  recomputeCounters: vi.fn(),
  incrementConsecutiveErrors: vi.fn(),
  resetConsecutiveErrors: vi.fn(),
  NON_TERMINAL_STATUSES: ["queued", "fetching", "matching", "writing"],
}));
vi.mock("../../src/db/copy_job_tracks", () => ({ countPending: vi.fn() }));
vi.mock("../../src/sync/lock", () => ({ acquireLock: vi.fn(), releaseLock: vi.fn() }));
vi.mock("../../src/copy/fetch", () => ({ runFetchPhaseStep: vi.fn() }));
vi.mock("../../src/copy/match", () => ({ runMatchPhaseStep: vi.fn() }));
vi.mock("../../src/copy/write", () => ({ runWritePhaseStep: vi.fn() }));
vi.mock("../../src/copy/notify", () => ({ notifyCopyJobTerminal: vi.fn() }));

import { runCopyTick } from "../../src/copy/engine";
import {
  loadActiveJob,
  getJob,
  setStatus,
  recomputeCounters,
  incrementConsecutiveErrors,
  resetConsecutiveErrors,
} from "../../src/db/copy_jobs";
import { countPending } from "../../src/db/copy_job_tracks";
import { acquireLock, releaseLock } from "../../src/sync/lock";
import { runFetchPhaseStep } from "../../src/copy/fetch";
import { runMatchPhaseStep } from "../../src/copy/match";
import { runWritePhaseStep } from "../../src/copy/write";
import { notifyCopyJobTerminal } from "../../src/copy/notify";
import { SpotifyAuthError } from "../../src/providers/spotify/oauth";
import { IntegrityError } from "../../src/crypto";

const mockLoadActiveJob = vi.mocked(loadActiveJob);
const mockGetJob = vi.mocked(getJob);
const mockSetStatus = vi.mocked(setStatus);
const mockRecomputeCounters = vi.mocked(recomputeCounters);
const mockIncrementConsecutiveErrors = vi.mocked(incrementConsecutiveErrors);
const mockResetConsecutiveErrors = vi.mocked(resetConsecutiveErrors);
const mockCountPending = vi.mocked(countPending);
const mockAcquireLock = vi.mocked(acquireLock);
const mockReleaseLock = vi.mocked(releaseLock);
const mockRunFetchPhaseStep = vi.mocked(runFetchPhaseStep);
const mockRunMatchPhaseStep = vi.mocked(runMatchPhaseStep);
const mockRunWritePhaseStep = vi.mocked(runWritePhaseStep);
const mockNotifyCopyJobTerminal = vi.mocked(notifyCopyJobTerminal);

const kvGet = vi.fn();
const kvPut = vi.fn();
const kvDelete = vi.fn();

const mockEnv = {
  DATABASE_URL: "postgresql://test",
  COPY_STATE: { get: kvGet, put: kvPut, delete: kvDelete },
} as unknown as Env;
const fakeSession = { pool: {}, client: {} } as never;

function makeJob(overrides: Partial<CopyJobRow> = {}): CopyJobRow {
  return {
    job_id: "job-1",
    direction: "spotify_to_tidal",
    source_playlist_id: "src-1",
    source_name: "Src",
    dest_mode: "new",
    dest_playlist_id: null,
    dest_name: "Src",
    status: "fetching",
    error_code: null,
    fetch_cursor: null,
    dest_known_ids: null,
    total_tracks: null,
    fetched: 0,
    matched: 0,
    written: 0,
    unmatched: 0,
    write_batch_positions: null,
    consecutive_errors: 0,
    created_at: "2026-07-18T00:00:00Z",
    updated_at: "2026-07-18T00:00:00Z",
    finished_at: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Every suite below exercises a tick that gets past the F-032 gate.
  kvGet.mockResolvedValue("1");
  kvPut.mockResolvedValue(undefined);
  kvDelete.mockResolvedValue(undefined);
});

describe("Idle tick is a no-op", () => {
  it("clears the stale flag and exits without acquiring the lock", async () => {
    mockLoadActiveJob.mockResolvedValueOnce(null);
    const result = await runCopyTick(mockEnv);
    expect(result.outcome).toBe("idle");
    expect(mockAcquireLock).not.toHaveBeenCalled();
    expect(kvDelete).toHaveBeenCalledWith("active_job");
  });
});

describe("F-032: the KV flag gates the Neon query", () => {
  it("makes zero Neon calls and never takes the lock when the flag is absent", async () => {
    kvGet.mockResolvedValue(null);
    const result = await runCopyTick(mockEnv);
    expect(result.outcome).toBe("idle_flag_absent");
    expect(mockLoadActiveJob).not.toHaveBeenCalled();
    expect(mockAcquireLock).not.toHaveBeenCalled();
  });

  it("queries Neon and runs the tick normally when the flag is present", async () => {
    mockLoadActiveJob.mockResolvedValueOnce(makeJob());
    mockGetJob.mockResolvedValueOnce(makeJob());
    mockAcquireLock.mockResolvedValueOnce(fakeSession);
    const result = await runCopyTick(mockEnv);
    expect(mockLoadActiveJob).toHaveBeenCalledTimes(1);
    expect(result.outcome).toBe("advanced");
  });

  it("falls back to the Neon query when the KV read throws", async () => {
    kvGet.mockRejectedValue(new Error("kv unavailable"));
    mockLoadActiveJob.mockResolvedValueOnce(null);
    const result = await runCopyTick(mockEnv);
    expect(mockLoadActiveJob).toHaveBeenCalledTimes(1);
    expect(result.outcome).toBe("idle");
  });

  it("falls back to the Neon query when the namespace is not bound", async () => {
    mockLoadActiveJob.mockResolvedValueOnce(null);
    const result = await runCopyTick({ DATABASE_URL: "postgresql://test" } as Env);
    expect(mockLoadActiveJob).toHaveBeenCalledTimes(1);
    expect(result.outcome).toBe("idle");
  });

  it("leaves the flag alone when an active job is found", async () => {
    mockLoadActiveJob.mockResolvedValueOnce(makeJob());
    mockGetJob.mockResolvedValueOnce(makeJob());
    mockAcquireLock.mockResolvedValueOnce(fakeSession);
    await runCopyTick(mockEnv);
    expect(kvDelete).not.toHaveBeenCalled();
  });
});

describe("Lock contention skips the tick", () => {
  it("exits without processing when the lock is held", async () => {
    mockLoadActiveJob.mockResolvedValueOnce(makeJob());
    mockAcquireLock.mockResolvedValueOnce(null);
    const result = await runCopyTick(mockEnv);
    expect(result.outcome).toBe("skipped_locked");
    expect(mockRunFetchPhaseStep).not.toHaveBeenCalled();
  });
});

describe("Job progresses across ticks — phase dispatch", () => {
  it("dispatches to the fetch phase when status='fetching'", async () => {
    mockLoadActiveJob.mockResolvedValueOnce(makeJob({ status: "fetching" }));
    mockAcquireLock.mockResolvedValueOnce(fakeSession);
    mockGetJob.mockResolvedValueOnce(makeJob({ status: "fetching" }));

    const result = await runCopyTick(mockEnv);

    expect(mockRunFetchPhaseStep).toHaveBeenCalledOnce();
    expect(mockRunMatchPhaseStep).not.toHaveBeenCalled();
    expect(mockReleaseLock).toHaveBeenCalledWith(fakeSession);
    expect(result.outcome).toBe("advanced");
  });

  it("dispatches to the fetch phase when status='queued' (first tick)", async () => {
    mockLoadActiveJob.mockResolvedValueOnce(makeJob({ status: "queued" }));
    mockAcquireLock.mockResolvedValueOnce(fakeSession);
    mockGetJob.mockResolvedValueOnce(makeJob({ status: "queued" }));

    await runCopyTick(mockEnv);
    expect(mockRunFetchPhaseStep).toHaveBeenCalledOnce();
  });

  it("dispatches to the match phase and stays in matching when tracks are still pending", async () => {
    mockLoadActiveJob.mockResolvedValueOnce(makeJob({ status: "matching" }));
    mockAcquireLock.mockResolvedValueOnce(fakeSession);
    mockGetJob.mockResolvedValueOnce(makeJob({ status: "matching" }));
    mockCountPending.mockResolvedValueOnce(3);

    await runCopyTick(mockEnv);

    expect(mockRunMatchPhaseStep).toHaveBeenCalledOnce();
    expect(mockSetStatus).not.toHaveBeenCalled();
  });

  it("transitions matching -> writing once no pending tracks remain", async () => {
    mockLoadActiveJob.mockResolvedValueOnce(makeJob({ status: "matching" }));
    mockAcquireLock.mockResolvedValueOnce(fakeSession);
    mockGetJob.mockResolvedValueOnce(makeJob({ status: "matching" }));
    mockCountPending.mockResolvedValueOnce(0);

    await runCopyTick(mockEnv);

    expect(mockSetStatus).toHaveBeenCalledWith(mockEnv, "job-1", "writing");
  });

  it("dispatches to the write phase when status='writing'", async () => {
    mockLoadActiveJob.mockResolvedValueOnce(makeJob({ status: "writing" }));
    mockAcquireLock.mockResolvedValueOnce(fakeSession);
    mockGetJob.mockResolvedValueOnce(makeJob({ status: "writing" }));
    mockRecomputeCounters.mockResolvedValueOnce({ fetched: 5, matched: 2, written: 3, unmatched: 0 });

    await runCopyTick(mockEnv);

    expect(mockRunWritePhaseStep).toHaveBeenCalledOnce();
  });
});

describe("Terminal transitions (task 2.6)", () => {
  it("completes cleanly (no unmatched) once no matched rows remain to write", async () => {
    mockLoadActiveJob.mockResolvedValueOnce(makeJob({ status: "writing" }));
    mockAcquireLock.mockResolvedValueOnce(fakeSession);
    mockGetJob.mockResolvedValueOnce(makeJob({ status: "writing" }));
    mockRecomputeCounters.mockResolvedValueOnce({ fetched: 5, matched: 0, written: 5, unmatched: 0 });

    await runCopyTick(mockEnv);

    expect(mockSetStatus).toHaveBeenCalledWith(
      mockEnv,
      "job-1",
      "completed",
      expect.objectContaining({ finished_at: expect.any(String) }),
    );
    expect(mockNotifyCopyJobTerminal).toHaveBeenCalledOnce();
  });

  it("completes with unmatched when some tracks never matched", async () => {
    mockLoadActiveJob.mockResolvedValueOnce(makeJob({ status: "writing" }));
    mockAcquireLock.mockResolvedValueOnce(fakeSession);
    mockGetJob.mockResolvedValueOnce(makeJob({ status: "writing" }));
    mockRecomputeCounters.mockResolvedValueOnce({ fetched: 5, matched: 0, written: 3, unmatched: 2 });

    await runCopyTick(mockEnv);

    expect(mockSetStatus).toHaveBeenCalledWith(
      mockEnv,
      "job-1",
      "completed_with_unmatched",
      expect.objectContaining({ finished_at: expect.any(String) }),
    );
  });

  it("stays in writing (no terminal transition) while matched rows remain", async () => {
    mockLoadActiveJob.mockResolvedValueOnce(makeJob({ status: "writing" }));
    mockAcquireLock.mockResolvedValueOnce(fakeSession);
    mockGetJob.mockResolvedValueOnce(makeJob({ status: "writing" }));
    mockRecomputeCounters.mockResolvedValueOnce({ fetched: 5, matched: 2, written: 1, unmatched: 0 });

    await runCopyTick(mockEnv);

    expect(mockSetStatus).not.toHaveBeenCalled();
    expect(mockNotifyCopyJobTerminal).not.toHaveBeenCalled();
  });
});

describe("Cancelled/terminal status observed before any work (I-004-style guard)", () => {
  it("does no phase work when the job became cancelled between the idle-check and lock acquisition", async () => {
    mockLoadActiveJob.mockResolvedValueOnce(makeJob({ status: "matching" }));
    mockAcquireLock.mockResolvedValueOnce(fakeSession);
    mockGetJob.mockResolvedValueOnce(makeJob({ status: "cancelled", finished_at: "2026-07-18T00:05:00Z" }));

    const result = await runCopyTick(mockEnv);

    expect(mockRunMatchPhaseStep).not.toHaveBeenCalled();
    expect(mockRunFetchPhaseStep).not.toHaveBeenCalled();
    expect(mockRunWritePhaseStep).not.toHaveBeenCalled();
    expect(mockReleaseLock).toHaveBeenCalledWith(fakeSession);
    expect(result.outcome).toBe("no_active_job_after_lock");
  });

  it("releases the lock and returns no_active_job_after_lock when the job disappeared", async () => {
    mockLoadActiveJob.mockResolvedValueOnce(makeJob());
    mockAcquireLock.mockResolvedValueOnce(fakeSession);
    mockGetJob.mockResolvedValueOnce(null);

    const result = await runCopyTick(mockEnv);
    expect(result.outcome).toBe("no_active_job_after_lock");
    expect(mockReleaseLock).toHaveBeenCalledWith(fakeSession);
  });
});

describe("Lock is always released, even on phase-step failure", () => {
  it("releases the lock when the fetch phase throws", async () => {
    mockLoadActiveJob.mockResolvedValueOnce(makeJob({ status: "fetching" }));
    mockAcquireLock.mockResolvedValueOnce(fakeSession);
    mockGetJob.mockResolvedValueOnce(makeJob({ status: "fetching" }));
    mockRunFetchPhaseStep.mockRejectedValueOnce(new Error("boom"));

    // B3: a phase-step failure is now caught and classified rather than
    // propagated — the tick still completes (and the lock still releases).
    const result = await runCopyTick(mockEnv);
    expect(result.outcome).toBe("advanced");
    expect(mockReleaseLock).toHaveBeenCalledWith(fakeSession);
  });
});

describe("S2: terminal transitions skip the notification when setStatus reports no-op (concurrent cancel)", () => {
  it("does not notify when the completed flip lost the race to a concurrent cancel", async () => {
    mockLoadActiveJob.mockResolvedValueOnce(makeJob({ status: "writing" }));
    mockAcquireLock.mockResolvedValueOnce(fakeSession);
    mockGetJob.mockResolvedValueOnce(makeJob({ status: "writing" }));
    mockRecomputeCounters.mockResolvedValueOnce({ fetched: 5, matched: 0, written: 5, unmatched: 0 });
    mockSetStatus.mockResolvedValueOnce(false);

    await runCopyTick(mockEnv);

    expect(mockSetStatus).toHaveBeenCalledWith(
      mockEnv,
      "job-1",
      "completed",
      expect.objectContaining({ finished_at: expect.any(String) }),
    );
    expect(mockNotifyCopyJobTerminal).not.toHaveBeenCalled();
  });
});

describe("B3: tick-error classification and the consecutive-error streak", () => {
  it("increments the streak and stays non-terminal on a generic transient error", async () => {
    mockLoadActiveJob.mockResolvedValueOnce(makeJob({ status: "fetching" }));
    mockAcquireLock.mockResolvedValueOnce(fakeSession);
    mockGetJob.mockResolvedValueOnce(makeJob({ status: "fetching" }));
    mockRunFetchPhaseStep.mockRejectedValueOnce(new Error("ECONNRESET"));
    mockIncrementConsecutiveErrors.mockResolvedValueOnce(1);

    await runCopyTick(mockEnv);

    expect(mockIncrementConsecutiveErrors).toHaveBeenCalledWith(mockEnv, "job-1");
    expect(mockSetStatus).not.toHaveBeenCalledWith(mockEnv, "job-1", "failed", expect.anything());
    expect(mockResetConsecutiveErrors).not.toHaveBeenCalled();
  });

  it("fails the job with tick_error_streak once the streak hits the cap", async () => {
    mockLoadActiveJob.mockResolvedValueOnce(makeJob({ status: "fetching" }));
    mockAcquireLock.mockResolvedValueOnce(fakeSession);
    mockGetJob.mockResolvedValueOnce(makeJob({ status: "fetching" }));
    mockRunFetchPhaseStep.mockRejectedValueOnce(new Error("ECONNRESET"));
    mockIncrementConsecutiveErrors.mockResolvedValueOnce(5);
    mockRecomputeCounters.mockResolvedValueOnce({ fetched: 1, matched: 0, written: 0, unmatched: 0 });

    await runCopyTick(mockEnv);

    expect(mockSetStatus).toHaveBeenCalledWith(
      mockEnv,
      "job-1",
      "failed",
      expect.objectContaining({ error_code: "tick_error_streak", finished_at: expect.any(String) }),
    );
    expect(mockNotifyCopyJobTerminal).toHaveBeenCalledOnce();
  });

  it("fails the job immediately on a Spotify reauth error, without touching the streak", async () => {
    mockLoadActiveJob.mockResolvedValueOnce(makeJob({ status: "fetching" }));
    mockAcquireLock.mockResolvedValueOnce(fakeSession);
    mockGetJob.mockResolvedValueOnce(makeJob({ status: "fetching" }));
    mockRunFetchPhaseStep.mockRejectedValueOnce(new SpotifyAuthError("reauth_required", "revoked"));
    mockRecomputeCounters.mockResolvedValueOnce({ fetched: 1, matched: 0, written: 0, unmatched: 0 });

    await runCopyTick(mockEnv);

    expect(mockIncrementConsecutiveErrors).not.toHaveBeenCalled();
    expect(mockSetStatus).toHaveBeenCalledWith(
      mockEnv,
      "job-1",
      "failed",
      expect.objectContaining({ error_code: "spotify_reauth_required" }),
    );
  });

  it("fails the job immediately on a decrypt failure", async () => {
    mockLoadActiveJob.mockResolvedValueOnce(makeJob({ status: "fetching" }));
    mockAcquireLock.mockResolvedValueOnce(fakeSession);
    mockGetJob.mockResolvedValueOnce(makeJob({ status: "fetching" }));
    mockRunFetchPhaseStep.mockRejectedValueOnce(new IntegrityError("bad tag"));
    mockRecomputeCounters.mockResolvedValueOnce({ fetched: 1, matched: 0, written: 0, unmatched: 0 });

    await runCopyTick(mockEnv);

    expect(mockSetStatus).toHaveBeenCalledWith(
      mockEnv,
      "job-1",
      "failed",
      expect.objectContaining({ error_code: "decrypt_failed" }),
    );
  });

  it("does not fail the job when the streak-cap setStatus loses the race to a concurrent cancel", async () => {
    mockLoadActiveJob.mockResolvedValueOnce(makeJob({ status: "fetching" }));
    mockAcquireLock.mockResolvedValueOnce(fakeSession);
    mockGetJob.mockResolvedValueOnce(makeJob({ status: "fetching" }));
    mockRunFetchPhaseStep.mockRejectedValueOnce(new Error("boom"));
    mockIncrementConsecutiveErrors.mockResolvedValueOnce(5);
    mockSetStatus.mockResolvedValueOnce(false);

    await runCopyTick(mockEnv);

    expect(mockNotifyCopyJobTerminal).not.toHaveBeenCalled();
  });

  it("resets the streak after a successful tick", async () => {
    mockLoadActiveJob.mockResolvedValueOnce(makeJob({ status: "fetching" }));
    mockAcquireLock.mockResolvedValueOnce(fakeSession);
    mockGetJob.mockResolvedValueOnce(makeJob({ status: "fetching" }));

    await runCopyTick(mockEnv);

    expect(mockResetConsecutiveErrors).toHaveBeenCalledWith(mockEnv, "job-1");
  });
});

describe("Budgets read from env with defaults", () => {
  it("passes COPY_BATCH_ISRC/COPY_BATCH_FUZZY through to the match phase, defaulting to 2", async () => {
    mockLoadActiveJob.mockResolvedValueOnce(makeJob({ status: "matching" }));
    mockAcquireLock.mockResolvedValueOnce(fakeSession);
    mockGetJob.mockResolvedValueOnce(makeJob({ status: "matching" }));
    mockCountPending.mockResolvedValueOnce(1);

    await runCopyTick({ ...mockEnv, COPY_BATCH_ISRC: "4", COPY_BATCH_FUZZY: "6" } as Env);

    expect(mockRunMatchPhaseStep).toHaveBeenCalledWith(expect.anything(), expect.anything(), 4, 6);
  });

  it("defaults both budgets to 2 when unset", async () => {
    mockLoadActiveJob.mockResolvedValueOnce(makeJob({ status: "matching" }));
    mockAcquireLock.mockResolvedValueOnce(fakeSession);
    mockGetJob.mockResolvedValueOnce(makeJob({ status: "matching" }));
    mockCountPending.mockResolvedValueOnce(1);

    await runCopyTick(mockEnv);

    expect(mockRunMatchPhaseStep).toHaveBeenCalledWith(expect.anything(), expect.anything(), 2, 2);
  });
});
