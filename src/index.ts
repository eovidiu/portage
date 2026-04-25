import { Hono } from "hono";
import type { Env } from "./env";
import healthRoutes from "./routes/health";

const app = new Hono<{ Bindings: Env }>();

app.get("/", (c) => c.text("portage", 200));
app.route("/", healthRoutes);

export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledEvent, _env: Env, _ctx: ExecutionContext): Promise<void> {
    // sync handler — implemented by F010
  },
};
