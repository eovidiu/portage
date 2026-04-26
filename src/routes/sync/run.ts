import { Hono } from "hono";
import type { Env } from "../../env";
import { runSync } from "../../sync/orchestrator";

const router = new Hono<{ Bindings: Env }>();

router.post("/run", async (c) => {
  const result = await runSync(c.env);
  const status = result.outcome === "skipped_locked" ? 409 : 200;
  return c.json(result, status);
});

export default router;
