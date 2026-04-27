// F-012: Unmatched review queue — GET /unmatched + POST /unmatched/:spotify_id/match + skip
import { Hono } from "hono";
import type { Env } from "../env";
import { listPending, markMatched, markSkipped } from "../db/unmatched";
import { tidalFetch } from "../providers/tidal/client";

const LIMIT_DEFAULT = 20;
const LIMIT_MAX = 100;

// Used as `${TIDAL_TRACKS_BASE}/${tidal_id}` to confirm a manually-supplied
// tidal_id resolves before the I-001 atomic move (markMatched). Only the HTTP
// status is consulted — the response body is intentionally ignored, so the
// JSON:API shape of Tracks_Single_Resource_Data_Document doesn't need parsing
// here. 404 → bad input; non-2xx → service unavailable.
// Verified: 2026-04-27 against https://tidal-music.github.io/tidal-api-reference/tidal-api-oas.json (path /v2/tracks/{id} GET; path param id required; 404 documented as Default404ResponseBody; countryCode optional, injected by tidalFetch).
const TIDAL_TRACKS_BASE = "https://openapi.tidal.com/v2/tracks";

const unmatchedRoute = new Hono<{ Bindings: Env }>();

unmatchedRoute.get("/", async (c) => {
  const rawLimit = parseInt(c.req.query("limit") ?? String(LIMIT_DEFAULT), 10);
  const limit = isNaN(rawLimit) || rawLimit < 1
    ? LIMIT_DEFAULT
    : Math.min(rawLimit, LIMIT_MAX);

  try {
    const rows = await listPending(c.env, { limit });
    const items = rows.map((r) => ({ ...r, candidates: r.candidates ?? [] }));
    return c.json({ items });
  } catch {
    return c.json({ error: "service_unavailable" }, 503);
  }
});

unmatchedRoute.post("/:spotify_id/match", async (c) => {
  const spotifyId = c.req.param("spotify_id");

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_body" }, 400);
  }

  if (
    typeof body !== "object" ||
    body === null ||
    typeof (body as Record<string, unknown>).tidal_id !== "string"
  ) {
    return c.json({ error: "missing_tidal_id" }, 400);
  }

  const tidalId = (body as { tidal_id: string }).tidal_id;

  let tidalRes: Response;
  try {
    tidalRes = await tidalFetch(c.env, `${TIDAL_TRACKS_BASE}/${encodeURIComponent(tidalId)}`);
  } catch {
    return c.json({ error: "tidal_unavailable" }, 503);
  }

  if (tidalRes.status === 404) {
    return c.json({ error: "tidal_track_not_found" }, 400);
  }

  if (!tidalRes.ok) {
    return c.json({ error: "tidal_unavailable" }, 503);
  }

  try {
    const result = await markMatched(c.env, spotifyId, tidalId);
    return c.json(result, 200);
  } catch {
    return c.json({ error: "service_unavailable" }, 503);
  }
});

unmatchedRoute.post("/:spotify_id/skip", async (c) => {
  const spotifyId = c.req.param("spotify_id");

  try {
    const result = await markSkipped(c.env, spotifyId);
    return c.json(result, 200);
  } catch {
    return c.json({ error: "service_unavailable" }, 503);
  }
});

export default unmatchedRoute;
