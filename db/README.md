# Database Schema

`schema.sql` is the source of truth for the portage Neon database (project `square-wave-04443485`, region `eu-central-1`, Postgres 17).

## Apply via Neon MCP (Claude Code)

Open a Claude Code session with the Neon MCP server configured, then run:

```
mcp__Neon__run_sql_transaction({
  projectId: "square-wave-04443485",
  databaseName: "neondb",
  sqlStatements: [ /* paste each statement from schema.sql as an array element */ ]
})
```

All statements are `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS`, so applying against an already-provisioned database is safe.

## Apply via psql

```bash
psql "$DATABASE_URL" -f db/schema.sql
```

`DATABASE_URL` must be set to a valid Neon connection string (see `.dev.vars` locally or Cloudflare secrets in production). The value format is:

```
postgresql://<role>:<password>@<host>/neondb?sslmode=require&channel_binding=require
```

## Tables

| Table | Purpose |
|---|---|
| `provider_tokens` | Encrypted Spotify and Tidal OAuth tokens (AES-256-GCM) |
| `tracks` | Spotify track catalogue cache |
| `sync_runs` | Audit log of every sync engine execution |
| `matches` | Confirmed Spotify→Tidal track pairings |
| `unmatched` | Tracks pending manual review or retry |
| `sync_state` | Key/value runtime state (sync cursor, etc.) |

## Invariants

See `docs/architecture.md` §3.2 for the full list (I-001 through I-005). These are enforced at the application layer; comments in `schema.sql` document which tables each invariant governs.
