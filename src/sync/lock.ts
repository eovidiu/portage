import { Pool, type PoolClient } from "@neondatabase/serverless";
import type { Env } from "../env";

// Deterministic 64-bit-safe integer key from 'sync_run_lock' via djb2 hash.
// djb2 stays within JS safe integer range (31-bit result).
function lockKey(): number {
  const s = "sync_run_lock";
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) & 0x7fffffff;
  }
  return h;
}

// F-030 D2: the copy engine shares this SAME key so a copy tick and a sync
// run can never hold the lock concurrently — total serialization, no new
// lock-ordering rules, no token-refresh races on the shared provider_tokens
// rows.
export const LOCK_KEY = lockKey();

// Postgres advisory locks are session-scoped. The Neon HTTP driver opens a
// fresh session per query, so a lock acquired via `neon()` would auto-release
// the moment the query returns — providing zero protection. The acquire and
// release queries must share a single session, so we use Pool/WebSocket for
// the lock pair only. Everything else (insertRun, updateRun, markAbandonedRuns,
// fetchNewTracks, and the copy engine's own queries) stays on plain `neon()`
// since those queries don't need session affinity.
export interface LockSession {
  pool: Pool;
  client: PoolClient;
}

export async function acquireLock(env: Env): Promise<LockSession | null> {
  const pool = new Pool({ connectionString: env.DATABASE_URL });
  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      `SELECT pg_try_advisory_lock($1) AS acquired`,
      [LOCK_KEY],
    );
    const acquired = (rows[0] as { acquired: boolean }).acquired;
    if (!acquired) {
      client.release();
      await pool.end();
      return null;
    }
    return { pool, client };
  } catch (err) {
    client.release();
    await pool.end();
    throw err;
  }
}

export async function releaseLock(session: LockSession): Promise<void> {
  try {
    await session.client.query(`SELECT pg_advisory_unlock($1)`, [LOCK_KEY]);
  } finally {
    session.client.release();
    await session.pool.end();
  }
}
