// F-030 tasks 2.2 + 2.6: copy-job tick engine. Idle fast-path (one query),
// shared advisory lock (D2), one phase step per tick (D6), terminal-state
// handling + ntfy notification (D10).

import type { Env } from "../env";
import {
  loadActiveJob,
  getJob,
  setStatus,
  recomputeCounters,
  NON_TERMINAL_STATUSES,
  type CopyJobRow,
} from "../db/copy_jobs";
import { countPending } from "../db/copy_job_tracks";
import { acquireLock, releaseLock } from "../sync/lock";
import { runFetchPhaseStep } from "./fetch";
import { runMatchPhaseStep } from "./match";
import { runWritePhaseStep } from "./write";
import { notifyCopyJobTerminal } from "./notify";

const DEFAULT_BATCH = 2;

function readBudget(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_BATCH;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_BATCH;
}

export interface CopyTickResult {
  outcome: "idle" | "skipped_locked" | "advanced" | "no_active_job_after_lock";
  job_id?: string;
}

async function dispatchPhaseStep(
  env: Env,
  job: CopyJobRow,
  isrcBudget: number,
  fuzzyBudget: number,
): Promise<void> {
  switch (job.status) {
    case "queued":
    case "fetching":
      await runFetchPhaseStep(env, job);
      return;
    case "matching":
      await runMatchPhaseStep(env, job, isrcBudget, fuzzyBudget);
      return;
    case "writing":
      await runWritePhaseStep(env, job);
      return;
    default:
      // Terminal status observed after lock acquisition — nothing to do.
      return;
  }
}

/** Flips matching -> writing once every track has left the pending state. */
async function maybeAdvanceMatching(env: Env, job: CopyJobRow): Promise<void> {
  if (job.status !== "matching") return;
  const pending = await countPending(env, job.job_id);
  if (pending === 0) await setStatus(env, job.job_id, "writing");
}

/** Lands the job in a terminal state once no matched rows remain to write. */
async function maybeCompleteWriting(env: Env, job: CopyJobRow): Promise<void> {
  if (job.status !== "writing") return;
  const counters = await recomputeCounters(env, job.job_id);
  if (counters.matched > 0) return;

  const status = counters.unmatched > 0 ? "completed_with_unmatched" : "completed";
  const finished_at = new Date().toISOString();
  await setStatus(env, job.job_id, status, { finished_at });
  await notifyCopyJobTerminal(env, { ...job, status, finished_at, ...counters });
}

/** One copy-job tick: idle fast-path, lock-or-skip, one phase step, persist. */
export async function runCopyTick(env: Env): Promise<CopyTickResult> {
  const active = await loadActiveJob(env);
  if (!active) return { outcome: "idle" };

  const session = await acquireLock(env);
  if (!session) return { outcome: "skipped_locked" };

  try {
    const job = await getJob(env, active.job_id);
    if (!job || !NON_TERMINAL_STATUSES.includes(job.status)) {
      return { outcome: "no_active_job_after_lock" };
    }

    const isrcBudget = readBudget(env.COPY_BATCH_ISRC);
    const fuzzyBudget = readBudget(env.COPY_BATCH_FUZZY);

    await dispatchPhaseStep(env, job, isrcBudget, fuzzyBudget);
    await maybeAdvanceMatching(env, job);
    await maybeCompleteWriting(env, job);

    return { outcome: "advanced", job_id: job.job_id };
  } finally {
    await releaseLock(session);
  }
}
