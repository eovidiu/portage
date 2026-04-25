import { neon } from "@neondatabase/serverless";
import type { Env } from "../env";

export interface OAuthStateRecord {
  state: string;
  codeVerifier: string;
  expiresAt: Date;
}

export async function storeOAuthState(
  env: Env,
  record: OAuthStateRecord,
): Promise<void> {
  const sql = neon(env.DATABASE_URL);

  await sql(
    `INSERT INTO oauth_state (state, code_verifier, expires_at)
     VALUES ($1, $2, $3)`,
    [record.state, record.codeVerifier, record.expiresAt],
  );
}

export async function consumeOAuthState(
  env: Env,
  state: string,
): Promise<{ codeVerifier: string } | null> {
  const sql = neon(env.DATABASE_URL);

  // Single atomic statement: deletes the row only if not expired, returns code_verifier
  const rows = await sql(
    `DELETE FROM oauth_state
     WHERE state = $1 AND expires_at > now()
     RETURNING code_verifier`,
    [state],
  );

  if (rows.length === 0) return null;
  return { codeVerifier: rows[0].code_verifier as string };
}

export async function purgeExpiredOAuthState(env: Env): Promise<void> {
  const sql = neon(env.DATABASE_URL);

  await sql(`DELETE FROM oauth_state WHERE expires_at < now()`, []);
}
