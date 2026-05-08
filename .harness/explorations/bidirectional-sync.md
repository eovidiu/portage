# Bidirectional Sync Exploration

**Author:** Claude (opsx:explore mode)
**Date:** 2026-05-06
**Triggered by:** Ovidiu's request to explore turning one-way Spotify→Tidal sync into bidirectional sync
**Status:** Exploration only — no implementation decisions made
**Parallel exploration:** multi-playlist-sync (Spotify-side multi-playlist; not in scope here)

---

## 1. Goal

Enable the user to add or remove tracks from either Spotify Liked Songs or the designated Tidal playlist, with each change propagating to the other side within the next sync window (≤13 hours), such that both collections always converge to the same set of matched tracks. Unmatched tracks (no catalog counterpart on the other provider) remain visible as exceptions rather than being silently dropped.

---

## 2. Current State

The system is a strict one-way pipeline: Spotify Liked Songs is polled via `GET /v1/me/tracks` (F-005, `src/providers/spotify/liked.ts`), tracks are matched to Tidal track IDs via ISRC first (`src/match/isrc.ts`, F-006) then fuzzy scoring (`src/match/fuzzy.ts`, F-007), and matched Tidal IDs are appended to a single designated playlist (`src/sync/playlist-writer.ts`, F-008). The schema reflects this direction at the data-model level: `tracks.spotify_id` is the primary key (`db/schema.sql` line 32), `matches.spotify_id` is a foreign key into `tracks` and also the primary key of the `matches` table (line 65), and invariant I-001 (`architecture.md` line 166) defines correctness exclusively in terms of `spotify_id` membership. The architecture document explicitly calls out "Reverse sync (Tidal → Spotify)" as out of scope (`architecture.md` line 23).

The orchestrator (`src/sync/orchestrator.ts`) runs under a Postgres advisory lock (F-009), processes at most `LIKED_PAGES_PER_RUN` Spotify pages and `MATCH_BATCH_ISRC` + `MATCH_BATCH_FUZZY` tracks per invocation (F-015 bounds), and fires 2x daily via cron (F-010). The Workers Free 50-subrequest cap is the binding constraint that shaped F-015; adding a Tidal read pass to every invocation directly competes with the existing subrequest budget.

---

## 3. Why Bidirectional Is Structurally Harder

One-way sync is a read-append pipeline: you never have to decide which version of truth wins, because there is exactly one source. Bidirectional sync introduces three new problem classes simultaneously. First, **conflict**: if the user removes track T from Spotify Liked and adds it to Tidal directly, the same invocation could both remove and re-add it depending on processing order. Second, **loop prevention**: a write to Tidal triggers state that, on the next poll, looks like a new Tidal addition — without provenance tracking, the system cannot distinguish user intent from its own prior writes. Third, **state divergence**: the current schema has no concept of a Tidal-originated track; the `tracks` and `matches` tables encode Spotify-as-primary so deeply (spotify_id PK on both, I-001 formulated in terms of spotify_id) that adding a Tidal-originated track requires either a schema redesign or a parallel table. Any of these three problems is individually solvable; solving all three simultaneously at acceptable cost is the question this document examines.

---

## 4. Design Questions with Chosen Answers

### Q1: Conflict resolution model — which do we pick?

**Options considered:**
- Last-write-wins (LWW) per track, based on provider-side timestamp
- Source-of-truth (one provider is canonical, the other mirrors)
- True symmetric merge with conflict detection

**Chosen: Source-of-truth with Spotify as canonical.**

Rationale: this is the simplest model that prevents data loss and requires the fewest schema changes. In a source-of-truth model, Spotify Liked Songs is the authoritative list. Tidal mirrors it. If the user removes a track from Spotify, it is removed from Tidal on the next sync. If the user adds a track directly to the Tidal playlist (not via Spotify Liked), it is treated as a "Tidal extra" and either ignored (simplest) or surfaced to the user as an out-of-band addition — it does not propagate back to Spotify Liked without explicit user action.

The alternative — Tidal canonical — makes no sense for this user's workflow (they discover on Spotify, want Roon to see it). True symmetric merge is objectively too complex: it requires a shared identity for every track across both providers' catalogs, a conflict log, and user-driven resolution for every conflict — this is a product that takes months to build correctly and has real data-loss risk if the resolution logic has a bug.

