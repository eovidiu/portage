import type { MiddlewareHandler } from "hono";
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import type { Env } from "../env";

export type Principal = { kind: "user"; email: string } | { kind: "service" };

const ALLOWED_EMAIL = "eovidiu@gmail.com";
const JWKS_CACHE_MAX_AGE_MS = 600_000;

let cachedResolver: JWTVerifyGetKey | null = null;
let cachedTeam: string | null = null;

export function resetCfAccessCache(): void {
  cachedResolver = null;
  cachedTeam = null;
}

function getResolver(team: string): JWTVerifyGetKey {
  if (cachedResolver && cachedTeam === team) return cachedResolver;
  const url = new URL(`https://${team}.cloudflareaccess.com/cdn-cgi/access/certs`);
  cachedResolver = createRemoteJWKSet(url, { cacheMaxAge: JWKS_CACHE_MAX_AGE_MS });
  cachedTeam = team;
  return cachedResolver;
}

function reject(status: number, errorCode: string): Response {
  return new Response(JSON.stringify({ error: errorCode }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const JWKS_ERROR_PATTERN = /jwks|fetch|network|unreachable/i;

export function cfAccessMiddleware(
  skipPaths: string[]
): MiddlewareHandler<{ Bindings: Env; Variables: { principal: Principal; subject: string } }> {
  return async (c, next) => {
    if (skipPaths.includes(c.req.path)) return next();

    const cfHeader = c.req.header("Cf-Access-Jwt-Assertion");
    if (!cfHeader) return next();

    const team = c.env.CF_ACCESS_TEAM;
    const aud = c.env.CF_ACCESS_AUD;
    if (!team || !aud) {
      return reject(503, "cf_access_misconfigured");
    }

    try {
      const resolver = getResolver(team);
      const { payload } = await jwtVerify(cfHeader, resolver, {
        issuer: `https://${team}.cloudflareaccess.com`,
        audience: aud,
      });
      const email = typeof payload.email === "string" ? payload.email : "";
      if (email !== ALLOWED_EMAIL) {
        return reject(403, "forbidden");
      }
      c.set("principal", { kind: "user", email });
      c.set("subject", "owner");
      return next();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (JWKS_ERROR_PATTERN.test(message)) {
        console.error(JSON.stringify({ error_code: "jwks_fetch_failed", message }));
        return reject(503, "jwks_fetch_failed");
      }
      return reject(401, "invalid_cf_access_jwt");
    }
  };
}
