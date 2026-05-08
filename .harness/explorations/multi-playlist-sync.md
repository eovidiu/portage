# Multi-Playlist Sync — Architecture Exploration

**Author:** Claude (opsx:explore mode)
**Date:** 2026-05-06
**Status:** exploration — no implementation started
**Parallel exploration:** bidirectional-sync (Tidal→Spotify direction; not in scope here)

---

## 1. Goal

Extend the system from syncing one source (Spotify Liked Songs via `/v1/me/tracks`) into one
target (Tidal playlist "Spotify Liked") to syncing multiple Spotify playlists, each mapping
to a dedicated Tidal playlist. The extension must be additive — Liked Songs must continue to
work under the new regime — and must stay within the Workers Free 50-subrequest cap already
enforced by F-015.

---

## 2. Current State

**What F-005/F-008/F-009 do today:**

`fetchLikedSongs` (src/providers/spotify/liked.ts:111) fetches `/v1/me/tracks?limit=50`,
paginating via `next` URL. It maintains three `sync_state` keys: `spotify_cursor` (high-water
mark, ISO timestamp), `spotify_resume_url` (mid-sweep resume, F-015), and `spotify_sweep_max`
(accumulates newest `added_at` across mid-sweep invocations). Tracks are upserted into the
`tracks` table (db/schema.sql:30). The cursor advances atomically with the last page of each
invocation (I-005). The result is a `FetchResult` with counts and a `morePagesPending` flag.

After fetch, `runSyncBody` in `src/sync/orchestrator.ts:101` reads a pending match queue
(`fetchPendingMatchQueue`, src/db/tracks.ts:76), runs ISRC matching then fuzzy matching, then
calls `writePlaylist(env)` (src/sync/playlist-writer.ts:69). `writePlaylist` reads the single
`tidal_playlist_id` from `sync_state`, calls `selectMatchesNewerThan(sql, lastWriteAt)` (which
returns ALL matches newer than the global watermark `last_playlist_write_at`, regardless of
which playlist they belong to), and appends them to the single Tidal playlist in batches of 20
(BATCH_SIZE, src/providers/tidal/playlist-endpoints.ts:10). The watermark `last_playlist_write_at`
is then advanced.

The `matches` table has `spotify_id TEXT PRIMARY KEY` — one global Spotify→Tidal pairing per
track, independent of which playlist(s) contain the track. The matching layer is playlist-agnostic
and should remain so.

**Critical observation:** the current design conflates two distinct concepts:
- "Does this Spotify track have a Tidal counterpart?" — answered by the `matches` table (global)
- "Is this Tidal track currently in the Tidal playlist for playlist X?" — answered implicitly by
  the watermark, which only works when there is one playlist

Multi-playlist requires making the second concept explicit.

---

## 3. Design Questions

### Q1: How does the system know which Spotify playlists to sync?

**Options evaluated:**
- A. All user-owned playlists via `GET /me/playlists` filtered by `owner.id`
- B. All followed playlists (superset of A)
- C. Manually configured via env var `SPOTIFY_SYNC_PLAYLIST_IDS=id1,id2,id3`
- D. Database table operator-managed (UI or SQL)
- E. Keep Liked Songs special; add playlist IDs via env var for extras

**Chosen: Option E — Liked Songs stays special; additional playlists via env var.**

Rationale: The Liked Songs endpoint (`/v1/me/tracks`) is structurally different from playlist
endpoints (`/v1/playlists/{id}/tracks`). Treating Liked Songs as "virtual playlist ID = LIKED"
forces a unified abstraction that adds code complexity without real user benefit — the fetch
shapes, cursor semantics, and API contracts differ. Keeping Liked Songs on its existing fetch
path preserves the working F-005 implementation unchanged.

An env var for additional playlist IDs (e.g., `SPOTIFY_EXTRA_PLAYLIST_IDS=abc123,def456`) is
the simplest operator interface. It requires a redeployment to add/remove playlists, which is
acceptable for a single-tenant tool. A DB-managed table adds a UI/API surface (GET/POST
/playlists) with no commensurate benefit at this stage.

For the simplest viable design, start with Liked Songs + up to 3-4 manually configured extras.
If the list grows beyond ~5 playlists, revisit with a DB table (that becomes F-019 or later).

