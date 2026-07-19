// F-030 task 2.1: copy_job_tracks DB module — per-track state, fetch-page
// persist (atomic with the job cursor, mirrors I-005), match-result updates,
// write-batch flips. See openspec/changes/playlist-copy/design.md D3/D6/D7.

import { neon } from "@neondatabase/serverless";
import type { Env } from "../env";
import { NON_TERMINAL_STATUSES } from "./copy_jobs";

export type CopyTrackState =
  | "pending"
  | "matched"
  | "unmatched"
  | "skipped"
  | "written"
  | "write_failed";

export type CopyMatchMethod = "isrc" | "fuzzy" | "manual" | "cached";

// Generic destination-candidate shape shared by copy_job_tracks.candidates
// and GET /api/copy/search — a provider-agnostic `id`, NOT the legacy
// `tidal_id` key used by the sync engine's `unmatched.candidates`.
export interface CopyCandidate {
  id: string;
  title: string;
  artist: string;
  album: string | null;
  duration_ms: number | null;
  score?: number;
}

export interface CopyJobTrackRow {
  job_id: string;
  position: number;
  source_track_id: string;
  isrc: string | null;
  title: string;
  artist: string | null;
  album: string | null;
  duration_ms: number | null;
  state: CopyTrackState;
  match_method: CopyMatchMethod | null;
  confidence: number | null;
  dest_track_id: string | null;
  candidates: CopyCandidate[] | null;
  reason: string | null;
  updated_at: string;
}

export interface CopyTrackInput {
  source_track_id: string;
  isrc: string | null;
  title: string;
  artist: string | null;
  album: string | null;
  duration_ms: number | null;
}

export interface InsertFetchedPageParams {
  tracks: CopyTrackInput[];
  positionStart: number;
  cursor: string | null;
  isLastPage: boolean;
  totalTracks?: number;
}

/**
 * Persists one fetched source page and advances the job's fetch_cursor in a
 * single transaction — the cursor MUST only advance atomically with the
 * page's rows (design D6, mirrors I-005). On the last page, flips the job to
 * `matching` and records `total_tracks`.
 */
export async function insertFetchedPage(
  env: Env,
  jobId: string,
  params: InsertFetchedPageParams,
): Promise<void> {
  const sql = neon(env.DATABASE_URL);
  const { tracks, positionStart, cursor, isLastPage, totalTracks } = params;
  const nextStatus = isLastPage ? "matching" : "fetching";

  await sql.transaction((txSql) => [
    ...tracks.map((t, i) =>
      txSql(
        `INSERT INTO copy_job_tracks
           (job_id, position, source_track_id, isrc, title, artist, album, duration_ms)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (job_id, position) DO NOTHING`,
        [
          jobId,
          positionStart + i,
          t.source_track_id,
          t.isrc,
          t.title,
          t.artist,
          t.album,
          t.duration_ms,
        ],
      ),
    ),
    // F-030 review S2: guarded by WHERE status = ANY(non-terminal) so a
    // concurrent cancel landing mid-fetch can never be overwritten back to
    // 'fetching'/'matching'. A 0-row result is silently accepted here — the
    // inserted track rows are harmless on an already-terminal (cancelled) job.
    txSql(
      `UPDATE copy_jobs
       SET fetch_cursor = $2,
           status = '${nextStatus}',
           fetched = fetched + $3,
           total_tracks = COALESCE($4, total_tracks),
           updated_at = now()
       WHERE job_id = $1 AND status = ANY($5)`,
      [jobId, cursor, tracks.length, totalTracks ?? null, NON_TERMINAL_STATUSES],
    ),
  ]);
}

export async function countPending(env: Env, jobId: string): Promise<number> {
  const sql = neon(env.DATABASE_URL);
  const rows = await sql(
    `SELECT COUNT(*)::integer AS n FROM copy_job_tracks WHERE job_id = $1 AND state = 'pending'`,
    [jobId],
  );
  return (rows as Array<{ n: number }>)[0]?.n ?? 0;
}

export async function listPendingForMatch(
  env: Env,
  jobId: string,
  limit: number,
): Promise<CopyJobTrackRow[]> {
  const sql = neon(env.DATABASE_URL);
  const rows = await sql(
    `SELECT * FROM copy_job_tracks
     WHERE job_id = $1 AND state = 'pending'
     ORDER BY position ASC
     LIMIT $2`,
    [jobId, limit],
  );
  return rows as CopyJobTrackRow[];
}

