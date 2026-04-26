// F-011: GET /stats — returns aggregate sync statistics over a period
import { Hono } from "hono";
import type { Env } from "../env";
import { aggregateStats } from "../db/sync_runs";

const statsRoute = new Hono<{ Bindings: Env }>();

const VALID_PERIODS = new Set(["day", "week", "month"]);

statsRoute.get("/stats", async (c) => {
  const period = c.req.query("period");
  if (!period || !VALID_PERIODS.has(period)) {
    return c.json({ error: "invalid_period" }, 400);
  }

  try {
    const stats = await aggregateStats(c.env, period as "day" | "week" | "month");
    return c.json(stats, 200);
  } catch {
    return c.json({ error: "service_unavailable" }, 503);
  }
});

export default statsRoute;
