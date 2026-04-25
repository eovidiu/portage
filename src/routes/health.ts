import { Hono } from "hono";
import { neon } from "@neondatabase/serverless";
import type { Env } from "../env";

const REQUIRED_SECRETS: (keyof Env)[] = [
  "JWT_SECRET",
  "TOKEN_ENCRYPTION_KEY",
  "SPOTIFY_CLIENT_ID",
  "SPOTIFY_CLIENT_SECRET",
  "TIDAL_CLIENT_ID",
  "TIDAL_CLIENT_SECRET",
  "DATABASE_URL",
];

const DB_TIMEOUT_MS = 2000;

type TokenRow = { provider: string; status: string };

const health = new Hono<{ Bindings: Env }>();

health.get("/healthz", (c) => c.json({ status: "ok" }, 200));

health.get("/readyz", async (c) => {
  const env = c.env;

  const secrets: Record<string, boolean> = {};
  let secretsOk = true;
  for (const key of REQUIRED_SECRETS) {
    const present = typeof env[key] === "string" && env[key].length > 0;
    secrets[key] = present;
    if (!present) secretsOk = false;
  }

  let dbOk = false;
  let tokens: Record<string, string> = { spotify: "missing", tidal: "missing" };

  try {
    const sql = neon(env.DATABASE_URL);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DB_TIMEOUT_MS);

    try {
      await Promise.race([
        sql`SELECT 1`,
        new Promise<never>((_, reject) =>
          controller.signal.addEventListener("abort", () =>
            reject(new Error("DB timeout"))
          )
        ),
      ]);
      dbOk = true;

      const rows = await Promise.race<TokenRow[]>([
        (sql`SELECT provider, status FROM provider_tokens WHERE provider IN ('spotify', 'tidal')` as unknown) as Promise<TokenRow[]>,
        new Promise<never>((_, reject) =>
          controller.signal.addEventListener("abort", () =>
            reject(new Error("DB timeout"))
          )
        ),
      ]);

      tokens = { spotify: "missing", tidal: "missing" };
      for (const row of rows) {
        if (row.provider === "spotify" || row.provider === "tidal") {
          tokens[row.provider] = row.status;
        }
      }
    } finally {
      clearTimeout(timer);
    }
  } catch {
    dbOk = false;
  }

  const tokensOk = tokens.spotify !== "revoked" && tokens.tidal !== "revoked";
  const ready = dbOk && secretsOk && tokensOk;

  const status = ready ? 200 : 503;
  return c.json(
    {
      status: ready ? "ready" : "unready",
      database: dbOk,
      secrets,
      tokens,
    },
    status
  );
});

export default health;
