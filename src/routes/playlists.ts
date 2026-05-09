import { Hono } from "hono";
import { neon } from "@neondatabase/serverless";
import type { Env } from "../env";
import {
  getPlaylistConfig,
  listPlaylistConfigs,
  upsertPlaylistConfig,
  type PlaylistConfigRow,
} from "../db/playlist_configs";
import { fetchSpotifyPlaylistName } from "../providers/spotify/playlists";

// F-021 + F-022: /api/playlists endpoints for the operator console.
// GET returns the registry with __liked__ first.
// POST validates the Spotify id format, looks up the existing row (idempotent
// duplicate handling), then resolves the display name from Spotify and
// inserts via the F-016 DB helper.

const SPOTIFY_PLAYLIST_ID_PATTERN = /^[A-Za-z0-9]{22}$/;
const LIKED_KEY = "__liked__";

function sortLikedFirst(rows: PlaylistConfigRow[]): PlaylistConfigRow[] {
  return [...rows].sort((a, b) => {
    if (a.spotify_playlist_id === LIKED_KEY) return -1;
    if (b.spotify_playlist_id === LIKED_KEY) return 1;
    return a.created_at.localeCompare(b.created_at);
  });
}

function classifySpotifyError(message: string): "not_found" | "other" {
  return /\b404\b/.test(message) ? "not_found" : "other";
}

const app = new Hono<{ Bindings: Env }>();

// F-021 — GET /api/playlists
app.get("/playlists", async (c) => {
  const sql = neon(c.env.DATABASE_URL);
  const rows = await listPlaylistConfigs(sql);
  return c.json(sortLikedFirst(rows));
});

// F-022 — POST /api/playlists
app.post("/playlists", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_playlist_id" }, 400);
  }
  const id =
    body && typeof body === "object" && "spotify_playlist_id" in body
      ? (body as { spotify_playlist_id?: unknown }).spotify_playlist_id
      : undefined;
  if (typeof id !== "string" || !SPOTIFY_PLAYLIST_ID_PATTERN.test(id)) {
    return c.json({ error: "invalid_playlist_id" }, 400);
  }

  const sql = neon(c.env.DATABASE_URL);

  const existing = await getPlaylistConfig(sql, id);
  if (existing) {
    return c.json(existing, 200);
  }

  let spotifyName: string;
  try {
    spotifyName = await fetchSpotifyPlaylistName(c.env, id);
  } catch (err) {
    if (classifySpotifyError(String(err)) === "not_found") {
      return c.json({ error: "spotify_playlist_not_found" }, 404);
    }
    return c.json({ error: "spotify_unreachable" }, 502);
  }

  await upsertPlaylistConfig(sql, { spotify_playlist_id: id, spotify_name: spotifyName });
  const inserted: PlaylistConfigRow = {
    spotify_playlist_id: id,
    spotify_name: spotifyName,
    tidal_playlist_id: null,
    created_at: new Date().toISOString(),
    last_synced_at: null,
  };
  return c.json(inserted, 201);
});

export default app;