/** Loads the exact rows named by an in-flight write-batch marker (NEW-B1a). */
export async function listTracksByPositions(
  env: Env,
  jobId: string,
  positions: number[],
): Promise<CopyJobTrackRow[]> {
  const sql = neon(env.DATABASE_URL);
  const rows = await sql(
    `SELECT * FROM copy_job_tracks
     WHERE job_id = $1 AND position = ANY($2)
     ORDER BY position ASC`,
    [jobId, positions],
  );
  return rows as CopyJobTrackRow[];
}

export async function listMatchedForWrite(
  env: Env,
  jobId: string,
  limit: number,
): Promise<CopyJobTrackRow[]> {
  const sql = neon(env.DATABASE_URL);
  const rows = await sql(
    `SELECT * FROM copy_job_tracks
     WHERE job_id = $1 AND state = 'matched'
     ORDER BY position ASC
     LIMIT $2`,
    [jobId, limit],
  );
  return rows as CopyJobTrackRow[];
}

export async function getTrack(
  env: Env,
  jobId: string,
  position: number,
): Promise<CopyJobTrackRow | null> {
  const sql = neon(env.DATABASE_URL);
  const rows = await sql(
    `SELECT * FROM copy_job_tracks WHERE job_id = $1 AND position = $2`,
    [jobId, position],
  );
  const list = rows as CopyJobTrackRow[];
  return list[0] ?? null;
}

export interface ListTracksPageOptions {
  state?: CopyTrackState;
  afterPosition?: number;
  limit: number;
}

export interface TracksPageResult {
  tracks: CopyJobTrackRow[];
  next_cursor: string | null;
}

/** Paged track listing for GET /api/copy/jobs/:id/tracks. Cursor = position. */
export async function listTracksPage(
  env: Env,
  jobId: string,
  opts: ListTracksPageOptions,
): Promise<TracksPageResult> {
  const sql = neon(env.DATABASE_URL);
  const params: unknown[] = [jobId];
  const clauses = ["job_id = $1"];

  if (opts.state !== undefined) {
    params.push(opts.state);
    clauses.push(`state = $${params.length}`);
  }
  if (opts.afterPosition !== undefined) {
    params.push(opts.afterPosition);
    clauses.push(`position > $${params.length}`);
  }
  params.push(opts.limit);

  const rows = await sql(
    `SELECT * FROM copy_job_tracks
     WHERE ${clauses.join(" AND ")}
     ORDER BY position ASC
     LIMIT $${params.length}`,
    params,
  );
  const tracks = rows as CopyJobTrackRow[];
  const last = tracks[tracks.length - 1];
  const next_cursor = tracks.length === opts.limit && last ? String(last.position) : null;
  return { tracks, next_cursor };
}

export interface UpdateTrackMatchPatch {
  state: CopyTrackState;
  match_method?: CopyMatchMethod | null;
  confidence?: number | null;
  dest_track_id?: string | null;
  candidates?: CopyCandidate[] | null;
  reason?: string | null;
}

/** Single-row update used by the matching phase (per-track outcome). */
export async function updateTrackMatch(
  env: Env,
  jobId: string,
  position: number,
  patch: UpdateTrackMatchPatch,
): Promise<void> {
  const sql = neon(env.DATABASE_URL);
  await sql(
    `UPDATE copy_job_tracks
     SET state = $3, match_method = $4, confidence = $5, dest_track_id = $6,
         candidates = $7::jsonb, reason = $8, updated_at = now()
     WHERE job_id = $1 AND position = $2`,
    [
      jobId,
      position,
      patch.state,
      patch.match_method ?? null,
      patch.confidence ?? null,
      patch.dest_track_id ?? null,
      patch.candidates != null ? JSON.stringify(patch.candidates) : null,
      patch.reason ?? null,
    ],
  );
}

/** Batch flip used by the write phase (written / skipped-already-present). */
export async function updateTracksState(
  env: Env,
  jobId: string,
  positions: number[],
  state: CopyTrackState,
  reason: string | null = null,
): Promise<void> {
  const sql = neon(env.DATABASE_URL);
  await sql(
    `UPDATE copy_job_tracks
     SET state = $3, reason = COALESCE($4, reason), updated_at = now()
     WHERE job_id = $1 AND position = ANY($2)`,
    [jobId, positions, state, reason],
  );
}
