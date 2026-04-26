// F-013: Captures API — GET /captures + POST /captures (iOS companion)
import { Hono } from "hono";
import type { Env } from "../env";
import {
  insertCapture,
  findRecentCapture,
  listCaptures,
} from "../db/captures";
import { neon } from "@neondatabase/serverless";
import { spotifyFetch } from "../providers/spotify/oauth";
import { upsertTracks } from "../db/tracks";

const SPOTIFY_ID_RE = /^[A-Za-z0-9]{22}$/;
const VALID_SOURCES = ["siri", "share_sheet", "shortcut", "manual"] as const;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

const capturesRoute = new Hono<{ Bindings: Env }>();

// GET /captures — list with optional date range and pagination
capturesRoute.get("/captures", async (c) => {
  const limitParam = c.req.query("limit");
  const fromParam = c.req.query("from");
  const toParam = c.req.query("to");

  const rawLimit = limitParam !== undefined ? parseInt(limitParam, 10) : DEFAULT_LIMIT;
  const limit = isNaN(rawLimit) || rawLimit < 1 ? DEFAULT_LIMIT : Math.min(rawLimit, MAX_LIMIT);

  try {
    const items = await listCaptures(c.env, limit, fromParam, toParam);
    return c.json({ items }, 200);
  } catch {
    return c.json({ error: "service_unavailable" }, 503);
  }
});

// POST /captures — create a capture event
capturesRoute.post("/captures", async (c) => {
  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }

  // R2: spotify_id required and must match format
  const spotifyId = body["spotify_id"];
  if (spotifyId === undefined || spotifyId === null) {
    return c.json({ error: "missing_spotify_id" }, 400);
  }
  if (typeof spotifyId !== "string" || !SPOTIFY_ID_RE.test(spotifyId)) {
    return c.json({ error: "invalid_spotify_id" }, 400);
  }

  // source required and must be valid enum
  const source = body["source"];
  if (
    typeof source !== "string" ||
    !(VALID_SOURCES as readonly string[]).includes(source)
  ) {
    return c.json({ error: "invalid_source" }, 400);
  }

  // R3: captured_at must be valid ISO 8601 if provided; otherwise default to now()
  let capturedAt: string;
  if (body["captured_at"] !== undefined && body["captured_at"] !== null) {
    const ts = new Date(body["captured_at"] as string);
    if (isNaN(ts.getTime())) {
      return c.json({ error: "invalid_captured_at" }, 400);
    }
    capturedAt = ts.toISOString();
  } else {
    capturedAt = new Date().toISOString();
  }

  // R4: location range validation
  const locationLat = body["location_lat"] !== undefined ? Number(body["location_lat"]) : null;
  const locationLng = body["location_lng"] !== undefined ? Number(body["location_lng"]) : null;

  if (locationLat !== null) {
    if (isNaN(locationLat) || locationLat < -90 || locationLat > 90) {
      return c.json({ error: "invalid_location_lat" }, 400);
    }
  }
  if (locationLng !== null) {
    if (isNaN(locationLng) || locationLng < -180 || locationLng > 180) {
      return c.json({ error: "invalid_location_lng" }, 400);
    }
  }

  // R6: context_note max 500 chars
  const contextNote =
    body["context_note"] !== undefined && body["context_note"] !== null
      ? String(body["context_note"])
      : null;
  if (contextNote !== null && contextNote.length > 500) {
    return c.json({ error: "context_note_too_long" }, 400);
  }

  // R10: idempotency — check for duplicate within 60 seconds
  try {
    const existing = await findRecentCapture(c.env, spotifyId);
    if (existing !== null) {
      const matchStatus = await resolveMatchStatus(c.env, spotifyId);
      return c.json({ ...existing, match_status: matchStatus, tidal_id: null }, 200);
    }
  } catch {
    return c.json({ error: "service_unavailable" }, 503);
  }

  // R7: ensure track exists in tracks table; fetch from Spotify if missing
  try {
    await ensureTrackExists(c.env, spotifyId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "";
    if (msg === "spotify_track_not_found") {
      return c.json({ error: "spotify_track_not_found" }, 400);
    }
    if (msg === "spotify_unauthorized") {
      return c.json({ error: "spotify_reauth_required" }, 503);
    }
    return c.json({ error: "service_unavailable" }, 503);
  }

  // Insert capture
  try {
    const capture = await insertCapture(c.env, {
      spotify_id: spotifyId,
      captured_at: capturedAt,
      location_lat: locationLat,
      location_lng: locationLng,
      source,
      context_note: contextNote,
    });
    return c.json({ ...capture, match_status: "pending" }, 201);
  } catch (err) {
    // FK violation: track insert race — treat as track not found
    const pgErr = err as { code?: string };
    if (pgErr.code === "23503") {
      return c.json({ error: "track_not_found" }, 400);
    }
    return c.json({ error: "service_unavailable" }, 503);
  }
});

async function resolveMatchStatus(
  env: Env,
  spotifyId: string,
): Promise<"matched" | "unmatched" | "pending"> {
  const sql = neon(env.DATABASE_URL);
  const rows = await sql(
    `SELECT
       CASE
         WHEN EXISTS (SELECT 1 FROM matches WHERE spotify_id = $1) THEN 'matched'
         WHEN EXISTS (SELECT 1 FROM unmatched WHERE spotify_id = $1) THEN 'unmatched'
         ELSE 'pending'
       END AS match_status`,
    [spotifyId],
  );
  return (rows[0] as { match_status: string }).match_status as
    "matched" | "unmatched" | "pending";
}

interface SpotifyTrackResponse {
  id: string;
  name: string;
  artists: Array<{ name: string }>;
  album: { name: string };
  duration_ms: number;
  external_ids?: { isrc?: string };
}

async function ensureTrackExists(env: Env, spotifyId: string): Promise<void> {
  const sql = neon(env.DATABASE_URL);

  // Check if track already exists
  const existing = await sql(
    `SELECT spotify_id FROM tracks WHERE spotify_id = $1`,
    [spotifyId],
  );
  if ((existing as unknown[]).length > 0) return;

  // Fetch from Spotify
  const url = `https://api.spotify.com/v1/tracks/${spotifyId}`;
  const response = await spotifyFetch(env, url);

  if (response.status === 401) {
    throw new Error("spotify_unauthorized");
  }
  if (response.status === 404) {
    throw new Error("spotify_track_not_found");
  }
  if (!response.ok) {
    throw new Error("service_unavailable");
  }

  const track = (await response.json()) as SpotifyTrackResponse;

  await upsertTracks(sql, [
    {
      spotify_id: track.id,
      isrc: track.external_ids?.isrc ?? null,
      artist: track.artists[0]?.name ?? "",
      title: track.name,
      album: track.album?.name ?? null,
      duration_ms: track.duration_ms ?? null,
      spotify_added_at: new Date().toISOString(),
    },
  ]);
}

export default capturesRoute;
