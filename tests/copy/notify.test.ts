import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Env } from "../../src/env";
import type { CopyJobRow } from "../../src/db/copy_jobs";

vi.mock("../../src/notify/ntfy", () => ({ sendNtfyNotification: vi.fn() }));
vi.mock("../../src/db/copy_jobs", () => ({ countSkipped: vi.fn() }));

import { notifyCopyJobTerminal } from "../../src/copy/notify";
import { sendNtfyNotification } from "../../src/notify/ntfy";
import { countSkipped } from "../../src/db/copy_jobs";

const mockSend = vi.mocked(sendNtfyNotification);
const mockCountSkipped = vi.mocked(countSkipped);
const mockEnv = { DATABASE_URL: "postgresql://test" } as Env;

function makeJob(overrides: Partial<CopyJobRow> = {}): CopyJobRow {
  return {
    job_id: "job-1",
    direction: "spotify_to_tidal",
    source_playlist_id: "src-1",
    source_name: "My Playlist",
    dest_mode: "new",
    dest_playlist_id: "dest-1",
    dest_name: "My Playlist",
    status: "completed",
    error_code: null,
    fetch_cursor: null,
    dest_known_ids: null,
    total_tracks: 10,
    fetched: 10,
    matched: 0,
    written: 8,
    unmatched: 2,
    write_batch_positions: null,
    consecutive_errors: 0,
    created_at: "2026-07-18T00:00:00Z",
    updated_at: "2026-07-18T01:00:00Z",
    finished_at: "2026-07-18T01:00:00Z",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockCountSkipped.mockResolvedValue(0);
});

describe("notifyCopyJobTerminal", () => {
  it("is a no-op for non-terminal statuses", async () => {
    await notifyCopyJobTerminal(mockEnv, makeJob({ status: "matching" }));
    expect(mockSend).not.toHaveBeenCalled();
    expect(mockCountSkipped).not.toHaveBeenCalled();
  });


  it("sends a low-priority message on clean completion", async () => {
    await notifyCopyJobTerminal(mockEnv, makeJob({ status: "completed", unmatched: 0, written: 10 }));
    expect(mockSend).toHaveBeenCalledWith(
      mockEnv,
      expect.objectContaining({ priority: 2, title: expect.stringContaining("completed") }),
    );
  });

  it("includes written/skipped/unmatched counts and direction/source name in the body", async () => {
    mockCountSkipped.mockResolvedValueOnce(1);
    await notifyCopyJobTerminal(mockEnv, makeJob());
    const [, message] = mockSend.mock.calls[0];
    expect(message.body).toContain("My Playlist");
    expect(message.body).toContain("spotify_to_tidal");
    expect(message.body).toContain("written 8");
    expect(message.body).toContain("skipped 1");
    expect(message.body).toContain("unmatched 2");
  });

  it("uses a high-priority warning tag for completed_with_unmatched", async () => {
    await notifyCopyJobTerminal(mockEnv, makeJob({ status: "completed_with_unmatched" }));
    expect(mockSend).toHaveBeenCalledWith(mockEnv, expect.objectContaining({ priority: 4 }));
  });

  it("includes the error_code for a failed job", async () => {
    await notifyCopyJobTerminal(
      mockEnv,
      makeJob({ status: "failed", error_code: "spotify_reauth_required" }),
    );
    const [, message] = mockSend.mock.calls[0];
    expect(message.priority).toBe(4);
    expect(message.body).toContain("spotify_reauth_required");
  });

  it("sends a routine message for a cancelled job", async () => {
    await notifyCopyJobTerminal(mockEnv, makeJob({ status: "cancelled" }));
    expect(mockSend).toHaveBeenCalledWith(
      mockEnv,
      expect.objectContaining({ priority: 2, title: expect.stringContaining("cancelled") }),
    );
  });
});