LWW per track sounds simple but isn't: Tidal's playlist items have `meta.addedAt` (optional, OAS `Playlists_Items_Resource_Identifier_Meta` line 20623) and the playlist itself has `lastModifiedAt` (OAS `Playlists_Attributes` line 20584). Spotify's liked tracks have `added_at` (F-005). The timestamps are from different clock domains with no guaranteed monotonic relationship, and Tidal's `addedAt` on playlist items is marked optional in the schema — it may be absent. LWW would silently drop tracks whenever the timestamp comparison produces an unexpected ordering. That is a data-loss vector.

**Source-of-truth verdict:** Spotify stays canonical. Tidal-only additions are surfaced but not propagated back to Spotify automatically. The removal direction (Spotify removes → Tidal removes) is the meaningful new capability.

### Q2: Reverse matching (Tidal→Spotify) — do we need it for the SOT model?

In a pure Spotify-as-SOT model, we do NOT need a full reverse matcher. The Tidal playlist is treated as a mirror that the system manages. We never need to look at Tidal-originated tracks and ask "what is this on Spotify?" because we never ingest Tidal-originated tracks as equal citizens.

The one scenario where reverse matching matters is the "Tidal extra detection" pass — if we want to notify the user that the Tidal playlist contains tracks that weren't synced by this system (tracks the user added directly). For that narrow purpose, ISRC-only reverse matching is sufficient: fetch the Tidal playlist items (we already do this in `getAllPlaylistTrackIds` at `src/providers/tidal/playlist.ts` line 101), then for each Tidal ID that isn't in our `matches` table, fetch the track's ISRC via `GET /v2/tracks/{id}?include=artists`, then search Spotify for that ISRC via `GET /v1/search?q=isrc:XXXX&type=track`. This is an additive feature (F-018 if we number it) and is not required for the core SOT bidirectional capability.

The Spotify search-by-ISRC endpoint is `GET /v1/search?q=isrc:XXXX&type=track`. It exists and returns track objects including `id`, `name`, `artists`, and `external_ids.isrc`. This is documented in the Spotify Web API. However, it is NOT currently implemented in `src/providers/spotify/` — there is only `liked.ts` and `oauth.ts`. A reverse ISRC search would require a new `src/providers/spotify/search.ts` module.

### Q3: Tidal API capabilities for the read side — what exists?

**Available (confirmed from `src/providers/tidal/openapi-types.ts`):**

| Capability | Endpoint | OAS Location |
|---|---|---|
| Get playlist items (paginated) | `GET /playlists/{id}/relationships/items` | Line 8093 |
| Delete tracks from playlist | `DELETE /playlists/{id}/relationships/items` | Line 8205 |
| Get playlist metadata (incl. `lastModifiedAt`) | `GET /playlists/{id}` | Line 7644 |
| List user playlists | `GET /playlists?filter[owners.id]=me` | Line 7563 |
| Get user's favorited tracks (Tidal equivalent of Liked) | `GET /userCollectionTracks/me/relationships/items` | Line 14837 |
| Tidal track `isrc` field (non-optional) | Track attributes schema | Line 21869 |
| Playlist items `addedAt` (optional meta) | `Playlists_Items_Resource_Identifier_Meta` | Line 20623 |

**What we already use:** `getAllPlaylistTrackIds` (`src/providers/tidal/playlist.ts` line 101) reads the full playlist to deduplicate before append. This subrequest is already budgeted in the current 50-cap math.

**Gaps / risks:**
- Playlist item `addedAt` is optional (line 20623: `addedAt?: string`). We cannot rely on it for change detection across all tracks. The playlist-level `lastModifiedAt` is present and non-optional (line 20584) and is the safer sentinel.
- There is no "track removed from playlist" webhook. Detection requires comparing the full playlist snapshot against the previous known state — which requires storing a snapshot or a sorted set of Tidal IDs in the DB.
- `GET /v2/tracks/{id}` exists and returns `isrc` (line 21869, non-optional). Fetching an individual track's ISRC for reverse matching is possible, but costs one subrequest per Tidal-only track.

### Q4: Change detection — how do we know what changed on each side?

**Spotify side (currently handled):** Spotify's `added_at` per track drives the cursor in `sync_state` (I-005). The system knows exactly which tracks are new since the last sweep because of the high-water mark. Removals are not currently tracked — the cursor only advances forward.

