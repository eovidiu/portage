// F-030 tasks 3.2-3.4: job create/list/detail/tracks/cancel.

import { Hono } from "hono";
import type { Env } from "../../env";
import { createJob, loadActiveJob, getJob, listJobs, cancelJob, recomputeCounters } from "../../db/copy_jobs";
import { listTracksPage, type CopyTrackState } from "../../db/copy_job_tracks";
import { hasSpotifyScopes } from "../../db/provider_tokens";
import { findOwnPlaylist, resolveSourceName, directionFor, destProviderFor, type CopyProvider } from "./shared";
import { snapshotDestTracks } from "../../copy/dest-reader";
import { notifyCopyJobTerminal } from "../../copy/notify";

// design.md D3: append-mode dedup snapshot size cap.
const APPEND_SNAPSHOT_CAP = 5000;
const DEFAULT_JOBS_LIMIT = 20;
const DEFAULT_TRACKS_LIMIT = 50;

const TRACK_STATES = new Set(["pending", "matched", "unmatched", "skipped", "written", "write_failed"]);

function isValidTrackState(value: string | undefined): value is CopyTrackState {
  return value !== undefined && TRACK_STATES.has(value);
}

interface ParsedCreateBody {
  source_provider: CopyProvider;
  source_playlist_id: string;
  dest_mode: "new" | "append";
  dest_playlist_id: string | null;
  dest_name: string | null;
}

// Provider playlist ids are ≤36 chars in practice (Spotify 22, Tidal UUID 36);
// 64 leaves headroom without letting arbitrary blobs into TEXT columns.
const MAX_PLAYLIST_ID_LENGTH = 64;
const MAX_DEST_NAME_LENGTH = 200;

function validateCreateBody(body: unknown): ParsedCreateBody | null {
  if (typeof body !== "object" || body === null) return null;
  const b = body as Record<string, unknown>;
  if (b.source_provider !== "spotify" && b.source_provider !== "tidal") return null;
  if (typeof b.source_playlist_id !== "string" || b.source_playlist_id.length === 0) return null;
  if (b.source_playlist_id.length > MAX_PLAYLIST_ID_LENGTH) return null;
  if (b.dest_mode !== "new" && b.dest_mode !== "append") return null;
  if (typeof b.dest_name === "string" && b.dest_name.length > MAX_DEST_NAME_LENGTH) return null;

  const dest_playlist_id = typeof b.dest_playlist_id === "string" ? b.dest_playlist_id : null;
  if (dest_playlist_id && dest_playlist_id.length > MAX_PLAYLIST_ID_LENGTH) return null;
  if (b.dest_mode === "append" && !dest_playlist_id) return null;

  return {
    source_provider: b.source_provider,
    source_playlist_id: b.source_playlist_id,
    dest_mode: b.dest_mode,
    dest_playlist_id,
    dest_name: typeof b.dest_name === "string" ? b.dest_name : null,
  };
}

async function hasRequiredSpotifyScopes(env: Env, parsed: ParsedCreateBody): Promise<boolean> {
  const scopes = new Set<string>();
  if (parsed.source_provider === "spotify") scopes.add("playlist-read-private");
  const destProvider = destProviderFor(parsed.source_provider);
  if (destProvider === "spotify") {
    scopes.add("playlist-modify-private");
    if (parsed.dest_mode === "append") scopes.add("playlist-read-private");
  }
  if (scopes.size === 0) return true;
  return hasSpotifyScopes(env, Array.from(scopes));
}

type AppendSnapshotResult = { ok: true; ids: string[] } | { ok: false; error: string };

async function resolveAppendSnapshot(
  env: Env,
  destProvider: CopyProvider,
  destPlaylistId: string,
): Promise<AppendSnapshotResult> {
  if (!(await findOwnPlaylist(env, destProvider, destPlaylistId))) {
    return { ok: false, error: "dest_not_owned" };
  }
  const snapshot = await snapshotDestTracks(env, destProvider, destPlaylistId, APPEND_SNAPSHOT_CAP);
  if (snapshot.oversized) return { ok: false, error: "dest_too_large" };
  return { ok: true, ids: snapshot.ids };
}

