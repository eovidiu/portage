# Multi-Playlist Sync — Implementation Plan

**Author:** Claude (harness-continue, plan mode)
**Date:** 2026-05-07
**Status:** plan — decisions locked, ready for execution. Live Neon migration held until Ovidiu is at terminal.
**Source exploration:** `.harness/explorations/multi-playlist-sync.md` (authoritative on design)
**Parallel exploration:** `.harness/explorations/bidirectional-sync.md` (orthogonal scope per its §122)

This plan translates the exploration into concrete, sequenceable harness features. It does
**not** restate design rationale — read the exploration for that. It captures (a) the
decisions still owed by Ovidiu, (b) the feature decomposition with file scopes and deps,
(c) sequencing under harness rules, (d) risks and gotchas, (e) the spec amendments needed.

---

## 0. Decisions Locked (2026-05-07)

Ovidiu confirmed the five planning questions on 2026-05-07. Locked answers:

| # | Question | Decision |
|---|----------|----------|
| Q1 | Liked Songs migrated into `playlist_membership` or kept on the global watermark? | **Unify.** One write path for all playlists. One-time backfill SQL runs in commit ① of F-016. Global `last_playlist_write_at` key in `sync_state` is retired once `playlist_membership.synced_at` is authoritative for `__liked__`. |
| Q3 | Target playlist count? | **3 extras (4 total including Liked).** `MAX_PLAYLISTS_PER_RUN=3`. Round-robin across ticks (F-019) deferred until Ovidiu wants more. |
| Q4 | Backfill strategy for currently-matched Liked tracks? | **Pre-set `synced_at = matched_at`.** Assumes already-synced into the Tidal "Spotify Liked" playlist. F-008 production behaviour confirms add-tracks is idempotent on already-present items (commit e6f2eb6), so even a wrong assumption self-corrects on next sync. |
| Q-num | Feature numbering vs `bidirectional-sync.md`? | **Multi-playlist takes F-016/F-017/F-018 (+ F-016b orchestrator amendment).** Bidirectional renumbers to F-019+ if/when it ships. Documented at the head of `bidirectional-sync.md` once that work activates. |
| Q-prio | Sequencing vs Sprint 7 follow-ups? | **Functional order:** F-009 M5 (discriminated error_code) ships first as a Sprint 7 carry-over because F-016b extends the orchestrator's error handling. F-012 M1/M2/M3, F-013 M4, M7 logging interleave opportunistically — none block multi-playlist. |

Q2/Q5/Q6/Q7/Q8 in the exploration are answered there with strong rationale; this plan
adopts those as-is. Q-rename / Q-collab / Q-empty-name from §10 below remain open
defaults (no auto-rename; no owner filter on the env var; fall back to
`Spotify Playlist {id}` on empty name) — confirm only if Ovidiu objects.

---

## 1. Feature Decomposition

Four new features. Each is a candidate for a new spec under `docs/specs/F-NNN-*.md` plus a
matching test spec `docs/specs/T-NNN-*.md`. Specs are authored alongside code per project
spec-first rule.

### F-016 — Playlist config registry + discovery

**Description:** New `playlist_configs` table; bootstrap helpers (seed Liked Songs row,
seed extras from env). New `fetchSpotifyPlaylistName` provider helper. No orchestrator
wiring yet — F-016 is a leaf usable in isolation.

**Spec files:** `docs/specs/F-016-playlist-config.md`, `docs/specs/T-016-playlist-config.md`

**Code scope (new):**
- `src/db/playlist_configs.ts` — CRUD helpers (`upsertPlaylistConfig`, `listPlaylistConfigs`,
  `getPlaylistConfig`, `setTidalPlaylistId`, `markSynced`)
- `src/providers/spotify/playlists.ts` — `fetchSpotifyPlaylistName(env, id)` (single
  `GET /v1/playlists/{id}?fields=name` via `spotifyFetch`)
- `src/sync/playlist-config-seeder.ts` — `seedPlaylistConfigs(env)` (reads
  `SPOTIFY_EXTRA_PLAYLIST_IDS`, upserts rows; idempotent), `ensureLikedConfig(sql)`
- `tests/db/playlist_configs.test.ts`
- `tests/providers/spotify/playlists.test.ts`
- `tests/sync/playlist-config-seeder.test.ts`

