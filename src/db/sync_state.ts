import { neon } from "@neondatabase/serverless";
import type { Env } from "../env";

const COLD_START_CURSOR = "1970-01-01T00:00:00Z";

export async function readCursor(env: Env, key: string): Promise<string> {
  const sql = neon(env.DATABASE_URL);
  const rows = await sql(
    `SELECT value FROM sync_state WHERE key = $1`,
    [key],
  );
  if (rows.length === 0) return COLD_START_CURSOR;
  return rows[0].value as string;
}

export async function writeCursor(
  sql: ReturnType<typeof neon>,
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
