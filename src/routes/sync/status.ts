// F-011: GET /sync/status — returns most recent sync run summary
import { Hono } from "hono";
import type { Env } from "../../env";
import { getLatestRun, getLatestSucceededAt } from "../../db/sync_runs";

const statusRoute = new Hono<{ Bindings: Env }>();

statusRoute.get("/status", async (c) => {
  try {
    const run = await getLatestRun(c.env);
    if (run === null) {
      return c.json({ status: "no_runs_yet" }, 200);
    }

    const lastSucceededAt = await getLatestSucceededAt(c.env);
    const lagHours = lastSucceededAt
      ? Math.round((Date.now() - new Date(lastSucceededAt).getTime()) / 360000) / 10
      : null;

    return c.json({ ...run, last_succeeded_at: lastSucceededAt, lag_hours: lagHours }, 200);
  } catch {
    return c.json({ error: "service_unavailable" }, 503);
  }
});

export default statusRoute;
