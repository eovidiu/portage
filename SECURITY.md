# Security policy

## Reporting a vulnerability

If you find a security vulnerability in portage, email
**eovidiu@gmail.com** with the subject `SECURITY: <short description>`.
Please do not open a public GitHub issue.

There is no bug bounty program. Responses are best-effort — typically within a
week, but I can't guarantee a turnaround. Please give a reasonable disclosure
window before publishing details.

## Threat model

portage is a single-tenant, self-hosted Worker. The operator deploys their
own instance against their own Cloudflare account, their own Neon database,
and their own Spotify and Tidal developer apps. There is no shared
infrastructure between operators.

The most relevant attack surfaces are therefore the operator's own setup:

- The Worker's HTTP routes (`/sync/*`, `/unmatched/*`, `/api/*`,
  `/auth/spotify/authorize`, `/auth/tidal/authorize`). These are gated by
  either a Cloudflare Access JWT (for browser users) or a Bearer JWT signed
  by `JWT_SECRET` (for service callers and the cron). The public-skip list
  is limited to `/healthz`, `/readyz`, and the two OAuth callback paths.
- The OAuth callback handlers (`/auth/spotify/callback`,
  `/auth/tidal/callback`). State is validated against a short-lived PKCE
  store; codes are exchanged server-side and never logged.
- Token storage. Refresh and access tokens for both providers are encrypted
  at rest in Neon with AES-GCM, using a key supplied as the
  `TOKEN_ENCRYPTION_KEY` Worker secret. Plaintext tokens never persist
  outside volatile Worker memory.

The recommended hardening posture for any production deployment is to put
the Worker behind Cloudflare Access with Sign-in-with-Google, restricted to
your own email. The setup is documented under "Optional: Cloudflare Access"
in [`docs/operations/self-hosting.md`](docs/operations/self-hosting.md).

## Out of scope

- Vulnerabilities in upstream services (Cloudflare, Neon, Spotify, Tidal,
  Hono, `@neondatabase/serverless`). Report those to the upstream project.
- Issues that require physical access to the operator's machine, the
  operator's Cloudflare account credentials, or the operator's Neon
  credentials.
- Denial-of-service against a single operator's free-tier Worker (Cloudflare
  rate-limits handle that layer).
