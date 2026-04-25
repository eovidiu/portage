# Context Summary

Persistent record of architectural decisions, discovered patterns, gotchas, and active context.
This file is referenced in CLAUDE.md and loaded every session.

## Active Context
- Currently working on: Sprint 1 of Agent Teams plan — F014 (health) + F004 (encryption) in parallel, behind a one-shot project scaffold step
- Specs are complete and authoritative: `docs/architecture.md` + `docs/specs/F-001..F-014`
- Mode: Agent Teams, max-parallelization (per Ovidiu)
- Worker domain (production): `portage.eovidiu.co.uk` (architecture spec's `sync.example.com` was placeholder)
- Tidal playlist title (target): `Spotify Liked` (from `.env` `TIDAL_PLAYLIST_TITLE`)
- Tidal country code: `RO` (from `.env` `TIDAL_COUNTRY_CODE`)

## Available Credentials (names only — values in `.env`, never committed)
- **Spotify**: `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`
- **Tidal**: `TIDAL_CLIENT_ID`, `TIDAL_CLIENT_SECRET`, `TIDAL_COUNTRY_CODE`, `TIDAL_PLAYLIST_TITLE`
- **Cloudflare**: `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_ZONE_ID`, `CLOUDFLARE_API_TOKEN`, `WORKER_DOMAIN`
- **Neon**: `DATABASE_URL`, `NEON_API_KEY`
- **Worker runtime secrets** (to be minted, not in `.env`): `JWT_SECRET` (32+ bytes), `TOKEN_ENCRYPTION_KEY` (32 bytes base64), `SPOTIFY_REDIRECT_URI`, `TIDAL_REDIRECT_URI`

The Neon MCP server is available — `NEON_API_KEY` enables programmatic project/branch/schema management. Prefer Neon MCP over manual SQL for schema setup.

## Cross-Cutting Concerns
- **Stack**: TypeScript, Cloudflare Workers, Hono, @neondatabase/serverless, vitest, wrangler
- **Architecture**: stateless Worker; all state in Neon Postgres; `pg` driver does NOT work in Workers (per ADR-001) — must use `@neondatabase/serverless` for Postgres-over-HTTP/WebSocket
- **Single-tenant by design** (ADR-005): no tenant column, no RLS, any valid JWT has full access
- **No silent failures** (per spec conventions): every error path produces a structured log line with `run_id`, `feature`, `stage`, `error_code`, `message`
- **Spec-first**: deviations from `docs/` require updating the spec before code. Reference `F-NNN` in commits and PRs.
- **TDD with vitest**: every feature has a matching `T-NNN` test spec; coverage gate is 95% on touched code

## Domain: spotify-roon-sync

### Decisions
- TypeScript / Cloudflare Workers / Hono / Neon stack chosen per ADRs 001-003 (2026-04-25)
- ISRC-first matching with fuzzy fallback per ADR-004 (F-006 before F-007)
- Single named Tidal playlist as sync target per ADR-006 (not Tidal favourites)
- Bootstrap JWT pattern: 1-year HS256, single subject `owner` (F-001) — iOS Sign-in-with-Apple deferred

### Patterns
- All authenticated routes use a single `Hono.use()` middleware call (F-001-R6) — no per-route wrapping
- Tokens: encrypted with AES-256-GCM, 96-bit IV per encrypt, key from `TOKEN_ENCRYPTION_KEY` secret (F-004)
- DB invariants enforced at the application layer (no DB CHECKs in spec) — see I-001 to I-005 in `docs/architecture.md`
- Cursor advance for Spotify fetch MUST be atomic with page persist (I-005, F-005)

### Gotchas
- **Bootstrap cycle F-001 ↔ F-014**: F-001 spec lists F-014 as dep ("/healthz is the only unauthenticated GET"); F-014's `/readyz` lists F-002/F-003/F-004 as deps. Resolution: implement F-014 `/healthz` first (zero deps), then F-001 wires `/healthz` as the public exception. F-014 `/readyz` enhancements layer in after providers ship. `features.json` records F-001 → F-014 only; the F-014 → providers relationship is documented but NOT a hard dep.
- **Co-implementation F-009 ↔ F-011**: F-009 spec lists F-011 (logging consumes orchestrator output); F-011 lists F-009 (orchestrator owns sync_runs row writes). Resolution: ship F-011 read endpoints first against an empty `sync_runs` table, then F-009 starts writing rows. `features.json` records F-009 → F-011 (hard dep), F-011 → F-001 only.
- **`pg` driver DOES NOT work in Workers** (ADR-001 consequence): always import from `@neondatabase/serverless`
- **Plaintext tokens MUST NOT appear in any log line** (I-003, F-001-R5, 9.3) — log redaction is a code review checkpoint
- **README/SPEC_INDEX broken links**: both `docs/README.md` and `docs/specs/SPEC_INDEX.md` reference `docs/features/` and `docs/tests/`, but the actual layout is flat under `docs/specs/` (`F-NNN-*.md` and `T-NNN-*.md` side-by-side). Cosmetic; flagged for cleanup.
- **`.env` `DATABASE_URL` is commented out inside the quotes**: the value starts with `# postgresql://...` — that leading `#` is INSIDE the quoted string, so any code reading the env var will get a literal `#` prefix and the URL will not parse. Fix before F004/F005 ship: strip the `#` and the leading space. The Neon MCP server can fetch a fresh connection string via `get_connection_string` if needed.
- **Spec uses `sync.example.com` as Worker domain placeholder**; real domain from `.env` `WORKER_DOMAIN` is `portage.eovidiu.co.uk`. Use the real value in `wrangler.toml` and OAuth redirect URIs (`https://portage.eovidiu.co.uk/auth/spotify/callback`, `https://portage.eovidiu.co.uk/auth/tidal/callback`).

## Meta-Patterns
<!-- Coordination insights that apply across features — NOT domain-specific.
     Populated by the retrospective step at session end.
     These transfer to new projects: harness-init can import them as starting context. -->
- (none yet — first retrospective will populate this)
