## Context

`playlist_configs` is a Postgres table on Neon, seeded by F-016 with a single `__liked__` row at provisioning time. Additional rows arrive via `POST /api/playlists` (F-022). The orchestrator (twice daily via Workers Cron) iterates the table, fetches Spotify tracks for each row, matches them, and writes the result to the corresponding Tidal playlist.

Today there is no per-row "paused" state and no per-row sync history exposed via the API. The SPA's `/playlists` page (UI-PHASE-4) reads the existing fields and renders one card per row.

Constraints inherited from the existing system:
- Single-tenant Worker on Cloudflare Workers (50-subrequest free-tier cap per invocation).
- Authentication via CF Access JWT (browser) or Bearer JWT (cron + iOS). Same middleware for the new PATCH route.
- Neon free-tier compute occasionally cold-starts; migrations need to be tolerant of a brief connection delay (existing pattern).
- The orchestrator's `tests/orchestrator/` suite uses an in-memory mock of `playlist_configs` — the filter change has to be reflected there too.

## Goals / Non-Goals

**Goals:**

- Let the SPA pause sync for a specific playlist without removing the row.
- Surface `last_synced_at` so the SPA can show recency to the operator.
- Keep the API surface explicit — one PATCH endpoint, one body shape, one new field.
- Defense-in-depth on the `__liked__` row: refuse the disable both at the SPA and at the Worker so that the iOS or `curl` path can't bypass it.
- Preserve existing `playlist_membership` data when a row is disabled — re-enabling should resume without re-registration.

**Non-Goals:**

- Bulk operations (no `PATCH /api/playlists` array endpoint).
- Per-playlist cron customization (no `sync_interval` field).
- DELETE endpoint for rows (the toggle is the new pause primitive; DELETE may come later).
- Backfilling `last_synced_at` for historical sync runs — it starts NULL and populates only forward.
- Per-playlist error history endpoint — the existing run-level error history remains the source of truth.

## Decisions

### D1: Two columns, one migration

A single migration adds both columns. They co-evolve in the SPA — separating them costs an extra migration round-trip with no upside.

**Alternatives considered:**

- **Two migrations** (`enabled` first, `last_synced_at` later): no operational reason to split; both columns serve the same UX.

### D2: `enabled BOOLEAN NOT NULL DEFAULT TRUE`

`NOT NULL` with `DEFAULT TRUE` means existing rows automatically take `TRUE` without a separate backfill `UPDATE`. New rows from `POST /api/playlists` also get `TRUE` without changing the POST handler. Operator can later turn it off via PATCH.

**Alternatives considered:**

- **`disabled BOOLEAN DEFAULT FALSE`**: semantically inverted; `WHERE disabled = FALSE` is error-prone in the orchestrator query. `enabled` reads more naturally.
- **Nullable `enabled`**: requires `COALESCE(enabled, TRUE)` everywhere; adds complexity for no benefit.

### D3: `last_synced_at TIMESTAMPTZ NULL`

Nullable because (a) existing rows have no historical sync data we can backfill and (b) a newly-added playlist hasn't been synced yet. The SPA renders "—" for null and a relative time otherwise.

**Alternatives considered:**

- **`last_synced_at TIMESTAMPTZ NOT NULL DEFAULT '1970-01-01'`**: sentinel timestamp is confusing to read in the DB and forces every consumer to special-case the epoch.

### D4: PATCH endpoint, not PUT

PATCH semantics fit a partial update (`{ enabled }` only). PUT would imply the body replaces the entire row, which we explicitly don't want — the operator can't change `spotify_playlist_id`, `display_name`, or `tidal_playlist_id` via this endpoint.

**Alternatives considered:**

- **PUT with a full row body**: more REST-purist but invites future mistakes where an operator tries to rename `display_name` via the same path.
- **POST `/api/playlists/:id/disable` + `.../enable`**: two endpoints for one boolean is overkill.

### D5: `__liked__` refusal at the Worker, not just the SPA

The Worker is the source of truth. The SPA disables the toggle visually but a direct `curl` or the iOS shortcut path bypasses that. Defense-in-depth dictates the Worker refuses too.

Response shape on refusal: `409 Conflict` with body `{ "error": "liked_cannot_be_disabled" }`. We use 409 (not 400) because the request is well-formed — it's the resource state that prevents the change. Same pattern as `POST /sync/run` returning 409 when a run is already in flight.

**Alternatives considered:**

- **400 Bad Request**: misleading — there's nothing malformed about the body.
- **403 Forbidden**: implies a permission issue, not a domain rule.

### D6: Re-enabling `__liked__` is idempotent, not an error

