import type { Env } from "./env";
import { runSync } from "./sync/orchestrator";
import { runCopyTick } from "./copy/engine";

// F-030 D1: the two original schedules keep driving runSync unchanged; any
// other cron expression (the new "*/5 * * * *") drives the copy-job engine.
const SYNC_CRONS = new Set(["23 7 * * *", "23 19 * * *"]);

async function runSyncTick(env: Env): Promise<void> {
  try {
    const result = await runSync(env);
    if (result.outcome === "skipped_locked") {
      console.log(
        JSON.stringify({ event: "scheduled_skipped_locked", run_id: result.run_id }),
      );
    } else {
      console.log(
        JSON.stringify({
          event: "scheduled_completed",
          outcome: result.outcome,
          run_id: result.run_id,
          error_code: result.error_code,
          tracks_seen: result.tracks_seen,
          matched_isrc: result.matched_isrc,
          matched_fuzzy: result.matched_fuzzy,
          unmatched: result.unmatched,
          errors: result.errors,
        }),
      );
    }
  } catch (err) {
    console.log(
      JSON.stringify({
        event: "scheduled_failed",
        message: err instanceof Error ? err.message : String(err),
      }),
    );
  }
}

async function runCopyTickJob(env: Env): Promise<void> {
  try {
    const result = await runCopyTick(env);
    console.log(JSON.stringify({ event: "scheduled_copy_tick_completed", ...result }));
  } catch (err) {
    console.log(
      JSON.stringify({
        event: "scheduled_copy_tick_failed",
        message: err instanceof Error ? err.message : String(err),
      }),
    );
  }
}

export async function scheduled(
  event: ScheduledEvent,
  env: Env,
  ctx: ExecutionContext,
): Promise<void> {
  const promise = SYNC_CRONS.has(event.cron) ? runSyncTick(env) : runCopyTickJob(env);
  ctx.waitUntil(promise);
}
