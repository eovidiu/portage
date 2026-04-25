import { Hono } from "hono";
import type { Env } from "./env";
import healthRoutes from "./routes/health";
import { secretsGuard } from "./middleware/secrets";
import { jwtMiddleware } from "./middleware/auth";
import spotifyAuthRoutes from "./routes/auth/spotify";
import tidalAuthRoutes from "./routes/auth/tidal";

const AUTH_SKIP_PATHS = ["/healthz", "/readyz", "/auth/spotify/callback", "/auth/tidal/callback"];

const app = new Hono<{ Bindings: Env }>();

app.use("*", secretsGuard(["/healthz", "/readyz"]));
app.use("*", jwtMiddleware(AUTH_SKIP_PATHS));

app.get("/", (c) => c.text("portage", 200));
app.route("/", healthRoutes);
app.route("/auth", spotifyAuthRoutes);
app.route("/auth/tidal", tidalAuthRoutes);

export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledEvent, _env: Env, _ctx: ExecutionContext): Promise<void> {
    // sync handler — implemented by F010
  },
};
