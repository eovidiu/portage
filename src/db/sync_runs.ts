// F-009 / F-011 implementation — DB helpers for sync_runs table.
// Write helpers used by F-009 orchestrator; read helpers used by F-011 routes.

import { neon } from "@neondatabase/serverless";
import type { Env } from "../env";

export type SyncRunStatus = "running" | "succeeded" | "partial" | "failed";

// F-009-R12/R14: per-track failure record persisted to sync_runs.error_details.
// Shape produced verbatim by F-006 matchByIsrc and F-007 matchByFuzzy errors[].
export interface PerTrackError {
  spotify_id: string;
  error_code: string;
  message: string;
}

export interface SyncRunRow {
  run_id: string;
  started_at: string; // ISO 8601
  finished_at: string | null;
  status: SyncRunStatus;
  error_code: string | null;
  tracks_seen: number;
  matched_isrc: number;
  matched_fuzzy: number;
  unmatched: number;
  errors: number;
  error_details: PerTrackError[] | null;
}

export type SyncRunUpdate = Partial<
  Pick<
    SyncRunRow,
    | "finished_at"
    | "status"
    | "error_code"
    | "tracks_seen"
    | "matched_isrc"
    | "matched_fuzzy"
    | "unmatched"
    | "errors"
    | "error_details"
  >
>;

export interface AggregateStats {
  period: "day" | "week" | "month";
  from: string;
  to: string;
  runs_total: number;
  runs_succeeded: number;
  runs_partial: number;
  runs_failed: number;
  tracks_processed_total: number;
  match_rate: number;
  match_rate_isrc: number;
  match_rate_fuzzy: number;
  unmatched_pending: number;
}

function toSig4(n: number): number {
  if (n === 0) return 0;
  return parseFloat(n.toPrecision(4));
}

function periodInterval(period: "day" | "week" | "month"): string {
  if (period === "day") return "1 day";
  if (period === "week") return "7 days";
  return "1 month";
}

function periodBoundaries(period: "day" | "week" | "month"): { from: string; to: string } {
  const to = new Date();
  to.setMilliseconds(0);
  to.setSeconds(0);
  to.setMinutes(0);
  to.setHours(0);
  to.setTime(to.getTime()); // normalize

  const from = new Date(to);
  if (period === "day") {
    from.setDate(from.getDate() - 1);
  } else if (period === "week") {
    from.setDate(from.getDate() - 7);
  } else {
    from.setMonth(from.getMonth() - 1);
  }
  return {
    from: from.toISOString().replace(".000Z", "Z"),
    to: to.toISOString().replace(".000Z", "Z"),
  };
}

// ----- Write helpers (used by F-009 orchestrator) ---------------------------

export async function insertRun(env: Env): Promise<{ run_id: string }> {
  const sql = neon(env.DATABASE_URL);
  const rows = await sql(
    `INSERT INTO sync_runs (status) VALUES ($1) RETURNING run_id`,
    ["running"],
  );
  return { run_id: (rows[0] as { run_id: string }).run_id };
}

export async function updateRun(
  env: Env,
  runId: string,
  patch: SyncRunUpdate,
): Promise<void> {
  const sql = neon(env.DATABASE_URL);
  const keys = Object.keys(patch) as (keyof SyncRunUpdate)[];
  if (keys.length === 0) return;

  // F-009-R12: error_details is JSONB; serialize to JSON text and cast at the
  // SQL layer so Postgres stores it as a structured value, not a quoted string.
  const setClauses = keys
    .map((k, i) => (k === "error_details" ? `${k} = $${i + 1}::jsonb` : `${k} = $${i + 1}`))
    .join(", ");
  const values = keys.map((k) => {
    const v = patch[k];
    if (k === "error_details") {
      return v === null || v === undefined ? null : JSON.stringify(v);
    }
    return v;
  });
  values.push(runId);

  await sql(
    `UPDATE sync_runs SET ${setClauses} WHERE run_id = $${keys.length + 1}`,
    values as unknown[],
  );
}

export async function markAbandonedRuns(env: Env): Promise<number> {
  const sql = neon(env.DATABASE_URL);
  const rows = await sql(
    `UPDATE sync_runs
     SET status = 'failed', error_code = 'abandoned', finished_at = now()
     WHERE status = 'running'
       AND started_at < now() - interval '600 seconds'
     RETURNING run_id`,
    [],
  );
  return (rows as unknown[]).length;
}

