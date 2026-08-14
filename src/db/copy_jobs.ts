// F-030 task 2.1: copy_jobs DB module — create, load-active, phase updates,
// counter recompute. See openspec/changes/playlist-copy/design.md D3.

import { neon } from "@neondatabase/serverless";
import type { Env } from "../env";
import { markCopyJobActive, clearCopyJobActive } from "../copy/active-flag";

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
  // F-030 review B1: positions of the write batch currently in flight (marker
  // persisted before the provider add() call, cleared atomically with the
  // written/write_failed flip). Non-null on job load means the previous tick
  // may have died mid-write; see src/copy/write.ts's crash reconcile.
  write_batch_positions: number[] | null;
  // F-030 review B3: consecutive non-fatal tick errors; reset on success,
  // fails the job at 5 (error_code 'tick_error_streak').
  consecutive_errors: number;
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
    // F-032: the only place a job becomes active. The 23505 path below creates
    // nothing, so it must not arm the flag.
    await markCopyJobActive(env);
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
  if ((updated as unknown[]).length > 0) {
    await clearCopyJobActive(env);
    return "cancelled";
  }

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

/**
 * Updates status/error_code/finished_at, guarded by `WHERE status = ANY(non-
 * terminal)` (F-030 review S2) so a concurrent cancel landing between the
 * engine's job load and this write can never be overwritten back to a
 * non-terminal status. Returns whether the row was actually updated —
 * `false` means the job was already terminal (e.g. cancelled mid-tick);
 * callers MUST treat that as "stop", not as an error.
 */
export async function setStatus(
  env: Env,
  jobId: string,
  status: CopyJobStatus,
  extra: SetStatusExtra = {},
): Promise<boolean> {
  const sql = neon(env.DATABASE_URL);
  const updated = await sql(
    `UPDATE copy_jobs
     SET status = $2, error_code = $3, finished_at = COALESCE($4, finished_at), updated_at = now()
     WHERE job_id = $1 AND status = ANY($5)
     RETURNING job_id`,
    [jobId, status, extra.error_code ?? null, extra.finished_at ?? null, NON_TERMINAL_STATUSES],
  );
  const applied = (updated as unknown[]).length > 0;
  // F-032: only terminal transitions release the flag. This function also drives
  // the non-terminal matching -> writing hop, where releasing would make the
  // next tick skip a live job. When `applied` is false a concurrent cancel
  // already went terminal and released it on that path.
  if (applied && !NON_TERMINAL_STATUSES.includes(status)) {
    await clearCopyJobActive(env);
  }
  return applied;
}

/**
 * F-032: how long a non-terminal job may show no change before it is treated as
 * wedged. Two orders of magnitude above the observed progress cadence of the
 * slowest real job (447 tracks over 51 h moved a counter roughly every 7 min),
 * so a merely slow job is never at risk — only one that has stopped entirely.
 */
const STALLED_JOB_INTERVAL = "6 hours";

/**
 * Fails non-terminal jobs that have not changed within STALLED_JOB_INTERVAL and
 * returns the rows it swept. `copy_jobs` otherwise has no analogue of
 * markAbandonedRuns, so a job wedged without erroring would hold the active-job
 * flag set forever and put the five-minute tick back on Neon around the clock.
 *
 * Correctness depends on `updated_at` meaning "last actual change", which is why
 * resetConsecutiveErrors and recomputeCounters are guarded against no-op writes.
 * A cap on `created_at` would not work: a real 447-track job legitimately ran for
 * 2 days 3 h.
 */
export async function markStalledJobs(env: Env): Promise<CopyJobRow[]> {
  const sql = neon(env.DATABASE_URL);
  const rows = await sql(
    `UPDATE copy_jobs
     SET status = 'failed', error_code = 'stalled', finished_at = now(), updated_at = now()
     WHERE status = ANY($1) AND updated_at < now() - $2::interval
     RETURNING *`,
    [NON_TERMINAL_STATUSES, STALLED_JOB_INTERVAL],
  );
  return rows as CopyJobRow[];
}

/** Persists (or clears, with `null`) the B1 batch-in-flight marker. */
export async function setWriteBatchPositions(
  env: Env,
  jobId: string,
  positions: number[] | null,
): Promise<void> {
  const sql = neon(env.DATABASE_URL);
  await sql(
    `UPDATE copy_jobs
     SET write_batch_positions = $2, updated_at = now()
     WHERE job_id = $1`,
    [jobId, positions != null ? JSON.stringify(positions) : null],
  );
}