**Code scope (modified):**
- `src/env.ts` — add `SPOTIFY_EXTRA_PLAYLIST_IDS?: string` and `MAX_PLAYLISTS_PER_RUN?: string`
- `db/schema.sql` — add `playlist_configs` table + `__liked__` seed + `INSERT ... ON CONFLICT
  DO NOTHING`

**Deps:** F-002 (Spotify OAuth — uses `spotifyFetch`), F-008 (Tidal playlist write — uses
`createPlaylist` for the field type, not at runtime; F-016 doesn't create Tidal playlists)

**Out of scope:** Tidal playlist creation, multi-playlist fetch/write, orchestrator changes.

**Subrequest cost at runtime:** zero (config seeding hits Spotify only on a *new* playlist
ID first appearance — one extra subrequest per new playlist per cold start). Steady state
is zero — `playlist_configs.spotify_name` is read from DB.

**Estimated LOC:** ~200 src, ~300 test (per exploration §9).

---

### F-017 — Multi-playlist Spotify fetch + membership

**Description:** New fetch path for `/v1/playlists/{id}/tracks` mirroring F-005's
mid-sweep design (bounded pages, resume URL, sweep_max). Per-playlist cursor keys in
`sync_state`. New `playlist_membership` table writes for both Liked Songs (via F-005's
existing fetch, post-fetch hook) and extras.

**Spec files:** `docs/specs/F-017-multi-playlist-fetch.md`, `docs/specs/T-017-multi-playlist-fetch.md`

**Code scope (new):**
- `src/providers/spotify/playlists.ts` — extend with `fetchPlaylistTracks(env, playlistId,
  maxPages)` modelled on `fetchLikedSongs`; differs in: URL template, cursor key prefix
  pattern (`playlist:{id}:cursor` etc.), `playlist_membership` write (per-track row with
  `synced_at = NULL`)
- `src/db/playlist_membership.ts` — `upsertMembership`, `markSynced`, `selectUnsyncedForPlaylist`,
  `selectUnsyncedForPlaylistJoinedToMatches`
- `src/db/sync_state.ts` — extend with prefixed-key helpers (`getPlaylistCursor`,
  `getPlaylistResumeUrl`, etc.) — or a single `keyForPlaylist(prefix, id, suffix)` helper
  if simpler
- `tests/providers/spotify/playlists.test.ts` — extend with `fetchPlaylistTracks` cases
- `tests/db/playlist_membership.test.ts`

**Code scope (modified):**
- `src/providers/spotify/liked.ts` — write membership rows for `__liked__` after persist
  transaction (Q1=unify) **OR** leave unchanged (Q1=dual-path). Recommended: keep
  `liked.ts` itself unchanged; do the membership write in the orchestrator post-fetch
  step. This minimises F-005 churn.
- `db/schema.sql` — add `playlist_membership` table + indices

**Deps:** F-016 (uses `playlist_configs` to look up the spotify_playlist_id), F-005
(membership write piggybacks on Liked fetch transaction), F-015 (the budget loop pattern
to mirror)

**Subrequest cost at runtime:** 1 Spotify subrequest per playlist per tick (one page each;
LIKED_PAGES_PER_RUN already covers Liked Songs). N extras = N additional subrequests.

**Critical invariant to preserve (I-005):** the membership rows for a fetched page MUST be
written atomically with the `tracks` upsert and the cursor advance. The existing
`db.transaction` callback array form already takes N queries; add the membership UPSERT
to it. Test must capture all writes by key (extending the `captureStateWrites` pattern
from F-015's tests).

**Recommend:** options-object signature for `fetchPlaylistTracks` from day one (avoids
the F-015-style late-stage signature churn for `matchByFuzzy`).

**Estimated LOC:** ~250 src, ~350 test.

---

### F-018 — Multi-playlist Tidal write

**Description:** Generalise `writePlaylist` from "the single playlist" to "a specified
playlist". Auto-create Tidal playlist on first sync (using Spotify name from
`playlist_configs.spotify_name`). Replace global `last_playlist_write_at` watermark with
`playlist_membership.synced_at` per-row marker.

**Spec files:** `docs/specs/F-018-multi-playlist-write.md`, `docs/specs/T-018-multi-playlist-write.md`

**Code scope (modified):**
- `src/sync/playlist-writer.ts` — change `writePlaylist(env)` →
  `writePlaylist(env, spotifyPlaylistId, tidalPlaylistId | null)`. Body changes:
  - If `tidalPlaylistId === null`, call `createPlaylist(env, spotify_name)` (looked up
    from `playlist_configs`), persist to `playlist_configs.tidal_playlist_id`
  - Replace `selectMatchesNewerThan` with `selectUnsyncedMatchesForPlaylist(sql,
    spotifyPlaylistId)` — JOIN `playlist_membership` × `matches` on `spotify_id`
    WHERE `synced_at IS NULL` AND `tidal_id_invalid = false`
  - On successful Tidal append, `UPDATE playlist_membership SET synced_at = now()` for
    written rows (instead of advancing global watermark)
- `src/db/matches.ts` — add `selectUnsyncedMatchesForPlaylist` helper
- `tests/sync/playlist-writer.test.ts` — extend
- `tests/db/matches.test.ts` — extend

**Deps:** F-016 (`playlist_configs`), F-017 (`playlist_membership`), F-008 (existing
Tidal write primitives — unchanged)

**Subrequest cost at runtime:** 1 Tidal write subrequest per playlist with new tracks per
tick. Plus 1 createPlaylist on first appearance of a new playlist (one-time per playlist).

**Backward compatibility:** if Q1=keep-watermark, F-018 has a code path for `__liked__`
that stays on `selectMatchesNewerThan` and the global watermark. If Q1=unify, that path
deletes; Liked Songs uses the same `selectUnsyncedMatchesForPlaylist` query as extras.

**Estimated LOC:** ~150 src, ~250 test.

---

### F-016b — Orchestrator multi-playlist loop

**Description:** Wire F-016/F-017/F-018 together in `runSyncBody`. Loop over
`playlist_configs` (capped at `MAX_PLAYLISTS_PER_RUN`), reusing the global match queue
between fetch and write phases. Update budget allocator.

**Spec files:** Amendment to `docs/specs/F-009-sync-orchestration.md` (not a new feature
spec — extends existing orchestrator). Add T-009 cases for multi-playlist loop.

**Code scope (modified):**
- `src/sync/orchestrator.ts` — `runSyncBody`:
  1. `seedPlaylistConfigs(env)` — top of run
  2. Per-playlist fetch loop (one page each up to `MAX_PLAYLISTS_PER_RUN`); Liked Songs
     keeps `LIKED_PAGES_PER_RUN`
  3. Existing global match queue (ISRC + fuzzy) — unchanged
  4. Per-playlist write loop (calls `writePlaylist(env, spotifyId, tidalId)` for each)
- `tests/sync/orchestrator.test.ts` — new cases:
  - 1 extra playlist + Liked → both fetched, both written
  - 0 extras → behaves identically to today (regression guard)
  - `MAX_PLAYLISTS_PER_RUN=2` with 4 configs → 2 fetched, 2 deferred to next tick
  - Budget exhaustion mid-run → partial run, correct `error_code`/`error_details`
  - Auto-create on new playlist → `tidal_playlist_id` populated in
    `playlist_configs` after first run

**Deps:** F-016, F-017, F-018, F-015 (budget logic to extend)

**Estimated LOC:** ~100 src, ~200 test.

---

## 2. Dependency Graph

```
F-016 ──┬──► F-017 ──┐
        │            ├──► F-016b (orchestrator wiring)
        └──► F-018 ──┘
```

F-017 and F-018 are mutually independent given F-016 has shipped. They can run in
parallel teammate scopes. F-016b cannot start until both ship.

`features.json` `depends_on`:
- F-016: `[]` (after F-002, F-008 already exist; those are not hard deps for F-016 itself)
- F-017: `["F-016", "F-005"]`
- F-018: `["F-016", "F-008"]`
- F-016b: `["F-017", "F-018", "F-015"]`

---

## 3. Schema Migration — Sequencing

Per the **Live Neon ALTERs require Ovidiu credential** Meta-Pattern (Sprint 4): teammate
adds DDL to `db/schema.sql` + flags PENDING in `features.json.notes`; lead applies via
Neon MCP `mcp__Neon__run_sql` using the idempotent `IF NOT EXISTS` form.

**Migration order:**

1. **Before F-016 ships** (lead-applied, deployed independently — additive, safe):
   ```sql
   CREATE TABLE IF NOT EXISTS playlist_configs (
       spotify_playlist_id   TEXT PRIMARY KEY,
       spotify_name          TEXT NOT NULL,
       tidal_playlist_id     TEXT,
       created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
       last_synced_at        TIMESTAMPTZ
   );
   INSERT INTO playlist_configs (spotify_playlist_id, spotify_name)
   VALUES ('__liked__', 'Spotify Liked')
   ON CONFLICT (spotify_playlist_id) DO NOTHING;
   ```

2. **Before F-017 ships:**
   ```sql
   CREATE TABLE IF NOT EXISTS playlist_membership (
       spotify_playlist_id   TEXT NOT NULL REFERENCES playlist_configs(spotify_playlist_id),
       spotify_track_id      TEXT NOT NULL REFERENCES tracks(spotify_id),
       added_at              TIMESTAMPTZ NOT NULL,
       synced_at             TIMESTAMPTZ,
       PRIMARY KEY (spotify_playlist_id, spotify_track_id)
   );
   CREATE INDEX IF NOT EXISTS idx_membership_unsynced
       ON playlist_membership (spotify_playlist_id, synced_at)
       WHERE synced_at IS NULL;
   CREATE INDEX IF NOT EXISTS idx_membership_track
       ON playlist_membership (spotify_track_id);
   ```

3. **Backfill (only if Q1=unify and Q4=pre-set, lead-applied immediately after step 2):**
   ```sql
   INSERT INTO playlist_membership (spotify_playlist_id, spotify_track_id, added_at, synced_at)
   SELECT '__liked__', t.spotify_id, t.spotify_added_at, m.matched_at
   FROM tracks t
   JOIN matches m ON m.spotify_id = t.spotify_id
   WHERE NOT m.tidal_id_invalid
   ON CONFLICT DO NOTHING;
   ```
   The `WHERE NOT m.tidal_id_invalid` clause excludes catalog-removed Tidal tracks (F-008
   gotcha). Verify count before/after with `SELECT COUNT(*) FROM playlist_membership
   WHERE spotify_playlist_id = '__liked__'`.

4. **Per the schema-drift Stage 4 hook**: every CREATE INDEX / CREATE TABLE / ALTER must
   land in `db/schema.sql` first; the hook rejects code that references columns/indices
   not in the file. So the DDL goes into the file in commit ① (before code) and the lead
   applies the live migration in parallel.

---

## 4. Sequencing & Mode Recommendation

This is **not** ready to spawn an Agent Team yet — Q1/Q3/Q4 + Q-num must answer first.

Once decisions land:

**Phase A: F-016 in single-session.** F-016 is the foundation; small, well-scoped, no
parallelism leverage. Single-session keeps coordination cost zero and gives a clean
schema-migration commit to verify before opening Phase B.

**Phase B: F-017 + F-018 in Agent Teams (2 teammates, sonnet+sonnet).**
- Independent scopes (distinct files, distinct DB tables touched)
- Mutual coordination point: both consume `playlist_configs.tidal_playlist_id` writes,
  but only F-018 writes to it; F-017 reads it. No file overlap.
- Lead spawns both, runs reviewer (opus) at end. ~2x speedup over sequential.
- This matches the "two features each touching <3 files = sequential is cheaper"
  exception threshold *only barely* — F-017 touches 4 files, F-018 touches 4 files,
  both well over 3. Agent Teams justified.

**Phase C: F-016b in single-session.** Orchestrator wiring is sequential by nature
(ties everything together, can't parallelise across the loop body).

**Phase D: Deploy + smoke-test in production.** Same gate as F-015's deploy: live
migration, deploy, single manual `POST /sync/run` against a small test playlist, verify
playlist appears on Tidal with expected tracks, ensure subrequest count <50 in wrangler
tail, then enable in cron.

---

## 5. Sprint 7 Follow-Up Sequencing

Open Sprint 7 majors (per session 9 progress + reviewer): M1 (F-012 candidates), M2/M3
(F-012 fuzzy filter), M4 (F-013 orphan ISRC), M5 (F-009 error attribution), M7 (route
logging). Plus the F-Integ extension carry-over.

**Recommendation: parallel with Phase A.** All five are scoped to existing files that
multi-playlist does not touch:
- F-012: `src/routes/unmatched.ts`, `src/db/unmatched.ts`
- F-013: `src/routes/captures.ts`, `src/db/captures.ts`
- F-009 M5: `src/sync/orchestrator.ts` error handling (this DOES overlap F-016b — must
  ship M5 *before* F-016b, otherwise error attribution code lands twice)
- M7: route logging — orthogonal

Order: F-009 M5 → F-016 (parallel: F-012 M1+M2+M3, F-013 M4, M7 logging) → F-017+F-018
→ F-016b.

---

## 6. Risk Register

| ID | Risk | Mitigation |
|----|------|------------|
| R1 | Subrequest cap exceeded with 4+ playlists | `MAX_PLAYLISTS_PER_RUN=3` (env-tunable). Round-robin (F-019) deferred until needed. |
| R2 | Spotify rename of an extra playlist not propagated to Tidal | Default: don't auto-rename Tidal (per exploration Q5). Reconfirm with Ovidiu in Q-rename below. |
| R3 | Tidal playlist creation fails mid-run, leaves `tidal_playlist_id = NULL` in `playlist_configs` | Already handled by §6.3 of exploration: next tick retries `createPlaylist` on rows where `tidal_playlist_id IS NULL`. Idempotent. |
| R4 | `playlist_membership` row count grows unbounded for users with thousands of tracks across many playlists | At 4 playlists × 5K tracks = 20K rows. Negligible at Neon. Index `idx_membership_unsynced` is partial (only NULL rows), keeps write path fast. |
| R5 | F-005 cursor invariant (I-005) violated by adding membership write to its transaction | Strict TDD: red test asserts cursor + tracks + membership all written, OR none. Use `captureStateWrites` pattern from F-015 (filter writes by key). |
| R6 | Backfill (Q4=pre-set) wrongly assumes already-matched tracks are in Tidal | Counter-evidence: F-008 production behaviour confirms add-tracks is idempotent on already-present items (commit e6f2eb6 "drop client-side dedupe; trust watermark for idempotency"). So even if backfill lies, next sync corrects it. Risk low. |
| R7 | Two-step migration deploys (F-016 schema, then F-017 schema) leave DB in intermediate state if F-017 stalls | Both schema additions are forward-compatible: code without the second table never reads it. Safe to ship F-016 schema independently. |
| R8 | Per-spec test ID drift across F-016/F-017/F-018 — many tests share the multi-playlist concept | Apply the per-spec test-ID Meta-Pattern: each `describe` cites `T-NNN-MM`. Reviewer can build the spec coverage matrix mechanically. |
| R9 | Spec author drift on the new specs — schema sketch in this plan is normative, but the spec docs will be authored by teammates | Lead must review F-016 spec PR personally before F-017/F-018 begin. Spec-first rule means deviations require updating spec, not code. |
| R10 | OAS-grounding failure on the new Spotify endpoint `/v1/playlists/{id}?fields=name` | Apply the **External-API code MUST be grounded** Cross-Cutting Concern: cite the Spotify community OAS section (or developer.spotify.com) above the URL constant in `src/providers/spotify/playlists.ts`. Add a `Verified:` marker — Stage 5 hook will gate it. |

---

## 7. Spec Amendments Required

Independent of new specs F-016/F-017/F-018:

- **F-005**: amend §writeBehaviour to mention membership row write piggybacking on the
  page transaction (Q1=unify path).
- **F-008**: amend write semantics to specify the watermark replacement —
  `playlist_membership.synced_at` is the per-playlist source of truth (Q1=unify).
- **F-009**: extend orchestrator stage list to include `seedPlaylistConfigs` (top of run)
  and the per-playlist fetch/write loops.
- **F-010**: no amendment needed (cron remains 2x daily). Subrequest budget note can be
  added if helpful.
- **`docs/architecture.md`** §Domain Model: add `playlist_configs` and `playlist_membership`
  tables to the ER diagram. Add invariant I-006 if appropriate: "every track in
  `playlist_membership.synced_at` corresponds to a tidal_id present in the named Tidal
  playlist at write time" (analogue of I-002).

Per the **Spec amendment as part of refactor, not after** Meta-Pattern from F-015: bundle
amendments into the same commit as the code change for each feature.

---

## 8. Test Strategy

- **Unit:** new `playlist_configs` and `playlist_membership` DB layer reach 100% (precedent
  from `tracks`, `matches`, `unmatched`). Multi-playlist fetch/write achieve ≥95% on
  touched code. Use vi.mock for `@neondatabase/serverless` per existing pattern.
- **Integration (F-Integ extension):** add a real-Postgres integration test that:
  1. Seeds one extra playlist config
  2. Mocks Spotify `/v1/playlists/{id}/tracks` returning 3 tracks
  3. Runs orchestrator, verifies Tidal write call carries those tracks
  4. Asserts `playlist_membership.synced_at` populated for those rows
  - Use the URL-discriminating fetch mock pattern from F-Integ Sprint 6 enrichment.
- **e2e (F-Q1 extension):** add a wall-time test that 4 playlists complete in <25s
  (matches the manual `POST /sync/run` 25s timeout). Defer if not blocking.

Coverage gate: Stage 3 hook will reject task completion on vague "tooling broken" claims
— teammates must paste literal istanbul output. Sprint 3 lesson is mechanically enforced.

---

## 9. Compliance with Project Standards

- **Spec-first:** F-016/F-017/F-018 specs authored before/alongside code; deviations
  require spec amendment first.
- **TDD:** strict red-green per the `tdd-ui-expert` and existing test patterns. Every
  new function has a failing test first.
- **Coverage:** ≥95% on touched code, gated by hook Stage 3.
- **Schema drift:** every new column/table/index lands in `db/schema.sql` before code,
  gated by hook Stage 4.
- **External API grounding:** `Verified:` marker on the new Spotify URL constant, gated
  by hook Stage 5.
- **Naming:** no implementation-detail names. `playlist_configs` (not
  `PlaylistConfigManager`); `fetchSpotifyPlaylistName` (not
  `SpotifyPlaylistNameFetcher`). Consistent with project naming.
- **Error attribution:** F-016b must respect F-009 M5 follow-up's discriminated error
  codes (do not regress to hardcoded `spotify_reauth_required`). Hence M5 ships first.
- **Git identity:** verified per session start (Ovidiu Eftimie / eovidiu@gmail.com /
  id_ed25519 → github.com).

---

## 10. Open Questions Beyond the Exploration's §10

- **Q-rename:** when a Spotify playlist is renamed, do we PATCH the Tidal playlist name
  to match? Default: no (per exploration §6.5). Confirm.
- **Q-collab:** does the operator want the env var to accept *any* playlist ID (own,
  collab, followed) or restrict to `owner.id == self`? Default per exploration: no
  filter. Confirm.
- **Q-empty-name:** what if Spotify returns an empty playlist name (rare, but possible)?
  Fall back to `Spotify Playlist {id}` for the Tidal name? Default: yes.

---

## 11. What This Plan Does Not Decide

- **Whether bidirectional sync ships at all.** Separate decision; if it ships, it takes
  F-019/F-020/F-021. The bidirectional doc's §122 already acknowledges multi-playlist is
  orthogonal, so no schema collision exists.
- **Round-robin scheduling (F-019).** Deferred. Triggers when Ovidiu wants >3 extras.
- **API endpoints for managing playlist configs.** Out of scope per exploration §7.

---

## 12. Execution Order

With decisions locked, the order proceeds as:

1. **Housekeeping (no code):** Update features.json with F-016/F-017/F-018/F-016b pending
   entries; refresh context_summary.md Active Context.
2. **F-009 M5 fix:** discriminated `error_code` in `src/sync/orchestrator.ts`. Single-session,
   precedes F-016b. ~30 LOC src + tests; spec amendment to F-009 §error-handling.
3. **Phase A — F-016 (single-session):** spec → schema.sql edit → DB layer → Spotify provider
   helper → seeder → env var fields → coverage gate green → **pause** before live Neon
   migration (Ovidiu must be present).
4. **Live Neon migration for F-016 (lead-applied with Ovidiu):** CREATE TABLE
   playlist_configs + INSERT __liked__ row. Idempotent. Then commit + push F-016 branch +
   open PR.
5. **Phase B — F-017 + F-018 (Agent Team, Sonnet x2):** parallel. F-017 owns the fetch +
   membership write; F-018 owns the multi-playlist write + matches selector. Reviewer
   (Opus) checkpoint before merge.
6. **Live Neon migration for F-017** (CREATE TABLE playlist_membership + indices, plus
   the Q4 backfill INSERT) — lead-applied with Ovidiu present.
7. **Phase C — F-016b (single-session):** orchestrator wiring. Per-playlist fetch loop,
   per-playlist write loop, MAX_PLAYLISTS_PER_RUN cap, integration with the global match
   queue.
8. **Phase D — production deploy:** F-015 playbook. Set `SPOTIFY_EXTRA_PLAYLIST_IDS=` to
   one test playlist, manual `POST /sync/run`, watch wrangler tail for subrequest count
   <50, verify Tidal playlist created and tracks appear, then expand env var to full set.

Sprint 7 minor follow-ups (F-012 M1/M2/M3, F-013 M4, M7 logging) interleave anywhere
after step 1 — none block multi-playlist.
