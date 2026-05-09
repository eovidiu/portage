import { Hono } from "hono";
import type { Env } from "../env";
import type { Principal } from "../middleware/cf_access";

// F-020: GET /api/me — returns the authenticated principal so the SPA's
// AuthGate knows who is signed in. The caller is always authenticated by the
// time this handler runs (cfAccessMiddleware or jwtMiddleware sets
// c.var.principal); a missing principal here would be a middleware bug.
const app = new Hono<{ Bindings: Env; Variables: { principal: Principal } }>();

app.get("/me", (c) => {
  const principal = c.get("principal");
  if (principal.kind === "user") {
    return c.json({ email: principal.email, kind: "user" });
  }
  return c.json({ kind: "service" });
});

export default app;
