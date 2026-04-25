// F-004b stub interface — full implementation by the F-004b teammate.
// Kept here so F-002 and F-003 can import the signatures and develop in parallel.
// Once F-004b lands, the bodies are replaced with the real persist/load logic
// (encrypt via F-004 → INSERT, SELECT → decrypt, status transitions).

import type { Env } from "../env";

export type Provider = "spotify" | "tidal";

export interface PersistedTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
  status: "active" | "revoked";
}

export async function persistTokens(
  _env: Env,
  _provider: Provider,
  _accessToken: string,
  _refreshToken: string,
  _expiresAt: Date,
): Promise<void> {
  throw new Error("F-004b not implemented");
}

export async function loadTokens(
  _env: Env,
  _provider: Provider,
): Promise<PersistedTokens | null> {
  throw new Error("F-004b not implemented");
}

export async function markRevoked(_env: Env, _provider: Provider): Promise<void> {
  throw new Error("F-004b not implemented");
}
