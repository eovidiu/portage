// F-030 task 3.5: manual resolution of unmatched copy tracks — rate-limited
// search, immediate single-track match, skip.

import { Hono } from "hono";
import type { Env } from "../../env";
import { getJob, type CopyJobStatus } from "../../db/copy_jobs";
import { getTrack, updateTrackMatch, type CopyCandidate } from "../../db/copy_job_tracks";
import { searchTidalCandidates } from "../../match/tidal-search";
import { searchByText } from "../../providers/spotify/search";
import { tidalFetch } from "../../providers/tidal/client";
import { spotifyFetch } from "../../providers/spotify/oauth";
import { addTracksToPlaylist } from "../../providers/tidal/playlist";
import { addItems } from "../../providers/spotify/playlist-write";
import { takeToken } from "../../middleware/rate-limit";
import type { ResolvedTidalCandidate } from "../../match/score";

// Mirrors src/routes/unmatched.ts's manual-search existence-check pattern.
const TIDAL_TRACKS_BASE = "https://openapi.tidal.com/v2/tracks";
const SPOTIFY_TRACKS_BASE = "https://api.spotify.com/v1/tracks";

const TERMINAL_STATUSES = new Set<CopyJobStatus>([
  "completed",
  "completed_with_unmatched",
  "failed",
  "cancelled",
]);

type RoutePrincipal = { kind: "user"; email: string } | { kind: "service" };

function toCandidateShape(c: ResolvedTidalCandidate): CopyCandidate {
  return { id: c.id, title: c.title, artist: c.primaryArtist, album: c.albumTitle || null, duration_ms: c.durationMs };
}

const app = new Hono<{ Bindings: Env; Variables: { principal?: RoutePrincipal } }>();

app.get("/search", async (c) => {
  const provider = c.req.query("provider");
  if (provider !== "spotify" && provider !== "tidal") {
    return c.json({ error: "invalid_provider" }, 422);
  }
  const q = c.req.query("q");
  if (!q || q.trim().length === 0) {
    return c.json({ error: "invalid_query" }, 422);
  }

  const principal = c.get("principal");
  const principalKey = principal?.kind === "user" ? principal.email : (principal?.kind ?? "anonymous");
  const take = takeToken(principalKey);
  if (!take.allowed) {
    c.header("Retry-After", String(take.retryAfterSec));
    return c.json({ error: "rate_limited" }, 429);
  }

  const candidates =
    provider === "tidal"
      ? (await searchTidalCandidates(c.env, q)).candidates
      : (await searchByText(c.env, q, "")).candidates;

  return c.json({ candidates: candidates.map(toCandidateShape) });
});

interface MatchValidation {
  job: NonNullable<Awaited<ReturnType<typeof getJob>>>;
  status: number;
  error?: string;
}

async function loadJobForManualAction(env: Env, jobId: string): Promise<MatchValidation | { status: number; error: string }> {
  const job = await getJob(env, jobId);
  if (!job) return { status: 404, error: "job_not_found" };
  if (!TERMINAL_STATUSES.has(job.status)) return { status: 409, error: "job_not_terminal" };
  return { job, status: 200 };
}

async function destinationExists(env: Env, direction: string, destTrackId: string): Promise<boolean> {
  if (direction === "spotify_to_tidal") {
    const res = await tidalFetch(env, `${TIDAL_TRACKS_BASE}/${encodeURIComponent(destTrackId)}`);
    return res.ok;
  }
  const res = await spotifyFetch(env, `${SPOTIFY_TRACKS_BASE}/${encodeURIComponent(destTrackId)}`);
  return res.ok;
}

// F-030 review N1: manual match is only meaningful for a track that hasn't
// already been resolved one way or another — re-matching a 'written' or
// 'matched' row would double-add it to the destination playlist.
const REMATCHABLE_STATES = new Set(["unmatched", "skipped"]);

/**
 * Appends the single track to the destination and reports whether it
 * actually landed (F-030 review N1). Both providers can return a
 * result that isn't a thrown error yet isn't a success either — Tidal
 * reports per-id `invalidIds`/`errors`, Spotify reports `rateLimited` — so
 * the route must inspect the result rather than assume success from a
 * non-throwing call.
 */
async function addSingleTrack(
  env: Env,
  direction: string,
  destPlaylistId: string,
  destTrackId: string,
): Promise<boolean> {
  if (direction === "spotify_to_tidal") {
    const result = await addTracksToPlaylist(env, destPlaylistId, [destTrackId]);
    return result.added === 1;
  }
  const result = await addItems(env, destPlaylistId, [destTrackId]);
  return result.added === 1 && !result.rateLimited;
}

app.post("/jobs/:job_id/tracks/:position/match", async (c) => {
  const jobId = c.req.param("job_id");
  const position = parseInt(c.req.param("position"), 10);

  const validation = await loadJobForManualAction(c.env, jobId);
  if (!("job" in validation)) return c.json({ error: validation.error }, validation.status as 404 | 409);
  const { job } = validation;

  const track = await getTrack(c.env, jobId, position);
  if (!track) return c.json({ error: "track_not_found" }, 404);
  if (!REMATCHABLE_STATES.has(track.state)) {
    return c.json({ error: "track_not_eligible" }, 409);
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_body" }, 400);
  }
  const destTrackId = (body as { dest_track_id?: unknown })?.dest_track_id;
  if (typeof destTrackId !== "string" || destTrackId.length === 0) {
    return c.json({ error: "missing_dest_track_id" }, 400);
  }

  if (!(await destinationExists(c.env, job.direction, destTrackId))) {
    return c.json({ error: "dest_track_not_found" }, 422);
  }
  if (!job.dest_playlist_id) {
    return c.json({ error: "no_destination_playlist" }, 422);
  }

  if (!(await addSingleTrack(c.env, job.direction, job.dest_playlist_id, destTrackId))) {
    return c.json({ error: "dest_add_failed" }, 502);
  }

  await updateTrackMatch(c.env, jobId, position, {
    state: "written",
    match_method: "manual",
    confidence: 1.0,
    dest_track_id: destTrackId,
  });

  return c.json({ position, state: "written", dest_track_id: destTrackId }, 200);
});

app.post("/jobs/:job_id/tracks/:position/skip", async (c) => {
  const jobId = c.req.param("job_id");
  const position = parseInt(c.req.param("position"), 10);

  const validation = await loadJobForManualAction(c.env, jobId);
  if (!("job" in validation)) return c.json({ error: validation.error }, validation.status as 404 | 409);

  const track = await getTrack(c.env, jobId, position);
  if (!track) return c.json({ error: "track_not_found" }, 404);

  await updateTrackMatch(c.env, jobId, position, { state: "skipped" });
  return c.json({ position, state: "skipped" }, 200);
});

export default app;