`PATCH /api/playlists/__liked__` with `{ "enabled": true }` returns `200 OK` even though the row was already enabled. Same pattern as the duplicate `POST /api/playlists` returning 200 with the existing row. Simpler client logic.

### D7: Orchestrator filter is SQL-level, not application-level

The `WHERE enabled = TRUE` filter goes on the SQL query that loads the iteration set, not on a JS-side filter after the load. This means a disabled row never appears in the worker's working set, which (a) saves the per-row Spotify fetch and (b) makes the behavior observable in query logs.

**Alternatives considered:**

- **App-level filter** (`if (!row.enabled) continue;`): wasteful — still loads the row from DB.

### D8: `last_synced_at` write is per-row, not per-run

Each successful per-playlist sync updates that row's `last_synced_at`. A run-level error on one playlist doesn't taint the success of others — each `UPDATE` runs in its own statement after the per-row work completes successfully. Rolled-back rows preserve their prior timestamp.

**Alternatives considered:**

- **Single batch `UPDATE` at the end of the run**: simpler code but loses per-row error isolation.

## Risks / Trade-offs

- **Migration order matters** — if the GET handler ships the new projection before the migration runs, `GET /api/playlists` 500s with "column does not exist" → Mitigation: ship migration in its own PR first; GET projection update is a separate PR that depends on it.
- **Orchestrator skip means a disabled row's data goes stale** — Tidal playlist drifts from Spotify state → Acceptable. The whole point of disabling is to stop touching it. The operator sees the staleness via the absent `last_synced_at` update.
- **`__liked__` refusal is an extra round-trip** for an SPA bug that disables the toggle — but the SPA also disables the switch visually, so this is purely defense-in-depth, not a normal user path.
- **PATCH idempotency under concurrent writes** — two PATCH calls in quick succession with different values could race → Mitigation: each `UPDATE` is a single statement with `WHERE spotify_playlist_id = $1`; the last write wins; both responses return the post-write state of their own statement. No multi-row atomicity needed.
- **Orchestrator timing window** — operator toggles a playlist off while the orchestrator is mid-run on that row. The in-flight sync completes normally; the disable takes effect on the next run → Acceptable behavior; matches the implicit promise that "disable from the next run forward."

## Migration Plan

1. **F-026a** (columns + GET projection):
   1. Migration: `ALTER TABLE playlist_configs ADD COLUMN enabled BOOLEAN NOT NULL DEFAULT TRUE; ALTER TABLE playlist_configs ADD COLUMN last_synced_at TIMESTAMPTZ NULL;`. Apply on Neon main + dev branches.
   2. Update DB read helper to project the new columns.
   3. Update `GET /api/playlists` handler.
   4. Tests for the new fields appearing in the response.
   5. PR, merge, `wrangler deploy`. Production `GET` now returns the new fields — SPA ignores them harmlessly.
2. **F-026** (PATCH endpoint):
   1. New route handler with the `__liked__` refusal.
   2. New write helper.
   3. Tests for all PATCH scenarios (success, idempotent, unknown id 404, malformed body 400, Liked 409, unauthenticated 401).
   4. PR, merge, `wrangler deploy`.
3. **F-026b** (orchestrator filter + last_synced_at write):
   1. Add `WHERE enabled = TRUE` to the iteration query.
   2. Add per-row `UPDATE … SET last_synced_at = now()` after successful sync.
   3. Tests covering skip + write + per-row error isolation.
   4. PR, merge, `wrangler deploy`.

**Rollback**:

- F-026b only: revert the orchestrator change; `enabled` column stays (no harm).
- F-026 only: revert the PATCH route + handler; the column stays and no SPA breaks (SPA reads `enabled` but doesn't require PATCH).
- F-026a (and by extension all three): drop columns. SPA will still work — it tolerates the missing fields because of TanStack Query's structural typing and the optional chaining in the `Playlist` type. Worst case: SPA shows every row as "enabled" and "never synced" until redeployed.

## Open Questions

- Should the migration also add an **index on `enabled`**? The orchestrator query becomes `SELECT … FROM playlist_configs WHERE enabled = TRUE`. On a single-tenant table with at most a few dozen rows the index is moot; revisit if the registry grows.
- Do we want an **audit column** (`enabled_changed_at`) recording when the toggle last flipped? Not in v1 — adds another column and migration for a "nice to have." Operator can infer recency from the SPA's toast / their own memory.
- Should `last_synced_at` also include **per-playlist error count** so the SPA can show "failed 3 times since last success"? Out of scope; run-level errors remain the source of truth.