Trade-off: env var changes require a redeploy. This is intentional — it provides a deployment
gate on scope changes.

### Q2: How is each Spotify playlist mapped to a Tidal playlist?

**Chosen: Auto-create Tidal playlist on first sync using Spotify playlist name as the Tidal name.**

A 1:1 mapping by name is the simplest approach. When a new Spotify playlist ID appears in
`SPOTIFY_EXTRA_PLAYLIST_IDS`, the system fetches its name from the Spotify API (one call), then
calls `createPlaylist(env, name)` on Tidal (same API already used in F-008). The resulting
`tidal_playlist_id` is stored in a new `playlist_configs` DB table (see schema section) keyed
by `spotify_playlist_id`.

This is the same pattern as the existing `ensurePlaylist` function in `playlist-writer.ts:24` —
that function does exactly this for the single-playlist case. The multi-playlist extension
generalises it to work from `playlist_configs` rather than `sync_state`.

Trade-off: if the Spotify playlist is renamed, the Tidal playlist name does not auto-update
(open question Q7). If the Tidal playlist is manually deleted, it is recreated on next sync
(same behaviour as today).

### Q3: Schema impact — does `matches` need a join table?

**Chosen: No. `matches` remains playlist-agnostic. Add a `playlist_membership` join table.**

`matches` currently answers "does track X have a Tidal counterpart?" That is still global —
if a track appears in both Liked Songs and a custom playlist, it has exactly one Tidal match.
I-001 (a `spotify_id` in exactly one of `matches` or `unmatched`) is preserved unchanged.

What changes: the write path needs to know which matched tracks have been written to which
Tidal playlist. Today this is implicit (global watermark). With multiple playlists it must be
explicit.

New table `playlist_membership` tracks which Spotify tracks belong to which Spotify playlist,
and whether the corresponding Tidal ID has been written to the Tidal playlist. This is the
minimal join table. See schema section for DDL.

Alternative rejected: adding `playlist_id` to `matches` as a column. This would break I-001
(a track can be in multiple playlists, requiring multiple match rows per `spotify_id`, requiring
the PK to change). It would also mean re-matching the same track once per playlist it appears
in, which wastes Tidal API subrequests. Matching is playlist-agnostic and must stay that way.

### Q4: Sync semantics — full mirror or incremental adds only?

**Chosen: Incremental adds only, same as today. Removals are out of scope for this exploration.**

The current model is append-only: when a track is liked/added to a Spotify playlist, it
eventually gets added to the Tidal playlist. Removing a track from Spotify does not remove it
from Tidal. This is the simplest model and the one Ovidiu has been living with since launch.

Full mirror (Tidal == Spotify at all times) requires: (a) detecting removals, (b) an API call
to remove each track from Tidal, (c) tracking removals in DB to avoid double-remove. This is a
separate, more complex feature. The parallel bidirectional-sync exploration should evaluate it
there — not here.

The `playlist_membership` table records `synced_at` (when the track was written to the Tidal
playlist). A NULL `synced_at` means "in Spotify playlist, not yet written to Tidal". There is
no "removed" state in this design.

### Q5: Per-playlist cursor state

**Chosen: Per-playlist `sync_state` keys, prefixed by Spotify playlist ID.**

The current `sync_state` table has `key TEXT PRIMARY KEY, value TEXT`. For Liked Songs, the
keys are `spotify_cursor`, `spotify_resume_url`, `spotify_sweep_max`, `tidal_playlist_id`,
`last_playlist_write_at`.

For each additional playlist, the same pattern applies with a prefix:
- `playlist:{spotifyPlaylistId}:cursor`
- `playlist:{spotifyPlaylistId}:resume_url`
- `playlist:{spotifyPlaylistId}:sweep_max`
- `playlist:{spotifyPlaylistId}:tidal_playlist_id`
- `playlist:{spotifyPlaylistId}:last_write_at`

No schema change required — the `sync_state` table already supports arbitrary key/value pairs.
The existing `readState`/`writeState`/`buildCursorQuery` helpers in `src/db/sync_state.ts` work
unchanged. The Liked Songs keys remain as-is for backward compatibility.

