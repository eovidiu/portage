// F-032: advisory "a copy job is active" flag in KV. The five-minute cron fires
// 288x/day and Neon's free plan autosuspends only after 5 minutes of inactivity
// (not configurable), so runCopyTick's unconditional loadActiveJob held the
// compute awake 99.7% of wall clock — 86 of the 100 monthly CU-hours burned in
// 13 days against 4 copy jobs ever, none since 2026-07-26. The tick now reads
// this flag first and skips Neon entirely when it is absent.
//
// The flag is a cache of copy_jobs, never a source of truth: every failure path
// reports "maybe active" so the caller runs the authoritative query it ran
// before this existed. Correctness depends only on copy_jobs; only cost depends
// on KV.
//
// Imports nothing but the Env type on purpose — src/db/copy_jobs.ts imports this
// module, so a DB import here would close a cycle.

import type { Env } from "../env";

const ACTIVE_JOB_KEY = "active_job";

function logFlagFailure(operation: string, err: unknown): void {
  console.log(
    JSON.stringify({
      event: "copy_active_flag_failed",
      operation,
      message: err instanceof Error ? err.message : String(err),
    }),
  );
}

/**
 * False only when KV positively reports the key absent. Any failure returns true
 * so the caller falls through to loadActiveJob — a KV outage costs money (one
 * idle Neon query per tick), never correctness.
 */
export async function mayHaveActiveCopyJob(env: Env): Promise<boolean> {
  try {
    return (await env.COPY_STATE.get(ACTIVE_JOB_KEY)) !== null;
  } catch (err) {
    logFlagFailure("get", err);
    return true;
  }
}

/**
 * Armed when a job is created, and re-armed wherever a live job is observed.
 * Never throws: a lost write degrades to "the tick skips a live job until
 * something re-arms the flag", which must not fail job creation.
 */
export async function markCopyJobActive(env: Env): Promise<void> {
  try {
    await env.COPY_STATE.put(ACTIVE_JOB_KEY, "1");
  } catch (err) {
    logFlagFailure("put", err);
  }
}

/**
 * Released on every terminal transition. Also never throws — a lost release only
 * costs the idle Neon query that the next tick self-heals away.
 */
export async function clearCopyJobActive(env: Env): Promise<void> {
  try {
    await env.COPY_STATE.delete(ACTIVE_JOB_KEY);
  } catch (err) {
    logFlagFailure("delete", err);
  }
}
