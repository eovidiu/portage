import { Hono } from "hono";
import type { Env } from "./env";
import healthRoutes from "./routes/health";
import { secretsGuard } from "./middleware/secrets";
import { jwtMiddleware } from "./middleware/auth";
import spotifyAuthRoutes from "./routes/auth/spotify";
import tidalAuthRoutes from "./routes/auth/tidal";
import syncStatusRoute from "./routes/sync/status";
import syncRunsRoute from "./routes/sync/runs";
import syncRunRoute from "./routes/sync/run";
import statsRoute from "./routes/stats";
import capturesRoute from "./routes/captures";
import { scheduled } from "./scheduled";

const AUTH_SKIP_PATHS = ["/healthz", "/readyz", "/auth/spotify/callback", "/auth/tidal/callback"];

const app = new Hono<{ Bindings: Env }>();

app.use("*", secretsGuard(["/healthz", "/readyz"]));
app.use("*", jwtMiddleware(AUTH_SKIP_PATHS));

app.get("/", (c) => c.text("portage", 200));
app.route("/", healthRoutes);
app.route("/auth", spotifyAuthRoutes);
app.route("/auth", tidalAuthRoutes);
app.route("/sync", syncStatusRoute);
app.route("/sync", syncRunsRoute);
app.route("/sync", syncRunRoute);
app.route("/", statsRoute);
app.route("/", capturesRoute);

export default {
  fetch: app.fetch,
  scheduled,
};
