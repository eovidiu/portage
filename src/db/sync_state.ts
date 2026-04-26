import { neon, type NeonQueryFunctionInTransaction } from "@neondatabase/serverless";
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
