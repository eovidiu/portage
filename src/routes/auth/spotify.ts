// F-002: Spotify OAuth routes — /auth/spotify (initiate) + /auth/spotify/callback
import { Hono } from "hono";
import type { Env } from "../../env";
import { initiateSpotifyOAuth, handleCallback, SpotifyAuthError } from "../../providers/spotify/oauth";

const spotifyAuthRoutes = new Hono<{ Bindings: Env }>();

// GET /auth/spotify — requires bootstrap JWT (enforced by middleware in src/index.ts)
spotifyAuthRoutes.get("/spotify", async (c) => {
  const result = await initiateSpotifyOAuth(c.env);
  return c.redirect(result.authorizeUrl, 302);
});

// GET /auth/spotify/callback — no JWT, state-validated
spotifyAuthRoutes.get("/spotify/callback", async (c) => {
  const code = c.req.query("code");
  const state = c.req.query("state");
  const error = c.req.query("error");

  try {
    await handleCallback(c.env, { code, state, error });
    return c.json({ status: "connected", provider: "spotify" }, 200);
  } catch (err) {
    const code_ = err instanceof SpotifyAuthError ? err.code : "token_exchange_failed";
    return c.json({ error: code_ }, 400);
  }
});

export default spotifyAuthRoutes;
