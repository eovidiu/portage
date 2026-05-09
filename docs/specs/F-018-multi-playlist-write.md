# F-018: Multi-playlist Tidal write

## Summary

Phase B of multi-playlist sync. Generalizes `writePlaylist` from "the single
hardcoded Tidal playlist" to "a specified Spotify→Tidal playlist pair". When
called for a Spotify playlist whose Tidal counterpart hasn't been created yet,
F-018 creates the Tidal playlist (using `playlist_configs.spotify_name` as the
title) and persists the new Tidal id back to `playlist_configs.tidal_playlist_id`.
The write pass selects rows from `playlist_membership` (joined to `matches`)
where `synced_at IS NULL AND NOT tidal_id_invalid`, batches the resulting
Tidal track ids via the existing F-008 add-tracks flow, and on success flips
`playlist_membership.synced_at` to `now()` for the written rows. The legacy
global `last_playlist_write_at` watermark is no longer authoritative.

Per Q1 (decisions locked 2026-05-07), Liked Songs uses the same code path as
extras — there is no special-case branch for `__liked__` inside `writePlaylist`.

## Linked tests

[T-018](T-018-multi-playlist-write.md)

## Dependencies

- F-008 (Tidal playlist write primitives — `createPlaylist`, `getPlaylist`,
  `addTracksToPlaylist`; F-018 reuses these unchanged)
- F-016 (`playlist_configs` table — F-018 reads `tidal_playlist_id` and writes
  it back via `setTidalPlaylistId` on first sync of a new playlist)
- F-017 (`playlist_membership` table — F-018 reads via
  `selectUnsyncedMatchesForPlaylist` and writes via `markMembershipSynced`)

## Behavioural specification

### Existing playlist (Tidal id known)

- **Given** `playlist_configs` row for `spotify_playlist_id = '__liked__'`
  has `tidal_playlist_id = 'f10ce98a-...'` and the Tidal playlist exists
- **When** the orchestrator calls
  `writePlaylist(env, '__liked__', 'f10ce98a-...')`
- **Then** F-018 calls `selectUnsyncedMatchesForPlaylist(sql, '__liked__')` to
  read the unsynced matches
- **And** if the resulting array is empty, returns
  `{ playlistId: 'f10ce98a-...', added: 0, skippedDuplicates: 0, invalidIds: [], errors: 0 }`
  without calling Tidal
- **And** otherwise calls `addTracksToPlaylist(env, 'f10ce98a-...', tidalIds)`
- **And** on success, calls
  `markMembershipSynced(sql, '__liked__', writtenSpotifyIds, now())`

### New playlist (Tidal id null — auto-create)

- **Given** `playlist_configs` row for `spotify_playlist_id = 'abc123'` has
  `tidal_playlist_id = NULL` and `spotify_name = 'Workout'`
- **When** the orchestrator calls
  `writePlaylist(env, 'abc123', null)`
- **Then** F-018 calls `createPlaylist(env, 'Workout')` to create the Tidal
  playlist
- **And** persists the new Tidal id via
  `setTidalPlaylistId(sql, 'abc123', newTidalId)`
- **And** logs `{ event: "playlist_created_for_config", spotify_playlist_id: "abc123", tidal_playlist_id: <newId>, name: "Workout" }`
- **And** then proceeds with the normal write pass against the freshly created
  Tidal playlist id

### Invalid Tidal id (catalog removal)

- **Given** the existing F-008 invalid-id flow returns one or more
  `tidal_id_invalid` ids in `result.invalidIds`
- **When** F-018 receives the result
- **Then** for each invalid Tidal id, F-018 calls `flagInvalidTidalId(sql, tidalId)`
  and `requeueForInvalidTidalId(sql, spotifyId)` (existing F-008 paths)
- **And** does NOT call `markMembershipSynced` for those rows — they remain
  `synced_at IS NULL` and will be retried after the next ISRC/fuzzy match
  attempt

### Tidal write returns 0 added (network glitch / partial)

- **Given** `addTracksToPlaylist` returns
  `{ added: 0, errors: N, invalidIds: [] }` (e.g., all batches failed)
- **When** F-018 processes the result
- **Then** F-018 does NOT mark membership synced (the rows weren't actually
  written)
- **And** the per-batch error count is propagated to the result
- **And** the run continues — orchestrator handles overall partial-vs-failed
  classification per F-009

### Tidal playlist gone (manually deleted by operator)

- **Given** `playlist_configs.tidal_playlist_id` is set but `getPlaylist(env, id)`
  returns null (Tidal 404)
- **When** F-018 detects the missing playlist via `getPlaylist`
- **Then** F-018 calls `createPlaylist(env, spotify_name)` to recreate it
- **And** persists the new id via `setTidalPlaylistId`
- **And** logs `{ event: "playlist_recreated", spotify_playlist_id, previous_id, new_id }`
- **And** proceeds with the write pass

### Liked Songs write (Q1=unify path)

- **Given** F-018 is called for `'__liked__'` after the prep PR's bridge
  migration has populated `playlist_configs.__liked__.tidal_playlist_id` with
  the existing Tidal playlist id `f10ce98a-...`
- **When** the write pass runs
- **Then** the existing Tidal "Spotify Liked" playlist receives any new tracks
  not yet in its `playlist_membership` rows with `synced_at IS NULL`
- **And** `synced_at` is flipped for the written rows
- **And** the legacy `sync_state.last_playlist_write_at` key is NOT read or
  written by F-018 (it stays in the table for historical reference)

## Detailed requirements

