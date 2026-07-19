# Proposal: playlist-copy

## Why

Portage today is a one-way pipe: Spotify Liked Songs (plus configured extra playlists)
into Tidal. There is no way to copy an arbitrary playlist on demand, and no way to move
anything from Tidal back to Spotify. The operator wants a one-shot "copy this playlist
to the other service" capability, driven from the UI, that works in both directions and
runs entirely within the Workers free tier — even if a large copy takes hours.

## What Changes

- New copy-job engine: one-shot, chunked, resumable copy of a single playlist
  Spotify→Tidal or Tidal→Spotify, persisted in Neon, processed incrementally by a new
  `*/5 * * * *` cron that no-ops in microseconds when no job is active.
- Destination modes: create a NEW playlist on the target service (same name), or APPEND
  to an existing owned playlist (tracks already present are skipped).
- Browse-own-playlists endpoints for both providers so the UI can offer source and
  append-destination pickers.
- Spotify gains a write path (create playlist, add items) and a catalog-search path
  (ISRC-first, fuzzy fallback) — both new; the Spotify OAuth scope set grows from
  `user-library-read` to include `playlist-read-private` and `playlist-modify-private`.
  **Operator action: one-time Spotify re-consent after deploy.**
- Tidal→Spotify matching reuses the existing provider-agnostic scoring weights
  (`src/match/score.ts`); unmatched copy items get direction-aware manual match/skip
  endpoints (state lives in the copy job's own tables, not the Spotify-keyed
  `unmatched` table).
- Bug fix folded in (load-bearing for this feature): the Tidal playlist-items paginator
  reads a cursor field that does not exist in the OAS (`meta.cursor` instead of
  `links.meta.nextCursor`), which would loop forever on multi-page playlists. No
  current production caller; the copy engine becomes the first real one.
- ntfy notification when a copy job reaches a terminal state.
- The existing sync pipeline is untouched: same crons, same tables, same behavior.

## Capabilities

### New Capabilities

- `playlist-browse`: list the authenticated operator's own playlists on Spotify and
  Tidal (id, name, track count) for source/destination pickers.
- `playlist-copy`: copy-job lifecycle — create/list/inspect/cancel jobs, chunked
  free-tier execution model, per-track match states, append-mode dedup, and
  direction-aware manual match/skip resolution for unmatched items.
- `spotify-playlist-write`: Spotify playlist creation and item addition, including the
  expanded OAuth scope set and re-consent flow.
- `spotify-catalog-search`: Spotify track lookup by ISRC with fuzzy text-search
  fallback, for the Tidal→Spotify direction.

### Modified Capabilities

- `sync-notifications`: add a notification requirement for copy-job terminal states
  (complete / complete-with-unmatched / failed / cancelled).

## Impact

- **Worker (this repo, F-030)**: new `copy_jobs` + `copy_job_tracks` tables;
  new routes under `/api/copy/*` (CF Access-protected, no skip-list changes);
  `wrangler.toml` gains one cron schedule; `scheduled.ts` dispatches on
  `controller.cron`; Spotify oauth scope literal centralized; Tidal playlist paginator
  fixed (test mocks corrected to the OAS response shape).
- **UI (portage-ui, F-031)**: new Copy page (source picker, destination picker,
  progress, manual resolution) — separate OpenSpec change in that repo, written
  against the API contract defined in this change's design.md.
- **Operator**: one-time Spotify re-auth; no Tidal re-auth (listing own playlists needs
  only the already-granted `playlists.read` scope).
- **Free-tier budget**: +288 cron invocations/day (0.3% of the 100k request quota);
  each copy chunk stays ≤10 ms CPU and well under 50 subrequests.
- **Disclosed limitation**: playlist browsing lists *owned* playlists only; followed
  playlists would require Tidal `collection.read` (re-auth) and are out of scope.
