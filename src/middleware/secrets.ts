import type { MiddlewareHandler } from "hono";
import type { Env } from "../env";

// Cached per isolate lifetime — null means unchecked, true/false = result
let validated: boolean | null = null;

function checkSecrets(env: Env): { ok: boolean; reason: string } {
  const jwtBytes = new TextEncoder().encode(env.JWT_SECRET ?? "").length;
  if (jwtBytes < 32) {
    return { ok: false, reason: "JWT_SECRET too short (need >= 32 bytes)" };
  }

  let dekBytes: number;
  try {
    dekBytes = atob(env.TOKEN_ENCRYPTION_KEY ?? "").length;
  } catch {
    return { ok: false, reason: "TOKEN_ENCRYPTION_KEY is not valid base64" };
  }
  if (dekBytes !== 32) {
    return { ok: false, reason: `TOKEN_ENCRYPTION_KEY wrong length (got ${dekBytes}, need 32 bytes)` };
  }

  return { ok: true, reason: "" };
}

export function secretsGuard(skipPaths: string[] = ["/healthz", "/readyz"]): MiddlewareHandler<{ Bindings: Env }> {
  return async (c, next) => {
    if (skipPaths.includes(c.req.path)) {
      return next();
    }

    if (validated === null) {
      const { ok, reason } = checkSecrets(c.env);
      validated = ok;
      if (!ok) {
        console.error(`startup secrets validation failed: ${reason}`);
      }
    }

    if (!validated) {
      return new Response(JSON.stringify({ error: "misconfigured" }), {
        status: 503,
        headers: { "Content-Type": "application/json" },
      });
    }

    return next();
  };
}

export function resetSecretsCache(): void {
  validated = null;
}