This is the simplest approach. A dedicated `playlist_state` table would be cleaner for querying
but adds schema complexity. The KV approach is consistent with current patterns.

### Q6: Cron strategy — one run per tick or staggered?

**Chosen: Process all configured playlists within one cron tick, each with its own subrequest
budget slice.**

The current tick budget (F-015) is designed around one playlist:
- 1 page of Liked Songs = 1 subrequest
- ISRC batch = 5 subrequests (5 Tidal track lookups)
- Fuzzy batch = 5 subrequests (5 Tidal search calls)
- Playlist write = 1 subrequest (one batch of ≤20 tracks)
Total: ~13 subrequests per tick, well within the 50 cap.

With N playlists, each playlist needs: 1 fetch + (up to 5 ISRC + 5 fuzzy) + 1 write = ~12
subrequests. Two playlists: ~24. Three: ~36. Four: ~48. The matching stage is shared across
all playlists (tracks in the global match queue, regardless of which playlist they came from),
so ISRC + fuzzy budgets are not strictly per-playlist — they're global per tick.

The orchestrator loop becomes: for each playlist → fetch new tracks → (matching is global,
runs once) → write playlist. The subrequest ceiling of ~50 limits the viable number of playlists
per tick to about 3-4 before fetching alone exhausts the budget (4 playlists × 1 page each =
4 Spotify subrequests, plus matching subrequests, plus 4 Tidal writes = comfortably under 50).

If Ovidiu wants more playlists, the orchestrator can process them in round-robin across ticks
(maintain a `last_processed` timestamp per playlist, process the oldest-processed first).
This is F-018 scope if needed. For the initial design, all playlists in one tick.

### Q7: What happens to playlists-only-on-Spotify (no Tidal counterpart yet)?

**Chosen: Auto-create Tidal playlist on first sync of that Spotify playlist.**

When a new Spotify playlist ID appears in `SPOTIFY_EXTRA_PLAYLIST_IDS`, the `ensurePlaylist`
logic (generalised from `playlist-writer.ts:24`) fetches the Spotify playlist name and calls
`createPlaylist(env, name)` on Tidal. The `playlist_configs` row is inserted. From then on,
that playlist is treated the same as "Spotify Liked" — tracks flow in on subsequent ticks.

There is no "skip" option. Auto-create is the only sensible default for a single-tenant tool
where the operator controls the env var. If the operator adds a playlist ID, they want it synced.

### Q8: Liked Songs — keep using `/me/tracks` or unify via `/me/playlists`?

**Chosen: Keep Liked Songs on the `/me/tracks` path. Do not unify.**

Liked Songs (`/v1/me/tracks`) returns items with `added_at` at the item level, enabling the
cursor/high-water-mark approach (F-005). Regular playlists (`/v1/playlists/{id}/tracks`) also
have `added_at`, but the pagination model and virtual-playlist ID handling differ. More importantly,
F-005 is tested, running in production, and has no known bugs. Rewriting it to go through a
unified abstraction layer adds risk and test churn with no user-facing benefit. Liked Songs is
special-cased in `playlist_configs` with `spotify_playlist_id = '__liked__'` (a synthetic key)
or simply excluded from `playlist_configs` and handled by a separate branch in the orchestrator.

---

## 4. Recommended Simplest Design

### 4.1 New env vars

Add to `wrangler.toml` `[vars]` and `src/env.ts`:

```
SPOTIFY_EXTRA_PLAYLIST_IDS   — comma-separated Spotify playlist IDs (optional, default empty)
```

`TIDAL_PLAYLIST_TITLE` remains for the Liked Songs target. Each extra playlist gets its Tidal
name from the Spotify playlist name (fetched at first sync).

### 4.2 New DB table: `playlist_configs`

Tracks the N configured playlists plus the implicit Liked Songs entry. One row per configured
Spotify playlist.

```sql
CREATE TABLE IF NOT EXISTS playlist_configs (
    spotify_playlist_id   TEXT PRIMARY KEY,
    spotify_name          TEXT NOT NULL,
    tidal_playlist_id     TEXT,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_synced_at        TIMESTAMPTZ
);
```