// ----- Read helpers (used by F-011 read endpoints) --------------------------

export async function getLatestRun(env: Env): Promise<SyncRunRow | null> {
  const sql = neon(env.DATABASE_URL);
  const rows = await sql(
    `SELECT run_id, started_at, finished_at, status, error_code,
            tracks_seen, matched_isrc, matched_fuzzy, unmatched, errors, error_details
     FROM sync_runs
     ORDER BY started_at DESC
     LIMIT 1`,
    [],
  );
  if ((rows as unknown[]).length === 0) return null;
  return rows[0] as SyncRunRow;
}

export async function getLatestSucceededAt(env: Env): Promise<string | null> {
  const sql = neon(env.DATABASE_URL);
  const rows = await sql(
    `SELECT finished_at
     FROM sync_runs
     WHERE status = 'succeeded'
     ORDER BY started_at DESC
     LIMIT 1`,
    [],
  );
  if ((rows as unknown[]).length === 0) return null;
  const row = rows[0] as { finished_at: string | null };
  return row.finished_at;
}

export async function getRecentRuns(
  env: Env,
  limit: number,
): Promise<SyncRunRow[]> {
  const sql = neon(env.DATABASE_URL);
  const rows = await sql(
    `SELECT run_id, started_at, finished_at, status, error_code,
            tracks_seen, matched_isrc, matched_fuzzy, unmatched, errors, error_details
     FROM sync_runs
     ORDER BY started_at DESC
     LIMIT $1`,
    [limit],
  );
  return rows as SyncRunRow[];
}

export async function aggregateStats(
  env: Env,
  period: "day" | "week" | "month",
): Promise<AggregateStats> {
  const sql = neon(env.DATABASE_URL);
  const interval = periodInterval(period);
  const { from, to } = periodBoundaries(period);

  // Single query for all run aggregates (R-009)
  const runRows = await sql(
    `SELECT
       COUNT(*)                                           AS runs_total,
       COUNT(*) FILTER (WHERE status = 'succeeded')      AS runs_succeeded,
       COUNT(*) FILTER (WHERE status = 'partial')        AS runs_partial,
       COUNT(*) FILTER (WHERE status = 'failed')         AS runs_failed,
       COALESCE(SUM(tracks_seen), 0)                     AS tracks_processed_total,
       COALESCE(SUM(matched_isrc + matched_fuzzy), 0)    AS matched_total,
       COALESCE(SUM(matched_isrc), 0)                    AS matched_isrc_total,
       COALESCE(SUM(matched_fuzzy), 0)                   AS matched_fuzzy_total
     FROM sync_runs
     WHERE started_at >= now() - interval '${interval}'`,
    [],
  );

  // Single query for unmatched_pending (not period-bound per spec)
  const unmatchedRows = await sql(
    `SELECT COUNT(*) AS unmatched_pending FROM unmatched WHERE status = 'pending'`,
    [],
  );

  const r = runRows[0] as {
    runs_total: string;
    runs_succeeded: string;
    runs_partial: string;
    runs_failed: string;
    tracks_processed_total: string;
    matched_total: string;
    matched_isrc_total: string;
    matched_fuzzy_total: string;
  };

  const total = parseInt(r.tracks_processed_total, 10);
  const matched = parseInt(r.matched_total, 10);
  const matchedIsrc = parseInt(r.matched_isrc_total, 10);
  const matchedFuzzy = parseInt(r.matched_fuzzy_total, 10);

  const matchRate = total > 0 ? toSig4(matched / total) : 0;
  const matchRateIsrc = total > 0 ? toSig4(matchedIsrc / total) : 0;
  const matchRateFuzzy = total > 0 ? toSig4(matchedFuzzy / total) : 0;

  const ur = unmatchedRows[0] as { unmatched_pending: string };

  return {
    period,
    from,
    to,
    runs_total: parseInt(r.runs_total, 10),
    runs_succeeded: parseInt(r.runs_succeeded, 10),
    runs_partial: parseInt(r.runs_partial, 10),
    runs_failed: parseInt(r.runs_failed, 10),
    tracks_processed_total: total,
    match_rate: matchRate,
    match_rate_isrc: matchRateIsrc,
    match_rate_fuzzy: matchRateFuzzy,
    unmatched_pending: parseInt(ur.unmatched_pending, 10),
  };
}
