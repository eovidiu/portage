## Why

The SPA's `/playlists` console shipped (UI-PHASE-4) as a card grid that scales poorly as the operator's registry grows and offers no way to pause sync for a specific playlist short of deleting the row. The companion UI change (`portage-ui#playlists-table-and-toggle`) reworks the console into a 4-column table with a per-row enable/disable toggle — that requires three Worker-side capabilities: a new `enabled` column with orchestrator support, a new PATCH endpoint to write it, and a new `last_synced_at` column so the operator can see when each playlist was last touched.

## What Changes

- Add `enabled BOOLEAN NOT NULL DEFAULT TRUE` and `last_synced_at TIMESTAMPTZ NULL` columns to `playlist_configs`. Backfill: existing rows take the default `enabled = TRUE`; `last_synced_at = NULL` for all rows until the orchestrator writes it. **BREAKING** for any external consumer of `GET /api/playlists` that does not tolerate additional fields (no known external consumers — only the SPA and the iOS shortcut).
- Project both new columns in `GET /api/playlists`.
- New endpoint **`PATCH /api/playlists/:spotify_playlist_id`** accepting `{ "enabled": boolean }`. Returns the updated row on success. Refuses `enabled = false` for the `__liked__` row with `409 Conflict { "error": "liked_cannot_be_disabled" }`.
- Orchestrator gains a `WHERE enabled = TRUE` filter on its `playlist_configs` iteration. Disabled rows are skipped without removing the row or its `playlist_membership` history — re-enabling resumes sync on the next scheduled run.
- Orchestrator writes `last_synced_at = now()` for each row whose per-playlist sync completes successfully within a run. Rows that error mid-run preserve their prior `last_synced_at` value.

## Capabilities

### New Capabilities

- `playlists-toggle`: `PATCH /api/playlists/:spotify_playlist_id` endpoint + orchestrator `enabled` filter + `last_synced_at` write semantics. Includes the explicit Liked Songs refusal.

### Modified Capabilities

- `playlists-list`: response rows gain `enabled: boolean` and `last_synced_at: string | null`.

## Impact

- DB migration on the Neon main + dev branches.
- `src/routes/playlists.ts` — new PATCH handler, updated GET projection.
- `src/db/playlist_configs.ts` (or equivalent) — read path projects the new columns; new write helper for the PATCH.
- `src/index.ts` — mount the PATCH route.
- Orchestrator path (`src/orchestrator/` or wherever `playlist_configs` is iterated) — `WHERE enabled = TRUE` filter + `last_synced_at` write.
- Tests under `tests/routes/playlists.test.ts` and `tests/orchestrator/`.
- New Worker harness features: `F-026a` (columns + GET projection), `F-026` (PATCH endpoint), `F-026b` (orchestrator filter + last_synced_at). Each tracked separately so they ship in order.
- No change to authentication, CF Access topology, or `/api/me`.
- SPA companion change at `portage-ui/openspec/changes/playlists-table-and-toggle/` consumes the new fields and endpoint; it ships **after** all three Worker features are live on `main`.