- `spotify_playlist_id = '__liked__'` for Liked Songs (synthetic stable key).
- `tidal_playlist_id` is NULL until the Tidal playlist is created on first sync.
- `last_synced_at` is updated after each successful playlist write pass; used for round-robin
  scheduling if needed in the future.

### 4.3 New DB table: `playlist_membership`

Tracks which Spotify tracks are in which Spotify playlists, and whether the corresponding
Tidal track has been written to the Tidal playlist.

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
```

- A track in 3 playlists gets 3 rows (one per playlist).
- `synced_at IS NULL` means "in Spotify playlist, not yet written to Tidal playlist".
- The matching layer (ISRC/fuzzy) is upstream of this — it operates on `tracks` globally.
- The write pass for playlist P selects: `WHERE pm.spotify_playlist_id = P AND pm.synced_at IS NULL`
  joined to `matches` — gives only matched tracks not yet written to that Tidal playlist.

This replaces the global `last_playlist_write_at` watermark for extra playlists. Liked Songs can
continue to use its watermark approach (no migration required) OR migrate to `playlist_membership`
for uniformity. The simpler choice is: migrate Liked Songs to `playlist_membership` too, so the
write path is unified. This means a one-time backfill to populate `playlist_membership` rows for
already-synced tracks (synced_at = matched_at for tracks already in the Tidal "Spotify Liked"
playlist). The backfill can be a migration script; existing Tidal playlist contents are not
affected.

### 4.4 New feature: F-016 — Playlist discovery and config seeding

**File:** `src/providers/spotify/playlists.ts` (new)
**File:** `src/db/playlist_configs.ts` (new)

Responsibilities:
- `fetchSpotifyPlaylistName(env, playlistId): Promise<string>` — single GET to
  `https://api.spotify.com/v1/playlists/{id}?fields=name` using `spotifyFetch`.
- `seedPlaylistConfigs(env): Promise<void>` — reads `SPOTIFY_EXTRA_PLAYLIST_IDS`, upserts
  `playlist_configs` rows for any new IDs (fetches name from Spotify if absent).
- `ensurePlaylistConfigForLiked(env): Promise<void>` — upserts the `__liked__` row if absent
  (idempotent bootstrap).

Called by the orchestrator at the start of each run, before the fetch loop.

### 4.5 Modified feature: F-017 — Multi-playlist fetch

**File:** `src/providers/spotify/playlists.ts` — add `fetchPlaylistTracks(env, playlistId, maxPages)`

This is a near-copy of `fetchLikedSongs` (src/providers/spotify/liked.ts:111) but targets
`https://api.spotify.com/v1/playlists/{playlistId}/tracks?limit=50`. Key differences:
- Cursor keys are `playlist:{playlistId}:cursor`, `playlist:{playlistId}:resume_url`,
  `playlist:{playlistId}:sweep_max`.
- Persisted rows go to both `tracks` (same upsert, global) and `playlist_membership`
  (one row per track per playlist, `synced_at = NULL`).
- Same F-015 budget logic applies (maxPages cap, resume_url, sweep_max, I-005 atomicity).

`fetchLikedSongs` is modified to also write `playlist_membership` rows for `__liked__`.
Alternatively (simpler): keep `fetchLikedSongs` unchanged and do the membership write in the
orchestrator as a post-fetch step. The latter avoids touching F-005 tested code.

### 4.6 Modified feature: F-018 — Multi-playlist write

**File:** `src/sync/playlist-writer.ts` — generalise `writePlaylist`

Current signature: `writePlaylist(env): Promise<PlaylistWriteResult>`

New signature: `writePlaylist(env, spotifyPlaylistId: string, tidalPlaylistId: string): Promise<PlaylistWriteResult>`

The body changes:
- `selectMatchesNewerThan` is replaced by a new query
  `selectUnwrittenMatchesForPlaylist(sql, spotifyPlaylistId)` that joins `matches` to
  `playlist_membership` on `spotify_track_id` where `synced_at IS NULL`.
- After a successful Tidal write, `UPDATE playlist_membership SET synced_at = now()` for
  the written tracks (replaces the global watermark advance).
- `ensurePlaylist` is replaced by accepting `tidalPlaylistId` directly (looked up by caller
  from `playlist_configs`).

