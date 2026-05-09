import { neon, type NeonQueryFunction, type NeonQueryFunctionInTransaction } from "@neondatabase/serverless";
import type { Env } from "../env";

const COLD_START_CURSOR = "1970-01-01T00:00:00Z";

export async function readCursor(env: Env, key: string): Promise<string> {
  const sql = neon(env.DATABASE_URL);
  const rows = await sql(
    `SELECT value FROM sync_state WHERE key = $1`,
    [key],
  );
  if ((rows as Record<string, unknown>[]).length === 0) return COLD_START_CURSOR;
  return (rows as Record<string, unknown>[])[0].value as string;
}

/** Read an arbitrary key from sync_state. Returns null if not found. */
export async function readState(
  sql: NeonQueryFunction<false, false>,
  key: string,
): Promise<string | null> {
  const rows = await sql(
    `SELECT value FROM sync_state WHERE key = $1`,
    [key],
  );
  if ((rows as Record<string, unknown>[]).length === 0) return null;
  return (rows as Record<string, unknown>[])[0].value as string;
}

/** Upsert an arbitrary key in sync_state. */
export async function writeState(
  sql: NeonQueryFunction<false, false>,
  key: string,
  value: string,
): Promise<void> {
  await sql(
    `INSERT INTO sync_state (key, value, updated_at)
     VALUES ($1, $2, now())
     ON CONFLICT (key) DO UPDATE SET
       value      = EXCLUDED.value,
       updated_at = now()`,
    [key, value],
  );
}

// Builds an un-awaited cursor upsert query for use inside a db.transaction() sync callback.
export function buildCursorQuery(
  txSql: NeonQueryFunctionInTransaction<false, false>,
  key: string,
  value: string,
) {
  return txSql(
    `INSERT INTO sync_state (key, value, updated_at)
     VALUES ($1, $2, now())
     ON CONFLICT (key) DO UPDATE SET
       value      = EXCLUDED.value,
       updated_at = now()`,
    [key, value],
  );
}

// F-017-R5: per-playlist cursor key derivation.
// __liked__ uses the legacy flat keys (spotify_cursor / spotify_resume_url /
// spotify_sweep_max) so F-005's tested code path stays untouched. Extras
// use the prefixed form playlist:{id}:{kind}.
export type PlaylistStateKind = "cursor" | "resume_url" | "sweep_max";
const LIKED_LEGACY_KEYS: Record<PlaylistStateKind, string> = {
  cursor: "spotify_cursor",
  resume_url: "spotify_resume_url",
  sweep_max: "spotify_sweep_max",
};

export function keyForPlaylist(
  kind: PlaylistStateKind,
  spotifyPlaylistId: string,
): string {
  if (spotifyPlaylistId === "__liked__") return LIKED_LEGACY_KEYS[kind];
  return `playlist:${spotifyPlaylistId}:${kind}`;
}
