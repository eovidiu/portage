// F-011: GET /sync/runs — returns recent sync run list
// F-027: GET /sync/runs/:run_id/tracks — per-run track manifest
import { Hono } from "hono";
import type { Env } from "../../env";
import { getRecentRuns, listRunTracks, runExists } from "../../db/sync_runs";

const runsRoute = new Hono<{ Bindings: Env }>();

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

const TRACKS_DEFAULT_LIMIT = 50;
const TRACKS_MAX_LIMIT = 200;
const ALLOWED_STATUS = new Set(["matched", "unmatched", "all"]);
const ALLOWED_METHOD = new Set(["isrc", "fuzzy", "manual"]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

runsRoute.get("/runs", async (c) => {
  try {
    const raw = parseInt(c.req.query("limit") ?? String(DEFAULT_LIMIT), 10);
    const limit = isNaN(raw) || raw < 1 ? DEFAULT_LIMIT : Math.min(raw, MAX_LIMIT);

    const runs = await getRecentRuns(c.env, limit);
    return c.json({ runs }, 200);
  } catch {
    return c.json({ error: "service_unavailable" }, 503);
  }
});

// F-027 — GET /sync/runs/:run_id/tracks
runsRoute.get("/runs/:run_id/tracks", async (c) => {
  const runId = c.req.param("run_id");

  // Validate run_id shape before touching the DB. A malformed id couldn't
  // possibly match anything; treat it as not-found rather than 500.
  if (!UUID_RE.test(runId)) {
    return c.json({ error: "run_not_found" }, 404);
  }

  const exists = await runExists(c.env, runId);
  if (!exists) {
    return c.json({ error: "run_not_found" }, 404);
  }

  const rawLimit = parseInt(
    c.req.query("limit") ?? String(TRACKS_DEFAULT_LIMIT),
    10,
  );
  const limit =
    isNaN(rawLimit) || rawLimit < 1
      ? TRACKS_DEFAULT_LIMIT
      : Math.min(rawLimit, TRACKS_MAX_LIMIT);

  const rawOffset = parseInt(c.req.query("offset") ?? "0", 10);
  const offset = isNaN(rawOffset) || rawOffset < 0 ? 0 : rawOffset;

  const statusParam = c.req.query("status");
  const status = statusParam && ALLOWED_STATUS.has(statusParam)
    ? (statusParam as "matched" | "unmatched" | "all")
    : "all";

  const methodParam = c.req.query("method");
  const method = methodParam && ALLOWED_METHOD.has(methodParam)
    ? (methodParam as "isrc" | "fuzzy" | "manual")
    : undefined;

  const result = await listRunTracks(c.env, runId, {
    status,
    method,
    limit,
    offset,
  });
  return c.json(result, 200);
});

export default runsRoute;