The orchestrator calls `writePlaylist` once per configured playlist.

### 4.7 Modified: F-009 orchestrator

**File:** `src/sync/orchestrator.ts`

`runSyncBody` becomes a loop:

```
1. seedPlaylistConfigs(env)               — upsert any new playlist_configs rows
2. fetchLikedSongs(env, likedPages)       — F-005 path, unchanged except membership write
3. for each extra playlist in SPOTIFY_EXTRA_PLAYLIST_IDS:
     fetchPlaylistTracks(env, id, pages)  — F-017
4. fetchPendingMatchQueue(env, isrcBatch) — global, unchanged
5. matchByIsrc(env, queue, runId)         — global, unchanged
6. matchByFuzzy(env, { limit, syncRunId }) — global, unchanged
7. for each playlist in playlist_configs:
     writePlaylist(env, spotifyId, tidalId) — F-018
8. updateRun(...)                          — unchanged
```

The subrequest budget now needs to account for N playlists. The orchestrator should enforce a
`MAX_PLAYLISTS_PER_RUN` limit (default 3, env-configurable) to prevent blowing the 50-cap.

### 4.8 Modified: `src/env.ts`

Add:
```typescript
SPOTIFY_EXTRA_PLAYLIST_IDS?: string;  // comma-separated Spotify playlist IDs
MAX_PLAYLISTS_PER_RUN?: string;       // integer cap, defaults to 3
```

### 4.9 Existing files NOT modified

- `src/db/matches.ts` — matching is playlist-agnostic, no changes
- `src/match/isrc.ts` — no changes
- `src/match/fuzzy.ts` — no changes
- `src/db/tracks.ts` — `fetchPendingMatchQueue` queries global `tracks`, no changes
- `src/providers/tidal/playlist.ts` — `createPlaylist`/`addTracksToPlaylist` already take
  a playlist ID parameter; no changes needed
- All auth, OAuth, JWT, and health routes — no changes
- `wrangler.toml` — adds `SPOTIFY_EXTRA_PLAYLIST_IDS` to `[vars]` (can be empty string)

---

## 5. Alternatives Considered

- **Unify Liked Songs with regular playlists via `/me/playlists`**: rejected — Liked Songs is
  virtual in the Spotify model, has a different API contract, and the existing F-005 tested
  implementation is stable. Abstraction cost exceeds benefit.

- **DB-managed playlist config table with API CRUD**: rejected for this phase — adds a full
  CRUD API surface (GET/POST/DELETE /playlists/config) for a single-tenant tool where the
  operator controls the deployment. Env var is sufficient. Revisit if the number of playlists
  exceeds ~5.

- **Add `playlist_id` to `matches` table**: rejected — breaks the playlist-agnostic match
  model and I-001 (one `spotify_id` per row). Would force re-matching the same track once per
  playlist, wasting Tidal API quota.

- **Global watermark generalised to per-playlist**: using `sync_state` keys like
  `last_playlist_write_at:{spotifyPlaylistId}` instead of `playlist_membership.synced_at`.
  Simpler schema change, but it makes the write pass a stateful scan rather than a row-level
  marker. If a write fails mid-batch, the watermark approach under-writes; the `synced_at`
  approach correctly marks only the written rows. `playlist_membership` is more correct.

- **Round-robin playlists across ticks**: process one playlist per tick, rotating, to stay
  within the subrequest cap for large playlist counts. Deferred to F-019 if needed; the initial
  design processes all playlists per tick with a cap.

- **Full mirror semantics (Tidal mirrors Spotify exactly, including removes)**: out of scope
  here; belongs in the bidirectional-sync exploration. Adds substantial complexity (remove
  detection, deletion API calls, membership tracking for removals).

---

## 6. Edge Case Handling

### 6.1 Songs only on Spotify (no Tidal match available)

These tracks land in `unmatched` after the ISRC and fuzzy stages fail — identical to today.
The `playlist_membership` row is written with `synced_at = NULL` immediately when the track
is fetched (the track IS in the Spotify playlist, membership is recorded). The `synced_at`
remains NULL until a match is found (via retry or manual override) and a subsequent playlist
write pass picks it up.