| ID | Requirement |
|---|---|
| F-018-R1 | The system MUST expose `writePlaylist(env: Env, spotifyPlaylistId: string = '__liked__', tidalPlaylistId: string \| null = null): Promise<PlaylistWriteResult>` from `src/sync/playlist-writer.ts`. The default values preserve the existing single-argument call site for the prep PR transition window. |
| F-018-R2 | F-018 MUST read the `tidal_playlist_id` from `playlist_configs` if the caller passes `null`. When the field is also null in the DB, F-018 MUST call `createPlaylist(env, spotify_name)` to create the Tidal playlist, and MUST persist the new id to `playlist_configs.tidal_playlist_id` via `setTidalPlaylistId`. The Spotify name comes from `playlist_configs.spotify_name`. |
| F-018-R3 | F-018 MUST select unsynced matches via `selectUnsyncedMatchesForPlaylist(sql, spotifyPlaylistId)` from `src/db/playlist_membership.ts`. The query joins `playlist_membership` × `matches` on `spotify_id` filtering `synced_at IS NULL AND NOT tidal_id_invalid`. |
| F-018-R4 | F-018 MUST call `addTracksToPlaylist(env, tidalPlaylistId, tidalIds)` (existing F-008 primitive, unchanged). |
| F-018-R5 | On a successful write (any non-zero `added` count or even zero `added` with no errors and no invalidIds), F-018 MUST call `markMembershipSynced(sql, spotifyPlaylistId, writtenSpotifyIds, now())` for the spotify track ids whose Tidal counterparts were successfully written. Tracks with invalid Tidal ids MUST NOT be marked synced. |
| F-018-R6 | F-018 MUST detect a missing Tidal playlist (returned by `getPlaylist(env, id)` as null) and recreate it via `createPlaylist`, persist the new id via `setTidalPlaylistId`, and proceed. The recreation event MUST be logged with `event: "playlist_recreated"`, `spotify_playlist_id`, `previous_id`, `new_id`. |
| F-018-R7 | F-018 MUST emit a structured log line on every invocation: `{ event: "playlist_write_completed", spotify_playlist_id, tidal_playlist_id, added, skipped_duplicates, invalid_ids: number, errors }`. The orchestrator (F-016b) consumes this for run summary logging. |
| F-018-R8 | The legacy `sync_state.last_playlist_write_at` key MUST NOT be read or written by F-018. The `playlist_membership.synced_at` per-row marker is the authoritative replacement. The legacy key remains in the table but is dead. |
| F-018-R9 | F-018 MUST handle invalid Tidal ids per the existing F-008 flow: `flagInvalidTidalId(sql, tidalId)` + `requeueForInvalidTidalId(sql, spotifyId)`. The corresponding `playlist_membership` row MUST NOT be marked synced — the row stays `synced_at IS NULL` so the next match attempt picks it up. |
| F-018-R10 | F-018 result shape (`PlaylistWriteResult`) MUST be backward-compatible: `playlistId, added, skippedDuplicates, invalidIds, errors`. `playlistId` is the Tidal id (the just-created or pre-existing). `skippedDuplicates` stays `0` (the membership marker handles dedupe; no client-side dedupe exists). |
| F-018-R11 | F-018 MUST NOT throw on transient Tidal errors. The existing `addTracksToPlaylist` returns errors and invalid-id arrays in its result; F-018 propagates them via `PlaylistWriteResult`. The orchestrator decides run-level outcome. |
| F-018-R12 | When `selectUnsyncedMatchesForPlaylist` returns an empty array, F-018 MUST short-circuit to a zero-write result without calling Tidal — preserves the existing F-008 behaviour and saves a subrequest. |

## Data effects

- Reads: `playlist_configs` (one row by spotify_playlist_id), `playlist_membership × matches` (the unsynced join).
- Writes: `playlist_configs.tidal_playlist_id` (only on auto-create or recreation), `playlist_membership.synced_at` (one row per successfully-written Tidal track), `matches.tidal_id_invalid` (existing F-008 path for invalid ids), `unmatched` (existing F-008 path for re-queue).
- Tidal subrequests per invocation: 0 if no unsynced rows; 1 createPlaylist (rare, only on first sync of a new playlist or when Tidal playlist gone); 1 getPlaylist (existence check, only when tidal id known); ceil(N/20) addTracksToPlaylist calls where N is the unsynced count, capped by N ≤ 20 in steady state.

## Failure modes

| Mode | Cause | Recovery |
|---|---|---|
| `playlist_recreated` | Tidal playlist manually deleted between syncs | Auto-recreate; logged; next run normal |
| `playlist_created_for_config` | First sync of a new extra playlist | Auto-create; logged; persisted to playlist_configs |
| `tidal_id_invalid` | Tidal track removed from catalog | Existing F-008 quarantine: flag match + requeue |
| `tidal_5xx` | Tidal outage | `addTracksToPlaylist` already retries on 429; 5xx aborts the batch and increments errors. Run continues; next cron retries. |

## Acceptance criteria

- All tests in T-018 pass.
- `writePlaylist(env)` (single-argument legacy call site) continues to work
  during the prep PR window and across the F-018 PR cycle. The default
  `spotifyPlaylistId = '__liked__'` and the bridged
  `playlist_configs.__liked__.tidal_playlist_id` produce identical observable
  behaviour to the pre-F-018 implementation.
- The `Verified:` markers on Tidal URL constants (existing F-008) are
  unchanged; F-018 introduces no new external URLs.
- Coverage on `src/sync/playlist-writer.ts` and `src/db/matches.ts` (touched)
  meets the project 95% statements gate.
- Live Neon migration (the bridge from `sync_state.tidal_playlist_id` to
  `playlist_configs.__liked__.tidal_playlist_id`) lands in the prep PR before
  F-018 itself ships, so the F-018 deploy never observes a null
  `tidal_playlist_id` for `__liked__`.
