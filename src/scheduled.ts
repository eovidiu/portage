import type { Env } from "./env";
import { runSync } from "./sync/orchestrator";

export async function scheduled(
  _event: ScheduledEvent,
  env: Env,
  ctx: ExecutionContext,
): Promise<void> {
  const syncPromise = runSync(env).then((result) => {
    if (result.outcome === "skipped_locked") {
      console.log(
        JSON.stringify({
          event: "scheduled_skipped_locked",
          run_id: result.run_id,
        }),
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
  }).catch((err: unknown) => {
    console.log(
      JSON.stringify({
        event: "scheduled_failed",
        message: err instanceof Error ? err.message : String(err),
      }),
    );
  });

  ctx.waitUntil(syncPromise);
}
