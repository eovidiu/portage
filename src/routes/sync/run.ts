import { Hono } from "hono";
import type { Env } from "../../env";
import { runSync, type OrchestratorResult } from "../../sync/orchestrator";
import { getLatestRun } from "../../db/sync_runs";

const MANUAL_TIMEOUT_MS = 25_000;

const router = new Hono<{ Bindings: Env }>();

router.post("/run", async (c) => {
  const startedAt = Date.now();

  const orchestratorPromise = runSync(c.env);
  const timeoutPromise = new Promise<"timeout">((resolve) =>
    setTimeout(() => resolve("timeout"), MANUAL_TIMEOUT_MS),
  );

  const raceResult = await Promise.race([orchestratorPromise, timeoutPromise]);

  if (raceResult === "timeout") {
    const latestRun = await getLatestRun(c.env);
    return c.json(
      {
        run_id: latestRun?.run_id ?? null,
        status: "running",
      },
      202,
    );
  }

  const result = raceResult as OrchestratorResult;

  if (result.outcome === "skipped_locked") {
    const latestRun = await getLatestRun(c.env);
    return c.json(
      {
        error: "run_in_progress",
        current_run_id: latestRun?.run_id ?? null,
      },
      409,
    );
  }

  const duration_ms = Date.now() - startedAt;
  return c.json(
    {
      run_id: result.run_id ?? null,
      status: result.outcome,
      tracks_seen: result.tracks_seen ?? 0,
      matched_isrc: result.matched_isrc ?? 0,
      matched_fuzzy: result.matched_fuzzy ?? 0,
      unmatched: result.unmatched ?? 0,
      errors: result.errors ?? 0,
      duration_ms,
    },
    200,
  );
});

export default router;