The write query `selectUnwrittenMatchesForPlaylist` joins `playlist_membership` to `matches`,
so tracks with no entry in `matches` are never written to Tidal — they sit in membership with
`synced_at = NULL` until matched. This is the correct propagation path: track appears in
Spotify playlist → membership row written → matching runs → eventually a `matches` row exists
→ next write pass picks it up → `synced_at` set.

No new mechanism required. The existing unmatched queue (F-012) continues to surface these
tracks for manual override. The manual match flow (POST /unmatched/:spotify_id/match) creates
a `matches` row; the next tick's write pass will find it via `playlist_membership`.

### 6.2 Songs only on Tidal (not in any Spotify playlist)

Out of scope for this exploration. This is the bidirectional-sync direction. The `playlist_membership`
table only tracks Spotify→Tidal membership. Tracks added directly to Tidal playlists have no
representation in this table and are untouched by this design.

The boundary: this design is unidirectional Spotify→Tidal. Any Tidal-only tracks that exist
in the Tidal target playlists are left alone.

### 6.3 Playlists only on Spotify (no Tidal counterpart yet)

Auto-created on first sync. When `seedPlaylistConfigs` encounters a new Spotify playlist ID
in `SPOTIFY_EXTRA_PLAYLIST_IDS`, it fetches the playlist name from Spotify, inserts a
`playlist_configs` row with `tidal_playlist_id = NULL`, then the write pass calls
`createPlaylist(env, spotifyName)` and stores the resulting ID back to `playlist_configs.tidal_playlist_id`.

If the Tidal playlist creation fails (network error, auth failure), the `playlist_configs` row
remains with `tidal_playlist_id = NULL`. On the next tick, the write pass retries creation.
Tracks continue to accumulate in `playlist_membership` with `synced_at = NULL` during this
window — they are written once the Tidal playlist exists.

### 6.4 Playlists only on Tidal (no Spotify counterpart)

Out of scope. Tidal playlists not referenced by `playlist_configs` are not touched.

### 6.5 Spotify playlist renamed

The `playlist_configs.spotify_name` is refreshed on each `seedPlaylistConfigs` call (the
Spotify name is fetched per-tick as a lightweight GET). If the name changes, `spotify_name`
is updated. Whether to also rename the Tidal playlist is an open question (see Open Questions).
The default in this design: do not rename the Tidal playlist. The Tidal playlist was created
with the Spotify name at the time of first sync; subsequent renames are not propagated.

### 6.6 Spotify playlist deleted (removed from env var)

If `SPOTIFY_EXTRA_PLAYLIST_IDS` no longer contains a playlist ID, `seedPlaylistConfigs` stops
upserting that row. The `playlist_configs` row and all `playlist_membership` rows remain in DB
(no cascade delete). The orchestrator only processes playlists present in the env var, so the
old playlist is simply ignored going forward. The Tidal playlist is not deleted.

This is the safe default. An explicit "remove playlist" operation (delete membership rows,
optionally delete Tidal playlist) would require an admin API endpoint — deferred.

### 6.7 Track is in multiple Spotify playlists

Handled naturally by `playlist_membership`. If track T is in Liked Songs and playlist P,
`playlist_membership` has two rows: `(__liked__, T, ...)` and `(P, T, ...)`. The `matches`
table still has one row for T (one Tidal counterpart). The write pass for Liked Songs writes
the Tidal ID to the Liked Songs Tidal playlist (sets `synced_at` on the `__liked__` row);
the write pass for P writes the same Tidal ID to P's Tidal playlist (sets `synced_at` on P's
row). The track ends up in both Tidal playlists, which is correct.

### 6.8 Workers Free subrequest budget with multiple playlists

Current budget per tick (1 playlist):
- 1 Spotify fetch (Liked Songs)
- ≤5 Tidal ISRC lookups
- ≤5 Tidal fuzzy searches
- 1 Tidal playlist write
Total: ~13 subrequests

With N extra playlists added:
- 1 Spotify fetch (Liked Songs) + N Spotify fetches (extra playlists) = N+1
- 1 Spotify name fetch per new playlist (first tick only) = 0 in steady state
- ≤5 ISRC + ≤5 fuzzy (global, shared — not multiplied by N)
- N+1 Tidal playlist writes
Total steady-state: (N+1) + 10 + (N+1) = 2N + 12