/**
 * Resolves a write batch: flips `written`/`write_failed` positions on
 * copy_job_tracks and always clears the batch-in-flight marker (B1) — the
 * marker's only purpose is to survive an isolate crash between the provider
 * add() call and this resolution; once we're here with a definitive result,
 * it must be cleared regardless of outcome. Sequential statements, not a
 * transaction — mirrors insertMatch's (src/db/matches.ts) documented
 * precedent: atomicity is provided by the copy engine's advisory lock (D2),
 * which serializes all writes to a single in-flight tick.
 */
export async function resolveWriteBatch(
  env: Env,
  jobId: string,
  writtenPositions: number[],
  writeFailedPositions: number[],
): Promise<void> {
  const sql = neon(env.DATABASE_URL);
  if (writtenPositions.length > 0) {
    await sql(
      `UPDATE copy_job_tracks SET state = 'written', updated_at = now()
       WHERE job_id = $1 AND position = ANY($2)`,
      [jobId, writtenPositions],
    );
  }
  if (writeFailedPositions.length > 0) {
    await sql(
      `UPDATE copy_job_tracks SET state = 'write_failed', reason = 'invalid_track_id', updated_at = now()
       WHERE job_id = $1 AND position = ANY($2)`,
      [jobId, writeFailedPositions],
    );
  }
  await sql(
    `UPDATE copy_jobs SET write_batch_positions = NULL, updated_at = now() WHERE job_id = $1`,
    [jobId],
  );
}

/** Increments the B3 consecutive-error streak and returns the new count. */
export async function incrementConsecutiveErrors(env: Env, jobId: string): Promise<number> {
  const sql = neon(env.DATABASE_URL);
  const rows = await sql(
    `UPDATE copy_jobs
     SET consecutive_errors = consecutive_errors + 1, updated_at = now()
     WHERE job_id = $1
     RETURNING consecutive_errors`,
    [jobId],
  );
  return (rows as Array<{ consecutive_errors: number }>)[0]?.consecutive_errors ?? 0;
}

/**
 * Resets the B3 consecutive-error streak to 0 (called after any successful tick).
 * F-032: guarded on the streak being non-zero so a clean tick is a no-op. This
 * runs on every successful tick, and an unconditional write would refresh
 * `updated_at` forever, making a wedged job indistinguishable from a working one
 * and defeating the stalled-job sweep.
 */
export async function resetConsecutiveErrors(env: Env, jobId: string): Promise<void> {
  const sql = neon(env.DATABASE_URL);
  await sql(
    `UPDATE copy_jobs
     SET consecutive_errors = 0, updated_at = now()
     WHERE job_id = $1 AND consecutive_errors <> 0`,
    [jobId],
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

  // F-032: `IS DISTINCT FROM` makes this a no-op when nothing moved. Like
  // resetConsecutiveErrors this runs on every tick, so an unconditional write
  // would keep `updated_at` fresh on a job that is making no progress at all.
  await sql(
    `UPDATE copy_jobs
     SET matched = $2, written = $3, unmatched = $4, fetched = $5, updated_at = now()
     WHERE job_id = $1
       AND (matched, written, unmatched, fetched)
           IS DISTINCT FROM ($2::int, $3::int, $4::int, $5::int)`,
    [jobId, matched, written, unmatched, fetched],
  );

  return { fetched, matched, written, unmatched };
}

/**
 * Batch variant of recomputeCounters for GET /api/copy/jobs (F-030 review
 * S3): one GROUP BY query covering every requested job, read-only (does not
 * persist to copy_jobs) so the list endpoint stays at exactly 2 DB queries
 * total (listJobs + this). Jobs with no rows yet are simply absent from the
 * returned map; callers fall back to the job's own (zero) counters.
 */
export async function recomputeCountersForJobs(
  env: Env,
  jobIds: string[],
): Promise<Map<string, JobCounters>> {
  const result = new Map<string, JobCounters>();
  if (jobIds.length === 0) return result;

  const sql = neon(env.DATABASE_URL);
  const rows = await sql(
    `SELECT job_id, state, COUNT(*)::integer AS n
     FROM copy_job_tracks
     WHERE job_id = ANY($1)
     GROUP BY job_id, state`,
    [jobIds],
  );

  for (const row of rows as Array<{ job_id: string; state: string; n: number }>) {
    const counters = result.get(row.job_id) ?? { fetched: 0, matched: 0, written: 0, unmatched: 0 };
    counters.fetched += row.n;
    if (row.state === "matched") counters.matched += row.n;
    if (row.state === "written") counters.written += row.n;
    if (row.state === "unmatched") counters.unmatched += row.n;
    result.set(row.job_id, counters);
  }

  return result;
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
