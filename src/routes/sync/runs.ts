// F-011: GET /sync/runs — returns recent sync run list
import { Hono } from "hono";
import type { Env } from "../../env";
import { getRecentRuns } from "../../db/sync_runs";

const runsRoute = new Hono<{ Bindings: Env }>();

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

runsRoute.get("/runs", async (c) => {
  try {
    const raw = parseInt(c.req.query("limit") ?? String(DEFAULT_LIMIT), 10);
    const limit = isNaN(raw) || raw < 1 ? DEFAULT_LIMIT : Math.min(raw, MAX_LIMIT);

    const runs = await getRecentRuns(c.env, limit);
    return c.json({ runs }, 200);
  } catch {
    return c.json({ error: "service_unavailable" }, 503);
  }
});

export default runsRoute;
