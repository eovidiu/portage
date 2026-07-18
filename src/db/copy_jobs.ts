// F-030 task 2.1: copy_jobs DB module — create, load-active, phase updates,
// counter recompute. See openspec/changes/playlist-copy/design.md D3.

import { neon } from "@neondatabase/serverless";
import type { Env } from "../env";

export type CopyDirection = "spotify_to_tidal" | "tidal_to_spotify";
export type CopyDestMode = "new" | "append";
export type CopyJobStatus =
  | "queued"
  | "fetching"
  | "matching"
  | "writing"
  | "completed"
  | "completed_with_unmatched"
  | "failed"
  | "cancelled";

// Mirrors the partial unique index idx_copy_jobs_single_active (db/schema.sql) — keep in sync.
export const NON_TERMINAL_STATUSES: CopyJobStatus[] = [
  "queued",
  "fetching",
  "matching",
  "writing",
];

export interface CopyJobRow {
  job_id: string;
  direction: CopyDirection;
  source_playlist_id: string;
  source_name: string;
  dest_mode: CopyDestMode;
  dest_playlist_id: string | null;
  dest_name: string | null;
  status: CopyJobStatus;
  error_code: string | null;
  fetch_cursor: string | null;
  dest_known_ids: string[] | null;
  total_tracks: number | null;
  fetched: number;
  matched: number;
  written: number;
  unmatched: number;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
}

export interface CreateJobInput {
  direction: CopyDirection;
  source_playlist_id: string;
  source_name: string;
  dest_mode: CopyDestMode;
  dest_playlist_id?: string | null;
  dest_name?: string | null;
  dest_known_ids?: string[] | null;
}

/**
 * Null means the idx_copy_jobs_single_active partial unique index rejected
 * the insert — another non-terminal job won a concurrent-create race.
 */
export async function createJob(env: Env, input: CreateJobInput): Promise<CopyJobRow | null> {
  const sql = neon(env.DATABASE_URL);
  try {
    const rows = await sql(
      `INSERT INTO copy_jobs
         (direction, source_playlist_id, source_name, dest_mode,
          dest_playlist_id, dest_name, dest_known_ids)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
       RETURNING *`,
      [
        input.direction,
        input.source_playlist_id,
        input.source_name,
        input.dest_mode,
        input.dest_playlist_id ?? null,
        input.dest_name ?? null,
        input.dest_known_ids != null ? JSON.stringify(input.dest_known_ids) : null,
      ],
    );
    return (rows as CopyJobRow[])[0];
  } catch (err) {
    if ((err as { code?: string }).code === "23505") return null;
    throw err;
  }
}

/** Idle fast-path: one query against the non-terminal predicate. Null when no active job. */
export async function loadActiveJob(env: Env): Promise<CopyJobRow | null> {
  const sql = neon(env.DATABASE_URL);
  const rows = await sql(
    `SELECT * FROM copy_jobs
     WHERE status = ANY($1)
     ORDER BY created_at DESC
     LIMIT 1`,
    [NON_TERMINAL_STATUSES],
  );
  const list = rows as CopyJobRow[];
  return list[0] ?? null;
}

export async function getJob(env: Env, jobId: string): Promise<CopyJobRow | null> {
  const sql = neon(env.DATABASE_URL);
  const rows = await sql(`SELECT * FROM copy_jobs WHERE job_id = $1`, [jobId]);
  const list = rows as CopyJobRow[];
  return list[0] ?? null;
}

export async function listJobs(env: Env, limit: number): Promise<CopyJobRow[]> {
  const sql = neon(env.DATABASE_URL);
  const rows = await sql(
    `SELECT * FROM copy_jobs ORDER BY created_at DESC LIMIT $1`,
    [limit],
  );
  return rows as CopyJobRow[];
}

export type CancelResult = "cancelled" | "already_terminal" | "not_found";

export async function cancelJob(env: Env, jobId: string): Promise<CancelResult> {
  const sql = neon(env.DATABASE_URL);
  const updated = await sql(
    `UPDATE copy_jobs
     SET status = 'cancelled', finished_at = now(), updated_at = now()
     WHERE job_id = $1 AND status = ANY($2)
     RETURNING job_id`,
    [jobId, NON_TERMINAL_STATUSES],
  );
  if ((updated as unknown[]).length > 0) return "cancelled";

  const existing = await sql(`SELECT job_id FROM copy_jobs WHERE job_id = $1`, [jobId]);
  return (existing as unknown[]).length > 0 ? "already_terminal" : "not_found";
}

export async function setDestPlaylist(
  env: Env,
  jobId: string,
  destPlaylistId: string,
  destName: string | null = null,
): Promise<void> {
  const sql = neon(env.DATABASE_URL);
  await sql(
    `UPDATE copy_jobs
     SET dest_playlist_id = $2,
         dest_name = COALESCE($3, dest_name),
         updated_at = now()
     WHERE job_id = $1`,
    [jobId, destPlaylistId, destName],
  );
}

export interface SetStatusExtra {
  error_code?: string | null;
  finished_at?: string | null;
}

export async function setStatus(
  env: Env,
  jobId: string,
  status: CopyJobStatus,
  extra: SetStatusExtra = {},
): Promise<void> {
  const sql = neon(env.DATABASE_URL);
  await sql(
    `UPDATE copy_jobs
     SET status = $2, error_code = $3, finished_at = COALESCE($4, finished_at), updated_at = now()
     WHERE job_id = $1`,
    [jobId, status, extra.error_code ?? null, extra.finished_at ?? null],
  );
}

export interface JobCounters {
  fetched: number;
  matched: number;
  written: number;
  unmatched: number;
}

/**
 * Recomputes fetched/matched/written/unmatched from copy_job_tracks (never
 * trusts the persisted counters blindly — design.md D3/Risks) and persists
 * the result. `fetched` = total rows for the job (every state counts,
 * mirroring `total_tracks` once fetch completes).
 */
export async function recomputeCounters(env: Env, jobId: string): Promise<JobCounters> {
  const sql = neon(env.DATABASE_URL);
  const grouped = await sql(
    `SELECT state, COUNT(*)::integer AS n FROM copy_job_tracks WHERE job_id = $1 GROUP BY state`,
    [jobId],
  );

  const byState = new Map<string, number>();
  for (const row of grouped as Array<{ state: string; n: number }>) {
    byState.set(row.state, row.n);
  }

  const matched = byState.get("matched") ?? 0;
  const written = byState.get("written") ?? 0;
  const unmatched = byState.get("unmatched") ?? 0;
  const fetched = Array.from(byState.values()).reduce((sum, n) => sum + n, 0);

  await sql(
    `UPDATE copy_jobs
     SET matched = $2, written = $3, unmatched = $4, fetched = $5, updated_at = now()
     WHERE job_id = $1`,
    [jobId, matched, written, unmatched, fetched],
  );

  return { fetched, matched, written, unmatched };
}

/**
 * Count of `skipped` rows (e.g. append-mode dedup) — not one of copy_jobs'
 * persisted counters, queried on demand for the D10 terminal notification.
 */
export async function countSkipped(env: Env, jobId: string): Promise<number> {
  const sql = neon(env.DATABASE_URL);
  const rows = await sql(
    `SELECT COUNT(*)::integer AS n FROM copy_job_tracks WHERE job_id = $1 AND state = 'skipped'`,
    [jobId],
  );
  return (rows as Array<{ n: number }>)[0]?.n ?? 0;
}
