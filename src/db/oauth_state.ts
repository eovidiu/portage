// F-004b stub interface — full implementation by the F-004b teammate.
// The oauth_state table itself is added to db/schema.sql + Neon by F-004b.
// F-002 and F-003 import these signatures to develop in parallel.

import type { Env } from "../env";

export interface OAuthStateRecord {
  state: string;
  codeVerifier: string;
  expiresAt: Date;
}

export async function storeOAuthState(
  _env: Env,
  _record: OAuthStateRecord,
): Promise<void> {
  throw new Error("F-004b not implemented");
}

export async function consumeOAuthState(
  _env: Env,
  _state: string,
): Promise<{ codeVerifier: string } | null> {
  throw new Error("F-004b not implemented");
}

export async function purgeExpiredOAuthState(_env: Env): Promise<void> {
  throw new Error("F-004b not implemented");
}
