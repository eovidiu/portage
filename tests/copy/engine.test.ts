import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Env } from "../../src/env";
import type { CopyJobRow } from "../../src/db/copy_jobs";

vi.mock("../../src/db/copy_jobs", () => ({
  loadActiveJob: vi.fn(),
  getJob: vi.fn(),
  setStatus: vi.fn(),
  recomputeCounters: vi.fn(),
  NON_TERMINAL_STATUSES: ["queued", "fetching", "matching", "writing"],
}));
vi.mock("../../src/db/copy_job_tracks", () => ({ countPending: vi.fn() }));
vi.mock("../../src/sync/lock", () => ({ acquireLock: vi.fn(), releaseLock: vi.fn() }));
vi.mock("../../src/copy/fetch", () => ({ runFetchPhaseStep: vi.fn() }));
vi.mock("../../src/copy/match", () => ({ runMatchPhaseStep: vi.fn() }));
vi.mock("../../src/copy/write", () => ({ runWritePhaseStep: vi.fn() }));
vi.mock("../../src/copy/notify", () => ({ notifyCopyJobTerminal: vi.fn() }));

import { runCopyTick } from "../../src/copy/engine";
import { loadActiveJob, getJob, setStatus, recomputeCounters } from "../../src/db/copy_jobs";
import { countPending } from "../../src/db/copy_job_tracks";
import { acquireLock, releaseLock } from "../../src/sync/lock";
import { runFetchPhaseStep } from "../../src/copy/fetch";
import { runMatchPhaseStep } from "../../src/copy/match";
import { runWritePhaseStep } from "../../src/copy/write";
import { notifyCopyJobTerminal } from "../../src/copy/notify";

const mockLoadActiveJob = vi.mocked(loadActiveJob);
const mockGetJob = vi.mocked(getJob);
const mockSetStatus = vi.mocked(setStatus);
const mockRecomputeCounters = vi.mocked(recomputeCounters);
const mockCountPending = vi.mocked(countPending);
const mockAcquireLock = vi.mocked(acquireLock);
const mockReleaseLock = vi.mocked(releaseLock);
const mockRunFetchPhaseStep = vi.mocked(runFetchPhaseStep);
const mockRunMatchPhaseStep = vi.mocked(runMatchPhaseStep);
const mockRunWritePhaseStep = vi.mocked(runWritePhaseStep);
const mockNotifyCopyJobTerminal = vi.mocked(notifyCopyJobTerminal);

const mockEnv = { DATABASE_URL: "postgresql://test" } as Env;
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
    created_at: "2026-07-18T00:00:00Z",
    updated_at: "2026-07-18T00:00:00Z",
    finished_at: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("Idle tick is a no-op", () => {
  it("performs one query and exits without acquiring the lock", async () => {
    mockLoadActiveJob.mockResolvedValueOnce(null);
    const result = await runCopyTick(mockEnv);
    expect(result.outcome).toBe("idle");
    expect(mockAcquireLock).not.toHaveBeenCalled();
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

    await expect(runCopyTick(mockEnv)).rejects.toThrow("boom");
    expect(mockReleaseLock).toHaveBeenCalledWith(fakeSession);
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
