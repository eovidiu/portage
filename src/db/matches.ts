import { type NeonQueryFunction } from "@neondatabase/serverless";

export interface MatchRow {
  spotify_id: string;
  tidal_id: string;
  method: "isrc" | "fuzzy" | "manual";
  confidence: number;
  sync_run_id: string | null;
}

/** Insert a match row. ON CONFLICT DO NOTHING (idempotent re-runs). */
export async function insertMatch(
  sql: NeonQueryFunction<false, false>,
  row: MatchRow,
): Promise<void> {
  await sql(
    `INSERT INTO matches (spotify_id, tidal_id, method, confidence, sync_run_id)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (spotify_id) DO NOTHING`,
    [row.spotify_id, row.tidal_id, row.method, row.confidence, row.sync_run_id],
  );
}

/** Returns the set of spotify_ids already present in matches for the given ids. */
export async function findMatchedIds(
  sql: NeonQueryFunction<false, false>,
  spotifyIds: string[],
): Promise<Set<string>> {
  if (spotifyIds.length === 0) return new Set();
  const rows = await sql(
    `SELECT spotify_id FROM matches WHERE spotify_id = ANY($1)`,
    [spotifyIds],
  );
  return new Set((rows as { spotify_id: string }[]).map((r) => r.spotify_id));
}