**Spotify removal detection:** Spotify does not provide a "removed" event. Detection requires either (a) full re-fetch of all Liked Songs and diffing against our `matches` table, or (b) storing the full set of `spotify_id`s from the last successful fetch and diffing. Option (b) costs one additional DB write per sweep. Option (a) costs O(n) Spotify API calls for a large library — incompatible with the 50-subrequest cap on Workers Free.

For the SOT model, Spotify removal detection is the harder problem. Without it, "bidirectional" only works in the addition direction: new Spotify Liked → Tidal playlist. Removals would require an opt-in "full reconcile" mode.

**Tidal side:** The `lastModifiedAt` timestamp on `GET /playlists/{id}` (OAS line 20584) tells us whether the playlist changed since last sync. We can persist this in `sync_state` (same key-value table already used for cursor, `db/schema.sql` line 99). If `lastModifiedAt` is unchanged, we skip the full item fetch — one subrequest. If changed, we fetch all items — which we already do for deduplication. The diff against `matches` reveals additions (not in `matches`, treat as Tidal-extra) and removals (in `matches` but not in Tidal playlist items, treat as user-deleted from Tidal → remove from Spotify Liked per SOT? No — in SOT, the Tidal playlist is the mirror, not the source; a user deleting from the Tidal mirror should NOT propagate back to Spotify Liked. It should just be re-added on the next sync. This is actually the safe behavior.)

### Q5: Removal semantics — what happens if the user removes a track from Spotify?

In the SOT model: if track T is removed from Spotify Liked, it should be removed from the Tidal playlist on the next sync. This is the core new behavior.

Mechanically: the orchestrator needs a "reconcile" pass that compares the current Spotify Liked set against `matches`. Any `spotify_id` in `matches` that is no longer in Spotify Liked gets removed from the Tidal playlist and deleted from `matches`.

The risk: if a sync ran with stale state (e.g., Spotify API returned an incomplete page, or the user removed tracks while a sweep was mid-flight), a reconcile pass could incorrectly remove tracks that are still liked. The F-015 mid-sweep resume URL design means the system might think only a subset of Liked Songs was the "current set" during a multi-invocation sweep. A reconcile pass MUST NOT run during a mid-sweep state (when `sync_state.spotify_resume_url` is non-empty).

A reconcile pass also requires fetching all Spotify Liked Songs to build the full current set — which is O(n) subrequests for a large library. This is incompatible with Workers Free without careful budgeting.

### Q6: One-sided songs — Spotify only, no Tidal match

This is the existing behavior: tracks with no Tidal match go to `unmatched` (F-007 → `src/db/unmatched.ts`). Nothing changes in the SOT model. The track stays in `unmatched` until manually resolved (F-012) or the next sync retry.

In the bidirectional model, if a Spotify-only track is later removed from Spotify Liked, the reconcile pass should also clean up the `unmatched` row. Currently `unmatched` rows are never deleted — they transition through `pending → matched | skipped`. A new terminal state `removed` would be needed, or the row can be deleted outright (cleaner).

### Q7: One-sided songs — Tidal only, no Spotify match

In the SOT model, Tidal-only tracks are "Tidal extras" — tracks the user added directly to the Tidal playlist without going through Spotify. There are two sub-cases:

