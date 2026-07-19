// F-030 task 3.1: GET /api/copy/playlists — browse own playlists per provider.

import { Hono } from "hono";
import type { Env } from "../../env";
import { hasSpotifyScopes } from "../../db/provider_tokens";
import { listOwnPlaylists as listTidalOwnPlaylists } from "../../providers/tidal/own-playlists";
import { listOwnPlaylists as listSpotifyOwnPlaylists } from "../../providers/spotify/playlists";

const READ_SCOPE = "playlist-read-private";

const app = new Hono<{ Bindings: Env }>();

app.get("/playlists", async (c) => {
  const provider = c.req.query("provider");
  if (provider !== "spotify" && provider !== "tidal") {
    return c.json({ error: "invalid_provider" }, 422);
  }

  const cursor = c.req.query("cursor") ?? null;

  if (provider === "spotify") {
    if (!(await hasSpotifyScopes(c.env, [READ_SCOPE]))) {
      return c.json({ error: "spotify_reauth_required" }, 409);
    }
    const offset = cursor !== null ? parseInt(cursor, 10) : 0;
    const page = await listSpotifyOwnPlaylists(c.env, offset);
    return c.json({
      playlists: page.playlists.map((p) => ({ id: p.id, name: p.name, track_count: p.trackCount })),
      next_cursor: page.nextOffset !== null ? String(page.nextOffset) : null,
    });
  }

  const page = await listTidalOwnPlaylists(c.env, cursor);
  return c.json({
    playlists: page.playlists.map((p) => ({
      id: p.id,
      name: p.name,
      track_count: p.numberOfItems ?? 0,
    })),
    next_cursor: page.cursor,
  });
});

export default app;
