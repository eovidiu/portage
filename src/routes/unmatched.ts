// F-012: Unmatched review queue — GET /unmatched + POST /unmatched/:spotify_id/match + skip
// F-024: GET /unmatched/:spotify_id/search — manual Tidal catalog search proxy
// F-025: GET /unmatched/rematch + GET /unmatched/:spotify_id/rematch — short-query heuristic sweep
import { Hono } from "hono";
import type { Env } from "../env";
import {
  listPending,
  markMatched,
  markSkipped,
  getUnmatchedCountByEnv,
  getPendingUnmatched,
} from "../db/unmatched";
import { trackExists } from "../db/tracks";
import { tidalFetch } from "../providers/tidal/client";
import { TidalReauthRequired } from "../providers/tidal/oauth";
import { searchTidalCandidates } from "../match/tidal-search";
import {
  buildRematchQuery,
  runRematchSweep,
  searchOneRematch,
  summariseSweep,
  emitRowLog,
} from "../match/rematch";
import { validateSearchQuery, validateSearchLimit } from "./search-validation";
import { mapCandidateToResponseShape } from "./search-mapper";
import { takeToken } from "../middleware/rate-limit";

const LIMIT_DEFAULT = 20;
const LIMIT_MAX = 100;
const SEARCH_TIMEOUT_MS = 3_000;

// F-025: rematch sweep limits. Default 10 keeps p95 under a few seconds at
// ~300ms/row; cap of 25 leaves headroom under the Workers 50-subrequest
// budget even when tidalFetch follows its 401-refresh fallback path.
const REMATCH_LIMIT_DEFAULT = 10;
const REMATCH_LIMIT_MAX = 25;
const REMATCH_PER_ROW_TIMEOUT_MS = 3_000;
const REMATCH_CANDIDATES_PER_ROW = 5;

// Used as `${TIDAL_TRACKS_BASE}/${tidal_id}` to confirm a manually-supplied
// tidal_id resolves before the I-001 atomic move (markMatched). Only the HTTP
// status is consulted — the response body is intentionally ignored, so the
// JSON:API shape of Tracks_Single_Resource_Data_Document doesn't need parsing
// here. 404 → bad input; non-2xx → service unavailable.
// Verified: 2026-04-27 against https://tidal-music.github.io/tidal-api-reference/tidal-api-oas.json (path /v2/tracks/{id} GET; path param id required; 404 documented as Default404ResponseBody; countryCode optional, injected by tidalFetch).
const TIDAL_TRACKS_BASE = "https://openapi.tidal.com/v2/tracks";

type RoutePrincipal = { kind: "user"; email: string } | { kind: "service" };
const unmatchedRoute = new Hono<{
  Bindings: Env;
  Variables: { principal?: RoutePrincipal };
}>();

unmatchedRoute.get("/", async (c) => {
  const rawLimit = parseInt(c.req.query("limit") ?? String(LIMIT_DEFAULT), 10);
  const limit = isNaN(rawLimit) || rawLimit < 1
    ? LIMIT_DEFAULT
    : Math.min(rawLimit, LIMIT_MAX);

  try {
    const [rows, total] = await Promise.all([
      listPending(c.env, { limit }),
      getUnmatchedCountByEnv(c.env),
    ]);
    const items = rows.map((r) => ({ ...r, candidates: r.candidates ?? [] }));
    return c.json({ items, total });
  } catch {
    return c.json({ error: "service_unavailable" }, 503);
  }
});

