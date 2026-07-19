// F-030 tasks 2.2 + 2.6: copy-job tick engine. Idle fast-path (one query),
// shared advisory lock (D2), one phase step per tick (D6), terminal-state
// handling + ntfy notification (D10).

import type { Env } from "../env";
import {
  loadActiveJob,
  getJob,
  setStatus,
  recomputeCounters,
  incrementConsecutiveErrors,
  resetConsecutiveErrors,
  NON_TERMINAL_STATUSES,
  type CopyJobRow,
} from "../db/copy_jobs";
import { countPending } from "../db/copy_job_tracks";
import { acquireLock, releaseLock } from "../sync/lock";
import { runFetchPhaseStep } from "./fetch";
import { runMatchPhaseStep } from "./match";
import { runWritePhaseStep } from "./write";
import { notifyCopyJobTerminal } from "./notify";
import { SpotifyAuthError } from "../providers/spotify/oauth";
import { IntegrityError } from "../crypto";

const DEFAULT_BATCH = 2;
// F-030 review B3: schema.sql's copy_jobs.consecutive_errors comment — a job
// that errors this many ticks in a row is failed with 'tick_error_streak'
// rather than retried forever, so it doesn't block the single-active-job slot.
const MAX_CONSECUTIVE_ERRORS = 5;

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

/**
 * Lands the job in a terminal state once no matched rows remain to write.
 * setStatus's guarded UPDATE (review S2) returns `false` when a concurrent
 * cancel landed the job in 'cancelled' between this tick's job load and this
 * write — in that case the DB never actually recorded "completed", so the
 * terminal notification MUST be skipped rather than announcing a status the
 * row doesn't hold.
 */
async function maybeCompleteWriting(env: Env, job: CopyJobRow): Promise<void> {
  if (job.status !== "writing") return;
  const counters = await recomputeCounters(env, job.job_id);
  if (counters.matched > 0) return;

  const status = counters.unmatched > 0 ? "completed_with_unmatched" : "completed";
  const finished_at = new Date().toISOString();
  const applied = await setStatus(env, job.job_id, status, { finished_at });
  if (!applied) return;
  await notifyCopyJobTerminal(env, { ...job, status, finished_at, ...counters });
}

// F-030 review B3: classifies an uncaught tick error. Auth/decrypt failures
// are non-retryable (the same class the sync orchestrator's classifyFetchError
// treats as fatal, src/sync/orchestrator.ts) — fail the job immediately
// instead of burning through the retry streak. Everything else is treated as
// transient and only fails the job once MAX_CONSECUTIVE_ERRORS ticks in a row
// have errored.
type FatalTickErrorCode = "spotify_reauth_required" | "decrypt_failed";

function classifyTickError(err: unknown): FatalTickErrorCode | "transient" {
  if (err instanceof SpotifyAuthError && err.code === "reauth_required") {
    return "spotify_reauth_required";
  }
  if (err instanceof IntegrityError) return "decrypt_failed";
  return "transient";
}

/** Fails the job (S2-guarded — a no-op if it already went terminal concurrently). */
async function failJob(
  env: Env,
  job: CopyJobRow,
  errorCode: FatalTickErrorCode | "tick_error_streak",
): Promise<void> {
  const finished_at = new Date().toISOString();
  const applied = await setStatus(env, job.job_id, "failed", { error_code: errorCode, finished_at });
  if (!applied) return;
  const counters = await recomputeCounters(env, job.job_id);
  await notifyCopyJobTerminal(env, { ...job, status: "failed", error_code: errorCode, finished_at, ...counters });
}

/**
 * B3: handles a phase-step failure. Non-retryable errors (auth/decrypt) fail
 * the job outright. Everything else increments the job's consecutive-error
 * streak and only fails it once the streak hits MAX_CONSECUTIVE_ERRORS,
 * letting a transient blip (a dropped Neon connection, a provider 5xx) retry
 * on the next cron tick without losing the job.
 */
async function handleTickError(env: Env, job: CopyJobRow, err: unknown): Promise<void> {
  const classification = classifyTickError(err);
  console.log(
    JSON.stringify({
      event: "copy_tick_error",
      job_id: job.job_id,
      classification,
      message: err instanceof Error ? err.message : String(err),
    }),
  );

  if (classification !== "transient") {
    await failJob(env, job, classification);
    return;
  }

  const streak = await incrementConsecutiveErrors(env, job.job_id);
  if (streak >= MAX_CONSECUTIVE_ERRORS) {
    await failJob(env, job, "tick_error_streak");
  }
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

    try {
      await dispatchPhaseStep(env, job, isrcBudget, fuzzyBudget);
      await maybeAdvanceMatching(env, job);
      await maybeCompleteWriting(env, job);
      await resetConsecutiveErrors(env, job.job_id);
    } catch (err) {
      await handleTickError(env, job, err);
    }

    return { outcome: "advanced", job_id: job.job_id };
  } finally {
    await releaseLock(session);
  }
}
