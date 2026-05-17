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

// ----- F-027: per-run track manifest helpers --------------------------------

export interface RunTrackMatchedRow {
  spotify_id: string;
  title: string;
  artist: string;
  album: string | null;
  isrc: string | null;
  status: "matched";
  tidal_id: string;
  method: "isrc" | "fuzzy" | "manual";
  confidence: number | null;
}

export interface RunTrackUnmatchedRow {
  spotify_id: string;
  title: string;
  artist: string;
  album: string | null;
  isrc: string | null;
  status: "unmatched";
  reason: string;
}

export type RunTrackRow = RunTrackMatchedRow | RunTrackUnmatchedRow;

export interface RunTracksFilters {
  status?: "matched" | "unmatched" | "all";
  method?: "isrc" | "fuzzy" | "manual";
  limit: number;
  offset: number;
}

export interface RunTracksResult {
  total: number;
  items: RunTrackRow[];
}

// F-027: returns true if a sync_runs row exists for run_id. Used by the
// route handler to distinguish "run with zero tracks" (200 OK + empty items)
// from "unknown run" (404).
export async function runExists(env: Env, runId: string): Promise<boolean> {
  const sql = neon(env.DATABASE_URL);
  const rows = await sql(
    `SELECT 1 FROM sync_runs WHERE run_id = $1`,
    [runId],
  );
  return (rows as unknown[]).length > 0;
}

// F-027: returns the per-run track manifest. Matched rows come from
// tracks ⋈ matches; unmatched rows come from tracks ⋈ unmatched. Both
// halves are filtered by sync_run_id. `status` narrows which half(s) are
// included. `method` narrows the matched half only. Pagination at the
// UNION level so total reflects the filter-honored count, not the limit.
export async function listRunTracks(
  env: Env,
  runId: string,
  filters: RunTracksFilters,
): Promise<RunTracksResult> {
  const sql = neon(env.DATABASE_URL);
  const status = filters.status ?? "all";
  const includeMatched = status === "matched" || status === "all";
  const includeUnmatched = status === "unmatched" || status === "all";

  // The matched/unmatched halves are stitched with UNION ALL inside a CTE
  // so we can ORDER BY + paginate the combined result deterministically.
  // Method filter applies only to the matched half (ignored when status=
  // unmatched per the spec).
  const methodClause = filters.method
    ? `AND m.method = '${filters.method}'`
    : "";

  // F-027 hot-fix: cast NUMERIC -> float8 so the Neon driver emits a real
  // JavaScript number (not the string "1.00") on the wire. The SPA's
  // ConfidenceCell calls .toFixed() on this value; a string would crash
  // render with no error boundary in place.
  const matchedSelect = `
    SELECT
      t.spotify_id, t.title, t.artist, t.album, t.isrc,
      'matched'::text AS status,
      m.tidal_id, m.method, m.confidence::float8 AS confidence,
      NULL::text AS reason
    FROM matches m
    JOIN tracks t ON t.spotify_id = m.spotify_id
    WHERE m.sync_run_id = $1
    ${methodClause}
  `;

  const unmatchedSelect = `
    SELECT
      t.spotify_id, t.title, t.artist, t.album, t.isrc,
      'unmatched'::text AS status,
      NULL::text AS tidal_id,
      NULL::text AS method,
      NULL::float8 AS confidence,
      u.reason
    FROM unmatched u
    JOIN tracks t ON t.spotify_id = u.spotify_id
    WHERE u.sync_run_id = $1
  `;

  let union: string;
  if (includeMatched && includeUnmatched) {
    union = `(${matchedSelect}) UNION ALL (${unmatchedSelect})`;
  } else if (includeMatched) {
    union = matchedSelect;
  } else {
    // unmatched only — method filter ignored
    union = unmatchedSelect;
  }

  // Two queries: paginated rows + filter-honored total count.
  const itemsRows = await sql(
    `SELECT * FROM (${union}) sub
       ORDER BY spotify_id
       LIMIT $2 OFFSET $3`,
    [runId, filters.limit, filters.offset],
  );

  const countRows = await sql(
    `SELECT COUNT(*)::int AS total FROM (${union}) sub`,
    [runId],
  );

  const total = (countRows[0] as { total: number }).total;

  // The DB returns matched rows with reason=null and unmatched rows with
  // tidal_id/method/confidence=null. Project into the discriminated-union
  // shape so the API response carries only the relevant fields per row.
  const items: RunTrackRow[] = (itemsRows as Array<{
    spotify_id: string;
    title: string;
    artist: string;
    album: string | null;
    isrc: string | null;
    status: "matched" | "unmatched";
    tidal_id: string | null;
    method: "isrc" | "fuzzy" | "manual" | null;
    confidence: number | null;
    reason: string | null;
  }>).map((row) => {
    if (row.status === "matched") {
      return {
        spotify_id: row.spotify_id,
        title: row.title,
        artist: row.artist,
        album: row.album,
        isrc: row.isrc,
        status: "matched",
        tidal_id: row.tidal_id as string,
        method: row.method as "isrc" | "fuzzy" | "manual",
        confidence: row.confidence,
      };
    }
    return {
      spotify_id: row.spotify_id,
      title: row.title,
      artist: row.artist,
      album: row.album,
      isrc: row.isrc,
      status: "unmatched",
      reason: row.reason as string,
    };
  });

  return { total, items };
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
