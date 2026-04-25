import { neon } from "@neondatabase/serverless";
import { encryptToken, decryptToken } from "../crypto";
import type { Env } from "../env";

export type Provider = "spotify" | "tidal";

export interface PersistedTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
  status: "active" | "revoked";
}

export async function persistTokens(
  env: Env,
  provider: Provider,
  accessToken: string,
  refreshToken: string,
  expiresAt: Date,
): Promise<void> {
  const sql = neon(env.DATABASE_URL);

  const { ciphertext: atCt, iv: atIv } = await encryptToken(accessToken, env.TOKEN_ENCRYPTION_KEY);
  const { ciphertext: rtCt, iv: rtIv } = await encryptToken(refreshToken, env.TOKEN_ENCRYPTION_KEY);

  await sql(
    `INSERT INTO provider_tokens
       (access_token_ciphertext, access_token_iv,
        refresh_token_ciphertext, refresh_token_iv, expires_at, provider, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, now())
     ON CONFLICT (provider) DO UPDATE SET
       access_token_ciphertext  = EXCLUDED.access_token_ciphertext,
       access_token_iv          = EXCLUDED.access_token_iv,
       refresh_token_ciphertext = EXCLUDED.refresh_token_ciphertext,
       refresh_token_iv         = EXCLUDED.refresh_token_iv,
       expires_at               = EXCLUDED.expires_at,
       status                   = 'active',
       updated_at               = now()`,
    [Buffer.from(atCt), Buffer.from(atIv), Buffer.from(rtCt), Buffer.from(rtIv), expiresAt, provider],
  );
}

export async function loadTokens(
  env: Env,
  provider: Provider,
): Promise<PersistedTokens | null> {
  const sql = neon(env.DATABASE_URL);

  const rows = await sql(
    `SELECT access_token_ciphertext, access_token_iv,
            refresh_token_ciphertext, refresh_token_iv,
            expires_at, status
     FROM provider_tokens
     WHERE provider = $1`,
    [provider],
  );

  if (rows.length === 0) return null;

  const row = rows[0];
  const atCt = new Uint8Array(row.access_token_ciphertext as Buffer);
  const atIv = new Uint8Array(row.access_token_iv as Buffer);
  const rtCt = new Uint8Array(row.refresh_token_ciphertext as Buffer);
  const rtIv = new Uint8Array(row.refresh_token_iv as Buffer);

  const accessToken = await decryptToken(atCt, atIv, env.TOKEN_ENCRYPTION_KEY);
  const refreshToken = await decryptToken(rtCt, rtIv, env.TOKEN_ENCRYPTION_KEY);

  return {
    accessToken,
    refreshToken,
    expiresAt: new Date(row.expires_at as string),
    status: row.status as "active" | "revoked",
  };
}

export async function markRevoked(env: Env, provider: Provider): Promise<void> {
  const sql = neon(env.DATABASE_URL);

  await sql(
    `UPDATE provider_tokens SET status = 'revoked', updated_at = now() WHERE provider = $1`,
    [provider],
  );
}