// F-025: rematch sweep — static path MUST be registered before the
// parametric `/:spotify_id/match` so Hono matches `/rematch` against this
// handler instead of treating "rematch" as a spotify_id.
unmatchedRoute.get("/rematch", async (c) => {
  const startedAtMs = Date.now();

  const rawLimit = c.req.query("limit");
  let limit = REMATCH_LIMIT_DEFAULT;
  if (rawLimit !== undefined && rawLimit !== "") {
    if (!/^-?\d+$/.test(rawLimit)) {
      return c.json(
        { error: "invalid_limit", message: "limit must be an integer" },
        400,
      );
    }
    const n = parseInt(rawLimit, 10);
    if (n < 1 || n > REMATCH_LIMIT_MAX) {
      return c.json(
        {
          error: "invalid_limit",
          message: `limit must be between 1 and ${REMATCH_LIMIT_MAX}`,
        },
        400,
      );
    }
    limit = n;
  }

  let totalPending: number;
  try {
    totalPending = await getUnmatchedCountByEnv(c.env);
  } catch {
    return c.json(
      { error: "service_unavailable", message: "Database unavailable" },
      503,
    );
  }

  let result;
  try {
    result = await runRematchSweep(c.env, totalPending, {
      limit,
      perRowTimeoutMs: REMATCH_PER_ROW_TIMEOUT_MS,
      candidatesPerRow: REMATCH_CANDIDATES_PER_ROW,
    });
  } catch {
    return c.json(
      { error: "service_unavailable", message: "Database unavailable" },
      503,
    );
  }

  const summary = summariseSweep(result);
  console.log(
    JSON.stringify({
      event: "rematch_sweep",
      limit,
      ...summary,
      duration_ms: Date.now() - startedAtMs,
    }),
  );

  return c.json(result, 200);
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

// F-024: manual Tidal catalog search. The route nests under /unmatched/:spotify_id
// so it inherits the same CF Access + JWT middleware the rest of the router does
// (applied at app level in src/index.ts), and so the spotify_id stays paired with
// the existing /match and /skip handlers in the UI's mental model.
unmatchedRoute.get("/:spotify_id/search", async (c) => {
  const startedAtMs = Date.now();
  const spotifyId = c.req.param("spotify_id");

  const queryResult = validateSearchQuery(c.req.query("q"));
  if (!queryResult.ok) {
    emitSearchLog({
      spotify_id: spotifyId,
      q_len: 0,
      result_count: null,
      tidal_status: null,
      duration_ms: Date.now() - startedAtMs,
    });
    return c.json({ error: queryResult.error, message: queryResult.message }, 400);
  }

  const limitResult = validateSearchLimit(c.req.query("limit"));
  if (!limitResult.ok) {
    emitSearchLog({
      spotify_id: spotifyId,
      q_len: queryResult.q.length,
      result_count: null,
      tidal_status: null,
      duration_ms: Date.now() - startedAtMs,
    });
    return c.json({ error: limitResult.error, message: limitResult.message }, 400);
  }

  let exists: boolean;
  try {
    exists = await trackExists(c.env, spotifyId);
  } catch {
    emitSearchLog({
      spotify_id: spotifyId,
      q_len: queryResult.q.length,
      result_count: null,
      tidal_status: null,
      duration_ms: Date.now() - startedAtMs,
    });
    return c.json({ error: "service_unavailable", message: "Database unavailable" }, 503);
  }
  if (!exists) {
    emitSearchLog({
      spotify_id: spotifyId,
      q_len: queryResult.q.length,
      result_count: null,
      tidal_status: null,
      duration_ms: Date.now() - startedAtMs,
    });
    return c.json({ error: "unknown_spotify_id", message: "spotify_id not found" }, 404);
  }

  const principal = c.get("principal");
  const principalKey =
    principal?.kind === "user" ? principal.email : (principal?.kind ?? "anonymous");
  const take = takeToken(principalKey);
  if (!take.allowed) {
    emitSearchLog({
      spotify_id: spotifyId,
      q_len: queryResult.q.length,
      result_count: null,
      tidal_status: null,
      duration_ms: Date.now() - startedAtMs,
    });
    c.header("Retry-After", String(take.retryAfterSec));
    return c.json({ error: "rate_limited", message: "Too many searches, please wait" }, 429);
  }

  let searchResult;
  try {
    searchResult = await raceWithTimeout(
      searchTidalCandidates(c.env, queryResult.q),
      SEARCH_TIMEOUT_MS,
    );
  } catch (err) {
    if (err instanceof TidalReauthRequired) {
      emitSearchLog({
        spotify_id: spotifyId,
        q_len: queryResult.q.length,
        result_count: null,
        tidal_status: null,
        duration_ms: Date.now() - startedAtMs,
      });
      return c.json(
        { error: "tidal_reauth_required", message: "Tidal session expired" },
        502,
      );
    }
    if (err instanceof SearchTimeout) {
      emitSearchLog({
        spotify_id: spotifyId,
        q_len: queryResult.q.length,
        result_count: null,
        tidal_status: null,
        duration_ms: Date.now() - startedAtMs,
      });
      return c.json({ error: "tidal_timeout", message: "Tidal upstream timed out" }, 504);
    }
    emitSearchLog({
      spotify_id: spotifyId,
      q_len: queryResult.q.length,
      result_count: null,
      tidal_status: null,
      duration_ms: Date.now() - startedAtMs,
    });
    return c.json(
      { error: "tidal_upstream_error", message: "Tidal upstream failed" },
      502,
    );
  }

  if (searchResult.status >= 400 || searchResult.bodyParseError) {
    emitSearchLog({
      spotify_id: spotifyId,
      q_len: queryResult.q.length,
      result_count: null,
      tidal_status: searchResult.status,
      duration_ms: Date.now() - startedAtMs,
    });
    return c.json(
      { error: "tidal_upstream_error", message: "Tidal upstream returned an error" },
      502,
    );
  }

  const flat = searchResult.candidates
    .slice(0, limitResult.limit)
    .map(mapCandidateToResponseShape);

  emitSearchLog({
    spotify_id: spotifyId,
    q_len: queryResult.q.length,
    result_count: flat.length,
    tidal_status: searchResult.status,
    duration_ms: Date.now() - startedAtMs,
  });

  return c.json(
    {
      query: queryResult.q,
      candidates: flat,
      fetched_at: new Date().toISOString(),
    },
    200,
  );
});

// F-025: single-row rematch variant. Shares the F-024 response shape so the
// UI can render the result with its existing candidate list. Read-only —
// selection still goes through POST /:spotify_id/match.
unmatchedRoute.get("/:spotify_id/rematch", async (c) => {
  const startedAtMs = Date.now();
  const spotifyId = c.req.param("spotify_id");

  const principal = c.get("principal");
  const principalKey =
    principal?.kind === "user" ? principal.email : (principal?.kind ?? "anonymous");
  const take = takeToken(principalKey);
  if (!take.allowed) {
    emitRowLog({
      spotify_id: spotifyId,
      q_len: 0,
      result_count: null,
      tidal_status: null,
      error: null,
      duration_ms: Date.now() - startedAtMs,
    });
    c.header("Retry-After", String(take.retryAfterSec));
    return c.json(
      { error: "rate_limited", message: "Too many rematches, please wait" },
      429,
    );
  }

  let row;
  try {
    row = await getPendingUnmatched(c.env, spotifyId);
  } catch {
    emitRowLog({
      spotify_id: spotifyId,
      q_len: 0,
      result_count: null,
      tidal_status: null,
      error: null,
      duration_ms: Date.now() - startedAtMs,
    });
    return c.json(
      { error: "service_unavailable", message: "Database unavailable" },
      503,
    );
  }
  if (row === null) {
    emitRowLog({
      spotify_id: spotifyId,
      q_len: 0,
      result_count: null,
      tidal_status: null,
      error: null,
      duration_ms: Date.now() - startedAtMs,
    });
    return c.json(
      { error: "unknown_spotify_id", message: "No pending unmatched row for spotify_id" },
      404,
    );
  }

  const query = buildRematchQuery(row.spotify_artist, row.spotify_title);
  if (query === null) {
    emitRowLog({
      spotify_id: spotifyId,
      q_len: 0,
      result_count: null,
      tidal_status: null,
      error: "invalid_input",
      duration_ms: Date.now() - startedAtMs,
    });
    return c.json(
      { error: "invalid_input", message: "Track metadata could not form a rematch query" },
      400,
    );
  }

  const tidal = await searchOneRematch(
    c.env,
    query,
    REMATCH_PER_ROW_TIMEOUT_MS,
    REMATCH_CANDIDATES_PER_ROW,
  );

  if (!tidal.ok) {
    emitRowLog({
      spotify_id: spotifyId,
      q_len: query.length,
      result_count: null,
      tidal_status: tidal.tidalStatus,
      error: tidal.error,
      duration_ms: Date.now() - startedAtMs,
    });
    if (tidal.error === "tidal_timeout") {
      return c.json(
        { error: "tidal_timeout", message: "Tidal upstream timed out" },
        504,
      );
    }
    if (tidal.error === "tidal_reauth_required") {
      return c.json(
        { error: "tidal_reauth_required", message: "Tidal session expired" },
        502,
      );
    }
    return c.json(
      { error: "tidal_upstream_error", message: "Tidal upstream failed" },
      502,
    );
  }

  emitRowLog({
    spotify_id: spotifyId,
    q_len: query.length,
    result_count: tidal.candidates.length,
    tidal_status: tidal.tidalStatus,
    error: null,
    duration_ms: Date.now() - startedAtMs,
  });

  return c.json(
    {
      query,
      candidates: tidal.candidates,
      fetched_at: new Date().toISOString(),
    },
    200,
  );
});

unmatchedRoute.post("/:spotify_id/skip", async (c) => {
  const contentType = c.req.header("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    return c.json({ error: "content_type_required" }, 415);
  }

  const spotifyId = c.req.param("spotify_id");

  try {
    const result = await markSkipped(c.env, spotifyId);
    return c.json(result, 200);
  } catch {
    return c.json({ error: "service_unavailable" }, 503);
  }
});

// --- F-024 helpers ------------------------------------------------------

/**
 * F-024 R6: structured log line emitted exactly once per request. Carries
 * only non-PII signals — never the raw query, the principal email, or any
 * token material. The presence of `tidal_status` differentiates "we got
 * to upstream" from "we short-circuited before upstream".
 */
function emitSearchLog(fields: {
  spotify_id: string;
  q_len: number;
  result_count: number | null;
  tidal_status: number | null;
  duration_ms: number;
}): void {
  console.log(
    JSON.stringify({
      event: "manual_search",
      spotify_id: fields.spotify_id,
      q_len: fields.q_len,
      result_count: fields.result_count,
      tidal_status: fields.tidal_status,
      duration_ms: fields.duration_ms,
    }),
  );
}

class SearchTimeout extends Error {
  constructor() {
    super("search_timeout");
    this.name = "SearchTimeout";
  }
}

async function raceWithTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new SearchTimeout()), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

export default unmatchedRoute;
