import type { MiddlewareHandler } from "hono";
import type { Env } from "../env";
import { verifyJwt } from "../auth/verify";
import { AuthError } from "../auth/errors";

function authReject(code: string): Response {
  return new Response(JSON.stringify({ error: code }), {
    status: 401,
    headers: {
      "Content-Type": "application/json",
      "WWW-Authenticate": 'Bearer realm="spotify-roon-sync"',
    },
  });
}

export function jwtMiddleware(skipPaths: string[]): MiddlewareHandler<{ Bindings: Env }> {
  return async (c, next) => {
    if (skipPaths.includes(c.req.path)) {
      return next();
    }

    const authHeader = c.req.header("Authorization");
    if (!authHeader) {
      return authReject("missing_token");
    }

    if (!authHeader.startsWith("Bearer ")) {
      return authReject("malformed_token");
    }

    const token = authHeader.slice("Bearer ".length).trim();
    if (!token) {
      return authReject("missing_token");
    }

    try {
      const { subject } = await verifyJwt(token, c.env.JWT_SECRET);
      c.set("subject" as never, subject);
    } catch (err) {
      const code = err instanceof AuthError ? err.code : "malformed_token";
      return authReject(code);
    }

    return next();
  };
}