At N=3 (3 extra + Liked Songs = 4 total): 2(3) + 12 = 18 subrequests. Safe.
At N=19 (20 total): 2(19) + 12 = 50 subrequests. Right at the cap, no room for 429 retries.

Practical cap: `MAX_PLAYLISTS_PER_RUN = 3` (4 total including Liked Songs) = 18 subrequests,
leaving 32 for retries. This is conservative and can be tuned via env var.

---

## 7. Out of Scope

- **Tidal→Spotify sync direction** — belongs to the parallel bidirectional-sync exploration.
  This design is strictly unidirectional (Spotify is the source of truth for playlist contents).

- **Removing tracks from Tidal when removed from Spotify** — requires remove detection, a
  Tidal DELETE playlist item API call, and membership tombstoning. Not part of this exploration.

- **Multi-user support** — ADR-005 is unchanged. Single tenant.

- **API endpoints for managing playlist configs** (GET/POST/DELETE /playlists/config) —
  the env-var approach is sufficient for a single-tenant tool.

- **Syncing Spotify collaborative playlists or playlists owned by other users** — the
  `SPOTIFY_EXTRA_PLAYLIST_IDS` env var can include any playlist ID the user follows or owns.
  There is no ownership filter in this design (unlike the "all owned playlists" option A in Q1).
  This is intentional — the operator decides what goes in the env var.

- **Tidal playlist reordering** — the current write model appends tracks to the end of the
  playlist (omitting `meta.positionBefore` per the prod-verified behaviour in playlist.ts:22).
  Maintaining Spotify playlist order would require reading the current Tidal playlist order and
  computing insert positions. Not in scope.

- **Playlist cover image sync** — Tidal playlists get the default description only.

---

## 8. Schema Migration Sketch

Additive only. Existing tables and data are unchanged.

```sql
-- F-016: playlist config registry
CREATE TABLE IF NOT EXISTS playlist_configs (
    spotify_playlist_id   TEXT PRIMARY KEY,
    spotify_name          TEXT NOT NULL,
    tidal_playlist_id     TEXT,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_synced_at        TIMESTAMPTZ
);

-- Seed the Liked Songs synthetic entry (idempotent):
INSERT INTO playlist_configs (spotify_playlist_id, spotify_name)
VALUES ('__liked__', 'Spotify Liked')
ON CONFLICT (spotify_playlist_id) DO NOTHING;

-- F-017 / F-018: per-playlist track membership
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

-- Backfill: mark all currently-matched tracks as synced for __liked__
-- (they are already in the Tidal "Spotify Liked" playlist).
-- Run AFTER the above CREATE, BEFORE the first multi-playlist deploy.
INSERT INTO playlist_membership (spotify_playlist_id, spotify_track_id, added_at, synced_at)
SELECT '__liked__', t.spotify_id, t.spotify_added_at, m.matched_at
FROM tracks t
JOIN matches m ON m.spotify_id = t.spotify_id
WHERE NOT m.tidal_id_invalid
ON CONFLICT DO NOTHING;
```

