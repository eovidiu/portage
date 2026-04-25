import { Hono } from "hono";
import type { Env } from "../../env";
import { initiateOAuth, exchangeCode } from "../../providers/tidal/oauth";

const tidalAuthRoutes = new Hono<{ Bindings: Env }>();

tidalAuthRoutes.get("/tidal", async (c) => {
  const redirectUrl = await initiateOAuth(c.env);
  return c.redirect(redirectUrl, 302);
});

tidalAuthRoutes.get("/tidal/callback", async (c) => {
  const error = c.req.query("error");
  if (error) {
    return c.json({ error: "user_denied" }, 400);
  }

  const code = c.req.query("code");
  const state = c.req.query("state");

  if (!code || !state) {
    return c.json({ error: "invalid_state" }, 400);
  }

  try {
    await exchangeCode(c.env, code, state);
    return c.json({ status: "connected", provider: "tidal" }, 200);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message === "invalid_state") {
      return c.json({ error: "invalid_state" }, 400);
    }
    return c.json({ error: "token_exchange_failed" }, 400);
  }
});

export default tidalAuthRoutes;