- The track exists on Spotify (ISRC matches): we could surface it to the user via the unmatched queue UI or a new `GET /tidal-extras` endpoint. We do NOT auto-add it to Spotify Liked (that would require a Spotify write scope we don't have, and would be confusing behavior).
- The track does not exist on Spotify (Tidal-exclusive catalog): same handling — surface it, never try to propagate.

Storage: a new table `tidal_extras` is the clean option. See schema sketch in section 9.

In the SOT model, the Tidal-extras detection is purely informational — it does NOT affect the sync logic. The next sync will see these tracks as already in the playlist (via `getAllPlaylistTrackIds` deduplication) and skip re-adding them. They will remain in the playlist indefinitely because the SOT model does not remove Tidal-extras (they're not in `matches`, so the reconcile pass ignores them).

This is actually fine: the user explicitly added those tracks to Roon via Tidal. Removing them automatically would be unexpected and destructive.

### Q8: Playlists — Tidal-only or Spotify-only

Architecture ADR-006 (`architecture.md` line 406) explicitly limits scope to a single designated Tidal playlist. The current system does not manage multiple playlists on either side. The parallel multi-playlist exploration is a separate scope boundary.

For the bidirectional exploration: multi-playlist is orthogonal. The SOT model answers the question "what tracks should be in the single designated Tidal playlist?" Expanding to multiple playlists means answering "what playlists should exist on each side?" — that's a full playlist-management feature, at least F-020 territory. Do not conflate with this exploration.

**Spotify-only playlists:** Ignored in this exploration. The system only touches Liked Songs, not user playlists.

**Tidal-only playlists:** Ignored. ADR-006 is a single designated playlist. The user can have other Tidal playlists; we don't touch them.

---

## 5. Recommended Simplest Design

**Name:** Source-of-truth bidirectional with addition propagation only (Phase 1), removal reconcile as Phase 2.

**Phase 1 — Addition propagation (Spotify→Tidal, already done) + Tidal removal re-add prevention:**
This is already implemented. The only meaningful addition for "bidirectional feel" is: if the user removes a track from the Tidal playlist, the next sync re-adds it (because the SOT is Spotify, and the track is still Liked). This is automatic and already correct behavior — the playlist writer deduplicates against current playlist contents, and since the track is still matched, it will be re-added.

From the user's perspective this looks bidirectional: Tidal playlist always reflects Spotify Liked. Changes to Tidal are ignored (overwritten on next sync). This is the simplest design that satisfies "both sides always have the same playlists" IF "both sides" means "Tidal reflects Spotify."

**Phase 2 — Spotify removal → Tidal removal (new capability):**
This is the meaningful new work. It requires:

1. A full Spotify Liked Songs fetch (all pages, not just new pages) to build the current set. This can only run when `spotify_resume_url` is empty (no mid-sweep in progress).
2. A diff against `matches` to find spotify_ids no longer in the liked set.
3. For each removed spotify_id: look up the matched `tidal_id` in `matches`, call `DELETE /playlists/{id}/relationships/items` with that tidal_id, delete the `matches` row, optionally mark the `unmatched` row as `removed`.
4. Store the `lastModifiedAt` of the Tidal playlist in `sync_state` after the reconcile.

**Env vars added for Phase 2:**
- `TIDAL_RECONCILE_ENABLED`: boolean flag (default `false`). Off by default so production is not affected by accident.
- `TIDAL_LIKED_RECONCILE_PAGES`: page budget for the full Spotify fetch during reconcile (default: same as `LIKED_PAGES_PER_RUN`). Full reconcile needs all pages — this must be large enough.
- `TIDAL_RECONCILE_FREQUENCY_HOURS`: run reconcile at most once per N hours (default 24). Throttle to avoid burning the 50-subrequest cap.

**New feature IDs:**
- F-016: Tidal playlist read pass — detect `lastModifiedAt` change, read current playlist item set, persist `tidal_watermark` and `tidal_playlist_etag` to `sync_state`
- F-017: Spotify removal reconcile — full Liked Songs fetch, diff against `matches`, delete removed entries from Tidal playlist and matches table
- F-018 (optional, low priority): Tidal extras detection — identify Tidal playlist items not in `matches`, surface via `GET /tidal-extras` endpoint
- F-019 (optional, low priority): Reverse ISRC match — for Tidal extras, search Spotify by ISRC and surface as candidates in the extras endpoint

---

## 6. Alternatives Considered

- **True symmetric merge**: rejected — requires shared track identity, conflict log, and user-driven resolution; data-loss risk on any bug in resolution logic; estimated 3x more work than SOT.
- **Tidal-canonical (Tidal is SOT)**: rejected — the user's discovery workflow is Spotify-native; making Tidal canonical would require writing to Spotify Liked Songs (a scope that requires `user-library-modify` permission, which the current OAuth flow does not request) and would invert the expected direction.
- **LWW (last-write-wins by timestamp)**: rejected — Tidal playlist item `addedAt` is optional (OAS line 20623); timestamp comparison across provider clock domains is unreliable; data-loss risk when `addedAt` is absent.
- **Webhook-driven**: rejected — Spotify provides no user library webhooks; Tidal provides no playlist webhooks. Poll-only is the only option.
- **Tidal favorites instead of playlist as sync target**: rejected — ADR-006 (`architecture.md` line 406) is deliberate; `userCollectionTracks` endpoint exists (OAS line 14837) but switching targets would require a migration and changes the Roon integration semantics.

---

## 7. Edge Case Handling

### Songs only on Spotify (no Tidal match — current behavior)

Tracked in `unmatched` with `status='pending'`. The SOT bidirectional model does not change this. If the track is later removed from Spotify Liked, the reconcile pass (F-017) should clean up the `unmatched` row. Proposed: set `unmatched.status = 'removed'` (new status value, requires a schema amendment) or delete the row. The cleaner option is deletion — a removed-from-Spotify track should not appear in the unmatched review queue.

Required schema change: either allow deletion of `unmatched` rows, or add `'removed'` to the CHECK constraint on `unmatched.status`. The CHECK currently reads `CHECK (status IN ('pending','matched','skipped'))` (`db/schema.sql` line 83). Adding `'removed'` is additive and non-breaking.

### Songs only on Tidal (Tidal-only extras, no Spotify counterpart)

Not tracked currently (no `tidal_extras` table). In the SOT model, these tracks remain in the Tidal playlist indefinitely — the reconcile pass only removes tracks that WERE matched (i.e., in `matches`) and are no longer liked on Spotify. Tidal extras (tracks not in `matches`) are untouched.

If F-018 (Tidal extras detection) ships, these entries live in a `tidal_extras` table with `tidal_id PK`, `isrc` (nullable), `first_seen_at`, `last_seen_at`. The system does not write to Spotify Liked Songs; surfacing is informational only.

Risk to assess pre-F-018: the current `getAllPlaylistTrackIds` call (`src/providers/tidal/playlist.ts` line 101) fetches ALL playlist items for deduplication. Tidal extras are already in this set, so they correctly prevent re-adding. No code change needed for extras to "work" in the deduplication sense — only if you want to surface them to the user.

### Playlists only on Spotify

Out of scope. ADR-006 and the current architecture only touch Liked Songs, not playlists. If the parallel multi-playlist exploration ships, this becomes relevant.

### Playlists only on Tidal

Out of scope. The system ignores all Tidal playlists except the single designated sync target. Tidal-only playlists (including any the user creates) are not touched.

---

## 8. Tidal API Gap Analysis

| Capability needed | Available | Risk |
|---|---|---|
| Read current playlist items (for dedup) | Yes — `GET /playlists/{id}/relationships/items` (OAS line 8093), already implemented in `getAllPlaylistTrackIds` | None |
| Delete tracks from playlist | Yes — `DELETE /playlists/{id}/relationships/items` (OAS line 8205) | Not yet implemented in `src/providers/tidal/playlist.ts`; needs new function |
| Get playlist `lastModifiedAt` | Yes — `GET /playlists/{id}` attributes (OAS line 20584) | Already called via `getPlaylist()` in `src/providers/tidal/playlist.ts` line 60; `lastModifiedAt` not currently extracted but is present in the response |
| Get per-item `addedAt` timestamp | Partial — `Playlists_Items_Resource_Identifier_Meta.addedAt` is optional (OAS line 20623) | Cannot rely on it for change detection; use playlist-level `lastModifiedAt` instead |
| Get Tidal "favorites" (userCollectionTracks) | Yes — `GET /userCollectionTracks/me/relationships/items` (OAS line 14837), supports `addedAt` sort | Not currently used; needed only for F-018 Tidal extras detection |
| Get Tidal track ISRC for reverse matching | Yes — `GET /v2/tracks/{id}` returns `isrc` as non-optional (OAS line 21869) | One subrequest per track; expensive at scale under Workers Free cap |
| List user's Tidal playlists | Yes — `GET /playlists?filter[owners.id]=me` (OAS line 7563) | Not needed for SOT model |

**Confirmed gaps requiring new code:**
- `removeTracksFromPlaylist(env, playlistId, trackIds[])` — new function in `src/providers/tidal/playlist.ts`, using `DELETE /playlists/{id}/relationships/items`. Body shape: `PlaylistsItemsRelationshipRemoveOperation_Payload` (OAS schema at line 8227). Must be grounded against the OAS before implementation.
- `extractLastModifiedAt` — helper to pull `lastModifiedAt` from `getPlaylist()` response; the field is in `attributes` but the current `TidalPlaylist` interface at `src/providers/tidal/playlist.ts` line 11 only captures `id` and `name`.

**Not a gap but a risk:** Tidal's `DELETE /playlists/{id}/relationships/items` has no test coverage in the project yet. The F-008 implementation tests (`tests/providers/tidal/playlist.test.ts`) only cover add/get operations. Any F-017 implementation must add tests for the delete path, including the `PlaylistsItemsRelationshipRemoveOperation_Payload` body shape.

---

## 9. Schema Migration Sketch

All changes are additive. The existing `tracks`, `matches`, `unmatched`, `sync_runs`, and `sync_state` tables are preserved as-is with the following additions:

```sql
-- F-016: store Tidal playlist last-modified sentinel in sync_state (no schema change needed --
-- sync_state is already a key/value store; new keys:
--   'tidal_playlist_last_modified' = ISO 8601 timestamp from lastModifiedAt
--   'tidal_reconcile_cursor'       = ISO 8601 timestamp of last successful reconcile run
-- These use the existing UPSERT pattern in src/db/sync_state.ts.

-- F-017: new status value for unmatched rows that were Spotify-removed
ALTER TABLE unmatched
  DROP CONSTRAINT IF EXISTS unmatched_status_check,
  ADD CONSTRAINT unmatched_status_check
    CHECK (status IN ('pending', 'matched', 'skipped', 'removed'));

-- F-018 (optional): Tidal extras — tracks in the Tidal playlist not originating from this system
CREATE TABLE IF NOT EXISTS tidal_extras (
  tidal_id      TEXT PRIMARY KEY,
  isrc          TEXT,
  artist        TEXT,
  title         TEXT,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tidal_extras_isrc ON tidal_extras(isrc) WHERE isrc IS NOT NULL;

-- F-017 amendment to sync_runs: track reconcile stats separately
ALTER TABLE sync_runs ADD COLUMN IF NOT EXISTS reconcile_removed INT DEFAULT 0;
```

No new primary tables are needed for Phase 1 (SOT addition propagation — already working) or Phase 2 (F-016 + F-017 removal reconcile). The only breaking consideration is the `unmatched.status` CHECK constraint amendment, which must be applied before F-017 code ships.

The `matches` table does not need a `origin` column (a concern raised implicitly by "Tidal-originated entries"). In the SOT model, every row in `matches` originates from a Spotify Liked Song. Tidal extras do not get rows in `matches`.

---

## 10. Loop Prevention Design

The loop scenario: the system adds track T to Tidal playlist → next poll detects T in Tidal playlist as a "new item" → system tries to propagate T back to Spotify Liked Songs (if we ever implement Tidal→Spotify write).

In the pure SOT model (Spotify canonical, Tidal is mirror), **there is no loop** because we never write to Spotify. The system only reads Spotify Liked Songs; it does not modify them. The Tidal playlist is written by this system; reads of the Tidal playlist are used only for deduplication and reconcile, not as input to a "sync to Spotify" step.

If a future version adds Tidal→Spotify writes (outside the scope of this exploration), loop prevention would require a `provenance` column on every record. The `matches` table already implicitly tracks this (every `matches` row was created by this system based on a Spotify like), and the `tidal_extras` table (F-018) would track Tidal-originated tracks that are NOT in `matches`. The system would need to check "is this Tidal track in `matches`?" before deciding whether to propagate. Since `matches.tidal_id` is indexed (`idx_matches_tidal`, `db/schema.sql` line 119), this lookup is cheap.

For the SOT model as recommended: no special loop prevention mechanism is needed. The data flow is strictly unidirectional at the write level.

---

## 11. Effort Estimate

| Phase | Features | New LOC (approx) | Test LOC (approx) | Sprints |
|---|---|---|---|---|
| Phase 1 (SOT model, Tidal re-adds) | None — already works | 0 | 0 | 0 |
| Phase 2 F-016 (Tidal watermark) | `removeTracksFromPlaylist`, `lastModifiedAt` extraction, `sync_state` keys | ~80 src | ~120 test | 0.5 |
| Phase 2 F-017 (Spotify removal reconcile) | Full Liked fetch diff, Tidal delete, `matches` cleanup, `unmatched` status amendment | ~200 src | ~300 test | 1 |
| F-018 (Tidal extras detection, optional) | `tidal_extras` table, detection pass, `GET /tidal-extras` endpoint | ~150 src | ~200 test | 1 |
| F-019 (Reverse ISRC match, optional) | `src/providers/spotify/search.ts`, reverse lookup in extras endpoint | ~100 src | ~150 test | 0.5 |

**Total for core bidirectional (F-016 + F-017):** ~280 src LOC, ~420 test LOC, ~1.5 sprints.

**Subrequest budget impact:** F-016 adds 1 subrequest per invocation (GET playlist to check `lastModifiedAt`). F-017 adds N subrequests for N pages of Spotify Liked Songs (full re-fetch) + M subrequests for M Tidal deletes. The full re-fetch is the expensive operation. The `TIDAL_RECONCILE_FREQUENCY_HOURS` throttle prevents this from running on every invocation — it would run at most once per day, in a dedicated invocation where the Spotify fetch budget is fully allocated to reconcile rather than to the incremental sweep. This likely requires a new orchestrator mode flag or a separate scheduled handler.

---

## 12. Open Questions for Ovidiu

1. **Scope of bidirectional**: Do you want the removal direction (Spotify removes → Tidal removes, F-017), or is Phase 1 (Tidal always reflects current Spotify Liked) sufficient? Phase 1 is already shipped. Phase 2 is the real work.

2. **Workers tier**: F-017's full Spotify Liked re-fetch is O(n/50) subrequests. For a library of 500 tracks (10 pages), that's 10 Spotify API calls — feasible on Workers Free if the reconcile runs in a dedicated invocation with no other work. For 5,000 tracks (100 pages), you'd need 100 subrequests — that's 2 invocations just for the Liked Songs fetch. Do you want to pay $5/mo for Workers Paid (unlimited subrequests) to make F-017 viable at scale, or should F-017 be bounded the same way F-015 bounded F-005?

3. **Tidal extras handling**: When the user adds a track directly to the Tidal "Spotify Liked" playlist (bypassing this system), do you want to (a) leave it there silently and let Roon play it, (b) remove it on the next sync (treating the Tidal playlist as write-protected except by this system), or (c) surface it in a `GET /tidal-extras` endpoint so you can review it on iOS? Option (b) is the strictest SOT enforcement. Option (a) is the current implicit behavior.

4. **Spotify write scope**: Do you ever want Tidal→Spotify propagation? This would require re-running the Spotify OAuth flow with the `user-library-modify` scope added. The current OAuth flow (`src/providers/spotify/oauth.ts`) does not request it. Adding it invalidates the existing refresh token and requires a fresh OAuth dance. This is a point of no return — if you add the scope, you're committing to managing Spotify writes as well.

5. **Removal safety window**: Should the reconcile pass require track T to be absent from Spotify Liked for two consecutive full fetches before deleting it from Tidal? A single-pass removal is simpler but risks removing a track that disappeared due to a Spotify API glitch. A two-pass approach costs one extra Spotify fetch per reconcile cycle. Your call on the risk/complexity trade-off.

---

## 13. Recommendation: Should This Ship?

**Short answer:** Phase 1 is already shipped and is the safest version of "bidirectional." Phase 2 (F-017, removal propagation) is worth building IF Ovidiu actively removes tracks from Spotify Liked and expects Tidal to reflect those removals. If the workflow is primarily additive (discover → like → sync), Phase 1 is sufficient and the added complexity of F-017 is unjustified.

**Phase 2 risk assessment:** The highest-risk step in F-017 is the Tidal DELETE call. If the reconcile runs with a stale or incomplete Spotify Liked Songs fetch (mid-sweep edge case), it could incorrectly mark tracks as "removed" and delete them from Tidal. Data loss of this type is non-obvious to the user: they'd notice the Tidal playlist shrinking without understanding why. Mitigations: (a) only reconcile when `spotify_resume_url` is empty (sweep is complete), (b) implement a safety window (see Q5 above), (c) log every deletion with `event: "reconcile_remove"` and include `spotify_id`, `tidal_id`, `reason` so you can audit. All three mitigations should be required for F-017 to ship.

**Phased approach:**
- Sprint N: F-016 only (Tidal watermark — read-only, zero risk). Establishes the infrastructure for change detection.
- Sprint N+1: F-017 behind `TIDAL_RECONCILE_ENABLED=false` default — ship the code, test it manually on a small library, flip the flag only after confident.
- Sprint N+2: F-018 (extras detection) if the user wants it.

This is the lowest-risk path to bidirectional sync that doesn't compromise the existing reliable one-way pipeline.
