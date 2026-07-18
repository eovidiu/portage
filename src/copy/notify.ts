// F-030 task 2.6 (design.md D10): copy-job terminal ntfy notification.
// Reuses the existing sendNtfyNotification primitive (src/notify/ntfy.ts) —
// that module's own functions stay untouched; this is a new, independent
// caller, same as notifySyncOutcome/notifyAbandonedSweep.

import type { Env } from "../env";
import type { CopyJobRow, CopyJobStatus } from "../db/copy_jobs";
import { countSkipped } from "../db/copy_jobs";
import { sendNtfyNotification } from "../notify/ntfy";

const PRESENTATION: Record<CopyJobStatus, { priority: 2 | 4; tags: string } | undefined> = {
  completed: { priority: 2, tags: "white_check_mark" },
  completed_with_unmatched: { priority: 4, tags: "warning" },
  failed: { priority: 4, tags: "rotating_light" },
  cancelled: { priority: 2, tags: "no_entry_sign" },
  queued: undefined,
  fetching: undefined,
  matching: undefined,
  writing: undefined,
};

/** Sends the D10 terminal notification. No-op (and never throws) for non-terminal statuses. */
export async function notifyCopyJobTerminal(env: Env, job: CopyJobRow): Promise<void> {
  const presentation = PRESENTATION[job.status];
  if (!presentation) return;

  const skipped = await countSkipped(env, job.job_id);
  const parts = [
    `${job.direction} · ${job.source_name}`,
    `written ${job.written} · skipped ${skipped} · unmatched ${job.unmatched}`,
  ];
  if (job.error_code) parts.push(`error_code: ${job.error_code}`);

  await sendNtfyNotification(env, {
    title: `Portage copy job ${job.status}`,
    body: parts.join("\n"),
    priority: presentation.priority,
    tags: presentation.tags,
  });
}