No existing table is modified. The `sync_state` table continues to hold per-playlist cursor keys
(no DDL change needed — it's already a generic KV store). The global `last_playlist_write_at`
key in `sync_state` can be retained for backward compatibility during rollout, then ignored once
`playlist_membership.synced_at` is the authoritative source for `__liked__`.

---

## 9. Effort Estimate

| Feature | New files | Modified files | Est. LOC (net new) | Test LOC |
|---------|-----------|----------------|---------------------|----------|
| F-016: playlist discovery + DB seed | src/providers/spotify/playlists.ts, src/db/playlist_configs.ts, tests/providers/spotify/playlists.test.ts, tests/db/playlist_configs.test.ts | src/env.ts (2 vars) | ~200 | ~300 |
| F-017: multi-playlist fetch | src/providers/spotify/playlists.ts (extend), src/db/playlist_membership.ts (new), tests/db/playlist_membership.test.ts | src/providers/spotify/liked.ts (membership write), src/db/sync_state.ts (key helpers) | ~250 | ~350 |
| F-018: multi-playlist write | src/sync/playlist-writer.ts (generalise) | src/db/matches.ts (new query), tests/sync/playlist-writer.test.ts (extend) | ~150 | ~250 |
| F-009 orchestrator extension | — | src/sync/orchestrator.ts (loop), tests/sync/orchestrator.test.ts (extend) | ~100 | ~200 |
| Schema + migration | db/schema.sql | — | ~40 DDL | — |
| **Total** | **8 new** | **7 modified** | **~740** | **~1100** |

**Sprint estimate:** 1-2 sprints at current velocity. F-016 and the schema migration are
standalone and can ship first. F-017/F-018 depend on F-016. F-009 extension depends on all three.

The matching pipeline (F-006, F-007) is untouched — that is the largest leverage point of this
design. The existing 95%-coverage gate must be maintained on all touched files.

---

## 10. Open Questions for Ovidiu

1. **Liked Songs in `playlist_membership` or keep watermark?** Migrating Liked Songs to the
   new membership table unifies the write path (one code path, one query). It requires a
   one-time backfill (SQL sketch above) and retiring the global `last_playlist_write_at` key.
   The alternative — keep Liked Songs on the watermark, add membership table only for extras
   — means two divergent write paths. Which do you prefer: full unification (cleaner, migration
   required) or dual-path (zero migration risk, technical debt)?

2. **Should the Tidal playlist be renamed when the Spotify playlist is renamed?** Currently
   proposed: no auto-rename. Rationale: the Tidal playlist is a fixed artefact; renaming it
   requires a PATCH call to the Tidal API (which needs OAS-grounding before implementation).
   If you care about name parity, this is a small addition to `seedPlaylistConfigs`. Confirm
   either way.

3. **How many extra playlists do you actually want to sync?** The 50-subrequest cap allows
   ~19 playlists before the budget runs out in steady state. The practical limit with retry
   headroom is ~3 extras (4 total). If you want more, the round-robin approach (one playlist
   per tick, rotating) is needed. What's your target playlist count?

4. **Backfill strategy for existing matched tracks?** The SQL backfill above marks all currently-
   matched tracks as synced for `__liked__` (assuming they are already in the Tidal playlist).
   If any matched tracks are NOT in the Tidal playlist (e.g., due to a past failed write pass),
   setting `synced_at` prematurely means they won't be retried. Alternative: leave `synced_at =
   NULL` for all matched tracks and let the next run re-write them (Tidal's add-tracks endpoint
   is idempotent for already-present tracks based on observed production behaviour, though this
   was not formally tested). Which do you prefer?

5. **What is the priority of this feature relative to the Sprint 7 follow-up items?** The
   Sprint 7 follow-ups (F-012-R3/R4 candidates, F-012-R10/R11 fuzzy filter, F-013-R9 orphan
   ISRC, F-009 error attribution, HTTP route logging) are fixes to existing features with
   known spec gaps. Multi-playlist sync is a new capability. Should this proceed before those
   follow-ups are resolved, in parallel, or after?

---

## 11. Next Steps

**Recommendation: wait for the parallel bidirectional-sync exploration output before deciding.**

Here is why: the two explorations share the `playlist_membership` join table as a foundation.
The bidirectional-sync exploration will need a way to track which Tidal tracks are in which
Tidal playlists. If it proposes a different membership model, the two designs could conflict.
Reviewing them together before implementation prevents a schema merge problem.

If Ovidiu confirms that bidirectional sync is not planned for the near term (and the parallel
exploration is purely informational), then proceed to `/opsx:propose` for this design. The
recommended implementation order:

1. Schema migration + `playlist_configs` seed (additive DDL, safe to deploy independently)
2. F-016 (playlist discovery) — no orchestrator changes, standalone
3. F-017 (multi-playlist fetch) — depends on F-016
4. F-018 (multi-playlist write) — depends on F-016
5. F-009 orchestrator extension — depends on F-017 + F-018
6. Close Sprint 7 follow-ups in parallel with F-016 (they're independent)

Do not start implementation until Ovidiu answers Open Questions 1, 3, and 4 — they determine
schema DDL and backfill strategy, which must be decided before any code is written.
