import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env } from "./env";
import healthRoutes from "./routes/health";
import { secretsGuard } from "./middleware/secrets";
import { jwtMiddleware } from "./middleware/auth";
import { cfAccessMiddleware } from "./middleware/cf_access";
import spotifyAuthRoutes from "./routes/auth/spotify";
import tidalAuthRoutes from "./routes/auth/tidal";
import syncStatusRoute from "./routes/sync/status";
import syncRunsRoute from "./routes/sync/runs";
import syncRunRoute from "./routes/sync/run";
import statsRoute from "./routes/stats";
import capturesRoute from "./routes/captures";
import unmatchedRoute from "./routes/unmatched";
import { scheduled } from "./scheduled";

const AUTH_SKIP_PATHS = ["/healthz", "/readyz", "/auth/spotify/callback", "/auth/tidal/callback"];
const ALLOWED_UI_ORIGINS = new Set([
  "https://app.portage.eovidiu.co.uk",
  "http://localhost:5173",
]);

const app = new Hono<{ Bindings: Env }>();

app.use(
  "*",
  cors({
    origin: (origin) => (ALLOWED_UI_ORIGINS.has(origin ?? "") ? origin : null),
    allowHeaders: ["Authorization", "Content-Type"],
    allowMethods: ["GET", "POST", "OPTIONS"],
    credentials: true,
    maxAge: 600,
  })
);
app.use("*", secretsGuard(["/healthz", "/readyz"]));
app.use("*", cfAccessMiddleware(AUTH_SKIP_PATHS));
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
app.route("/unmatched", unmatchedRoute);

export default {
  fetch: app.fetch,
  scheduled,
};
