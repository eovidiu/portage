/**
 * T-009-10: Orchestrator wall-time cap real timing (F-009-R4).
 *
 * Approach: WALL_TIME_OVERRIDE_MS env hook. src/sync/orchestrator.ts reads
 * `env.WALL_TIME_OVERRIDE_MS` (optional) to override the 300 s production cap.
 * Set WALL_TIME_OVERRIDE_MS=1 in .dev.vars so the real setTimeout fires before any
 * provider call can return. Production is unaffected (env var absent → 300_000 ms).
 *
 * With a 1 ms override the timeout fires essentially immediately after the race starts,
 * winning before fetchLikedSongs can return. The orchestrator returns outcome=partial
 * with error_code=wall_time_exceeded and the POST /sync/run handler reflects this.
 *
 * Note: runSyncBody continues executing after the race resolves and may later overwrite
 * the DB row status. We assert on the POST /sync/run response (in-memory outcome), not
 * on GET /sync/status (DB state), to avoid that race condition.
 *
 * Hardware note: test timeout is 25 s. The elapsed assertion of < 15 s guards against
 * the override not being read (which would produce a 300 s wait or an immediate Spotify
 * auth failure returning "failed" instead of "partial").
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startWrangler, stopWrangler, mintToken } from "./harness.js";

const BASE_URL = "http://localhost:8787";

beforeAll(async () => {
  await startWrangler();
});

afterAll(async () => {
  await stopWrangler();
});

describe("T-009-10: Orchestrator wall-time cap (real timing)", () => {
  it(
    "POST /sync/run returns outcome=partial with wall_time_exceeded in < 15 s when WALL_TIME_OVERRIDE_MS=1",
    async () => {
      const token = await mintToken();

      const start = performance.now();
      const res = await fetch(`${BASE_URL}/sync/run`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      const elapsed = performance.now() - start;

      // 409 means another run held the lock; skip rather than fail.
      if (res.status === 409) {
        console.info("T-009-10 skipped: another run held the lock (skipped_locked)");
        return;
      }

      expect(res.status).toBe(200);
      const body = await res.json() as { run_id?: string; status?: string };

      console.info(
        `T-009-10 outcome=${body.status} run_id=${body.run_id} elapsed=${elapsed.toFixed(0)} ms`
      );

      // The orchestrator race fires at 1 ms → outcome must be partial.
      // If the override wasn't read (300_000 ms default), runSyncBody would return
      // "failed" (Spotify auth error) before wall-time fires, and outcome would be "failed".
      expect(body.run_id).toBeTruthy();
      expect(body.status).toBe("partial");

      // Elapsed must be well under 15 s. A missing override would produce either a
      // 300 s stall or an immediate "failed" outcome — both detected by this assertion.
      expect(elapsed).toBeLessThan(15_000);
    },
    25_000
  );
});
