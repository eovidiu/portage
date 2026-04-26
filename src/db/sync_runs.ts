// F-009 / F-011 stub interface — full implementation by F-011 teammate.
// Kept here so F-009 can import the write-side signatures and develop in parallel.
// Once F-011 lands, the bodies are replaced with the real SQL queries
// (insert/update via @neondatabase/serverless; selects for status/runs/stats).

import type { Env } from "../env";

export type SyncRunStatus = "running" | "succeeded" | "partial" | "failed";

export interface SyncRunRow {
  run_id: string;
  started_at: string; // ISO 8601
  finished_at: string | null;
  status: SyncRunStatus;
  tracks_seen: number;
  matched_isrc: number;
  matched_fuzzy: number;
  unmatched: number;
  errors: number;
}

export type SyncRunUpdate = Partial<
  Pick<
    SyncRunRow,
    | "finished_at"
    | "status"
    | "tracks_seen"
    | "matched_isrc"
    | "matched_fuzzy"
    | "unmatched"
    | "errors"
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

// ----- Write helpers (used by F-009 orchestrator) ---------------------------

export async function insertRun(_env: Env): Promise<{ run_id: string }> {
  throw new Error("F-011 not implemented");
}

export async function updateRun(
  _env: Env,
  _runId: string,
  _patch: SyncRunUpdate,
): Promise<void> {
  throw new Error("F-011 not implemented");
}

export async function markAbandonedRuns(_env: Env): Promise<number> {
  // Sets status='failed', error_code='abandoned' on rows where status='running'
  // and started_at < now() - 600s. Returns count of rows updated.
  throw new Error("F-011 not implemented");
}

// ----- Read helpers (used by F-011 read endpoints) --------------------------

export async function getLatestRun(_env: Env): Promise<SyncRunRow | null> {
  throw new Error("F-011 not implemented");
}

export async function getLatestSucceededAt(_env: Env): Promise<string | null> {
  throw new Error("F-011 not implemented");
}

export async function getRecentRuns(
  _env: Env,
  _limit: number,
): Promise<SyncRunRow[]> {
  throw new Error("F-011 not implemented");
}

export async function aggregateStats(
  _env: Env,
  _period: "day" | "week" | "month",
): Promise<AggregateStats> {
  throw new Error("F-011 not implemented");
}