const app = new Hono<{ Bindings: Env }>();

app.post("/jobs", async (c) => {
  let rawBody: unknown;
  try {
    rawBody = await c.req.json();
  } catch {
    return c.json({ error: "invalid_body" }, 400);
  }

  const parsed = validateCreateBody(rawBody);
  if (!parsed) return c.json({ error: "invalid_request" }, 422);

  if (await loadActiveJob(c.env)) return c.json({ error: "job_already_active" }, 409);
  if (!(await hasRequiredSpotifyScopes(c.env, parsed))) {
    return c.json({ error: "spotify_reauth_required" }, 409);
  }

  const sourceName = await resolveSourceName(c.env, parsed.source_provider, parsed.source_playlist_id);
  if (sourceName === null) return c.json({ error: "unknown_playlist" }, 422);

  let destKnownIds: string[] | null = null;
  if (parsed.dest_mode === "append") {
    const destProvider = destProviderFor(parsed.source_provider);
    const result = await resolveAppendSnapshot(c.env, destProvider, parsed.dest_playlist_id as string);
    if (!result.ok) return c.json({ error: result.error }, 422);
    destKnownIds = result.ids;
  }

  const job = await createJob(c.env, {
    direction: directionFor(parsed.source_provider),
    source_playlist_id: parsed.source_playlist_id,
    source_name: sourceName,
    dest_mode: parsed.dest_mode,
    dest_playlist_id: parsed.dest_mode === "append" ? parsed.dest_playlist_id : null,
    dest_name: parsed.dest_mode === "new" ? (parsed.dest_name ?? sourceName) : parsed.dest_name,
    dest_known_ids: destKnownIds,
  });
  if (job === null) return c.json({ error: "job_already_active" }, 409);

  return c.json({ job_id: job.job_id }, 201);
});

app.get("/jobs", async (c) => {
  const rawLimit = parseInt(c.req.query("limit") ?? String(DEFAULT_JOBS_LIMIT), 10);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : DEFAULT_JOBS_LIMIT;
  const jobs = await listJobs(c.env, limit);
  return c.json({ jobs });
});

app.get("/jobs/:job_id", async (c) => {
  const jobId = c.req.param("job_id");
  const job = await getJob(c.env, jobId);
  if (!job) return c.json({ error: "job_not_found" }, 404);
  const counters = await recomputeCounters(c.env, jobId);
  return c.json({ ...job, ...counters });
});

app.get("/jobs/:job_id/tracks", async (c) => {
  const jobId = c.req.param("job_id");
  const job = await getJob(c.env, jobId);
  if (!job) return c.json({ error: "job_not_found" }, 404);

  const stateParam = c.req.query("state");
  const cursorParam = c.req.query("cursor");
  const rawLimit = parseInt(c.req.query("limit") ?? String(DEFAULT_TRACKS_LIMIT), 10);

  const page = await listTracksPage(c.env, jobId, {
    state: isValidTrackState(stateParam) ? stateParam : undefined,
    afterPosition: cursorParam !== undefined ? parseInt(cursorParam, 10) : undefined,
    limit: Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : DEFAULT_TRACKS_LIMIT,
  });
  return c.json({ tracks: page.tracks, next_cursor: page.next_cursor });
});

app.post("/jobs/:job_id/cancel", async (c) => {
  const jobId = c.req.param("job_id");
  const result = await cancelJob(c.env, jobId);
  if (result === "not_found") return c.json({ error: "job_not_found" }, 404);
  if (result === "already_terminal") return c.json({ error: "job_already_terminal" }, 409);

  const job = await getJob(c.env, jobId);
  if (job) await notifyCopyJobTerminal(c.env, job);
  return c.json({ status: "cancelled" }, 200);
});

export default app;
