## 1. F-026a — `playlist_configs` columns + GET projection

- [x] 1.1 Add `F-026a playlist-configs-columns` entry to `.harness/features.json` with `scope: ["db/schema.sql", "src/db/playlist_configs.ts", "src/routes/playlists.ts", "tests/routes/playlists.test.ts", "docs/specs/F-026a-playlist-configs-columns.md", "docs/specs/T-026a-playlist-configs-columns.md"]`, `depends_on: []`, `priority: 14`. **Adapted**: project uses single `db/schema.sql` + live DDL via Neon MCP, not `db/migrations/`.
- [x] 1.2 Author `docs/specs/F-026a-playlist-configs-columns.md` and `docs/specs/T-026a-playlist-configs-columns.md` mirroring the relevant scenarios from `openspec/changes/playlists-table-and-toggle/specs/playlists-list/spec.md`. (Spec text was corrected on 2026-05-17 to match existing API contract: no `display_name` rename, no `is_liked` field — `enabled` only is net-new.)
- [x] 1.3 **Adapted**: edited `db/schema.sql` (project pattern, no `db/migrations/` dir exists) to declare `enabled BOOLEAN NOT NULL DEFAULT TRUE`. `last_synced_at` was already present (shipped by F-016/F-018). **Live DDL staged for operator** (CHECKPOINT 1): `ALTER TABLE playlist_configs ADD COLUMN IF NOT EXISTS enabled BOOLEAN NOT NULL DEFAULT TRUE;` to be applied via Neon MCP on prod branch `br-sparkling-star-al5g4fzf` AND on the dev branch.
- [x] 1.4 Updated `src/db/playlist_configs.ts`: added `enabled: boolean` to `PlaylistConfigRow` and to the SELECT lists of `listPlaylistConfigs` + `getPlaylistConfig`. (`last_synced_at` was already projected.) Also extended POST synthetic-row construction in `src/routes/playlists.ts` to include `enabled: true`.
- [x] 1.5 Extended `tests/routes/playlists.test.ts`: added `enabled: true` to LIKED_ROW + EXTRA_ROW fixtures (compile-time gate satisfies T-026a-03/04/05); added T-026a-06 (enabled projection on GET), T-026a-07 (disabled rows still appear in GET — GET does NOT filter on enabled), T-026a-09 (POST synthetic row reflects enabled: true). The pre-existing T-021/T-022 fixtures already covered last_synced_at: null.
- [x] 1.6 No code change required — `GET /api/playlists` already returns the full `PlaylistConfigRow` via `c.json(sortLikedFirst(rows))`. With `PlaylistConfigRow.enabled` added and the SELECT projecting `enabled`, both new fields flow through to the response automatically. The `tests/sync/orchestrator.test.ts` + `tests/db/playlist_configs.test.ts` fixtures were updated to include `enabled: true` to keep tsc green.
- [x] 1.7 Stage 1 (smoke) + Stage 2 (full test 751/751) green. Stages 3/4/5 are no-ops for this scope (no coverage-claim diff, schema-drift hook covered by single-column ADD with matching SELECT projection, no new external API URLs introduced).
- [ ] 1.8 Open and merge PR `feat(F-026a): playlist_configs.enabled + last_synced_at + GET projection`. Confirm `wrangler deploy` succeeds; production `GET /api/playlists` now returns the new fields.

## 2. F-026 — PATCH `/api/playlists/:id`

- [ ] 2.1 Add `F-026 playlists-toggle` entry to `.harness/features.json` with `scope: ["src/routes/playlists.ts", "src/db/playlist_configs.ts", "tests/routes/playlists.test.ts"]`, `depends_on: ["F-026a"]`, `priority: 13`.
- [ ] 2.2 Author `docs/specs/F-026-playlists-toggle.md` and `docs/specs/T-026-playlists-toggle.md` mirroring `openspec/changes/playlists-table-and-toggle/specs/playlists-toggle/spec.md`.
- [ ] 2.3 TDD: write failing tests in `tests/routes/playlists.test.ts` for every PATCH scenario — disable success, re-enable success, idempotent same-value, unknown id 404 `playlist_not_found`, malformed body 400 `invalid_request_body`, unauthenticated 401, `__liked__` disable 409 `liked_cannot_be_disabled`, `__liked__` idempotent enable 200.
- [ ] 2.4 Implement the `PATCH /api/playlists/:spotify_playlist_id` route handler in `src/routes/playlists.ts` (read body with Zod-style validation, refuse Liked, write via DB helper, return the row).
- [ ] 2.5 Add a write helper in `src/db/playlist_configs.ts` (`setEnabled(spotify_playlist_id, enabled)`).
- [ ] 2.6 Mount the PATCH route in `src/index.ts`.
- [ ] 2.7 Confirm 5-stage TaskCompleted hook green.
- [ ] 2.8 Open and merge PR `feat(F-026): PATCH /api/playlists/:id toggle endpoint`. Confirm `wrangler deploy` succeeds.

## 3. F-026b — Orchestrator skip + `last_synced_at` write

- [ ] 3.1 Add `F-026b orchestrator-enabled-filter` entry to `.harness/features.json` with `scope: ["src/orchestrator/", "src/db/playlist_configs.ts", "tests/orchestrator/"]`, `depends_on: ["F-026a"]`, `priority: 12`.
- [ ] 3.2 Author `docs/specs/F-026b-orchestrator-enabled-filter.md` and `docs/specs/T-026b-orchestrator-enabled-filter.md` referencing the orchestrator scenarios in `openspec/changes/playlists-table-and-toggle/specs/playlists-toggle/spec.md`.
- [ ] 3.3 TDD: write failing orchestrator tests under `tests/orchestrator/` covering "one playlist disabled, others active", "re-enable resumes from next run", "successful per-playlist sync writes timestamp", "per-playlist error preserves prior timestamp".
- [ ] 3.4 Update `src/db/playlist_configs.ts` (iteration helper) to apply `WHERE enabled = TRUE` at the SQL level.
- [ ] 3.5 Update the per-playlist sync path in `src/orchestrator/` to call a new DB write helper `recordLastSyncedAt(spotify_playlist_id)` after each per-row success. Per-row errors leave `last_synced_at` untouched.
- [ ] 3.6 Confirm 5-stage TaskCompleted hook green.
- [ ] 3.7 Manual smoke against the dev Neon branch via `wrangler dev` — create a disabled extra row, run the orchestrator, confirm it is genuinely skipped and the other rows update their `last_synced_at`.
- [ ] 3.8 Open and merge PR `feat(F-026b): orchestrator skips disabled playlists + records last_synced_at`. Confirm `wrangler deploy` succeeds.

## 4. Handoff to UI

- [ ] 4.1 Notify the UI session (or update `~/work/portage-ui/.harness/context_summary.md` directly) that Worker side of `playlists-table-and-toggle` is live. UI work proceeds at `~/work/portage-ui/openspec/changes/playlists-table-and-toggle/` (UI-PHASE-13).

## 5. Cross-cutting verification (every PR in this change)

- [ ] 5.1 5-stage TaskCompleted hook green (smoke, full, coverage-claim, schema-drift, TODO markers).
- [ ] 5.2 `wrangler deploy --dry-run` succeeds; bundle size within budget.
- [ ] 5.3 Integration test against a Neon branch confirms the migration applies cleanly and existing data survives.
- [ ] 5.4 PR description references the OpenSpec change at `openspec/changes/playlists-table-and-toggle/` and the relevant capability specs.
- [ ] 5.5 Post-deploy: `curl https://portage.eovidiu.co.uk/api/playlists` (with a Bearer JWT) returns rows including the new fields.
