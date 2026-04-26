import { neon } from "@neondatabase/serverless";
import type { Env } from "../env";

export interface CaptureRow {
  capture_id: string;
  spotify_id: string;
  captured_at: string;
  location_lat: number | null;
  location_lng: number | null;
  source: string;
  context_note: string | null;
}

export interface CaptureWithStatus extends CaptureRow {
  match_status: "matched" | "unmatched" | "pending";
  tidal_id: string | null;
}

export interface InsertCaptureParams {
  spotify_id: string;
  captured_at: string;
  location_lat: number | null;
  location_lng: number | null;
  source: string;
  context_note: string | null;
}

// Inserts a capture row and returns it. Does not check for duplicates — caller handles idempotency.
export async function insertCapture(
  env: Env,
  params: InsertCaptureParams,
): Promise<CaptureRow> {
  const sql = neon(env.DATABASE_URL);
  const rows = await sql(
    `INSERT INTO captures (spotify_id, captured_at, location_lat, location_lng, source, context_note)
     VALUES ($1, $2::timestamptz, $3, $4, $5, $6)
     RETURNING capture_id, spotify_id, captured_at::text AS captured_at,
               location_lat::float AS location_lat, location_lng::float AS location_lng,
               source, context_note`,
    [
      params.spotify_id,
      params.captured_at,
      params.location_lat,
      params.location_lng,
      params.source,
      params.context_note,
    ],
  );
  return rows[0] as CaptureRow;
}

// Finds a duplicate capture: same spotify_id inserted within the last 60 seconds.
export async function findRecentCapture(
  env: Env,
  spotifyId: string,
): Promise<CaptureRow | null> {
  const sql = neon(env.DATABASE_URL);
  const rows = await sql(
    `SELECT capture_id, spotify_id, captured_at::text AS captured_at,
            location_lat::float AS location_lat, location_lng::float AS location_lng,
            source, context_note
     FROM captures
     WHERE spotify_id = $1
       AND captured_at >= now() - interval '60 seconds'
     ORDER BY captured_at DESC
     LIMIT 1`,
    [spotifyId],
  );
  if ((rows as unknown[]).length === 0) return null;
  return rows[0] as CaptureRow;
}

// Lists captures with match_status derived from matches/unmatched tables, ordered by captured_at DESC.
export async function listCaptures(
  env: Env,
  limit: number,
  fromDate?: string,
  toDate?: string,
): Promise<CaptureWithStatus[]> {
  const sql = neon(env.DATABASE_URL);
  const conditions: string[] = [];
  const params: unknown[] = [limit];

  if (fromDate) {
    params.push(fromDate);
    conditions.push(`c.captured_at >= $${params.length}::timestamptz`);
  }
  if (toDate) {
    params.push(toDate);
    conditions.push(`c.captured_at <= $${params.length}::timestamptz`);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const rows = await sql(
    `SELECT
       c.capture_id,
       c.spotify_id,
       c.captured_at::text AS captured_at,
       c.location_lat::float AS location_lat,
       c.location_lng::float AS location_lng,
       c.source,
       c.context_note,
       CASE
         WHEN m.spotify_id IS NOT NULL THEN 'matched'
         WHEN u.spotify_id IS NOT NULL THEN 'unmatched'
         ELSE 'pending'
       END AS match_status,
       m.tidal_id
     FROM captures c
     LEFT JOIN matches m ON m.spotify_id = c.spotify_id
     LEFT JOIN unmatched u ON u.spotify_id = c.spotify_id
     ${whereClause}
     ORDER BY c.captured_at DESC
     LIMIT $1`,
    params,
  );
  return rows as CaptureWithStatus[];
}
