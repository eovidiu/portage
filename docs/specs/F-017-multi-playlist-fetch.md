# F-017: Multi-playlist Spotify fetch + membership

## Summary

Phase B of multi-playlist sync. Adds `fetchPlaylistTracks(env, spotifyPlaylistId,
maxPages)` to the Spotify provider, mirroring F-005's bounded mid-sweep design
but for `/v1/playlists/{id}/tracks`. Introduces the `playlist_membership`
join table that records which Spotify tracks belong to which Spotify playlists,
and whether the corresponding Tidal counterpart has been written to the Tidal
playlist. Per-playlist cursor state lives in `sync_state` under prefixed keys
(`playlist:{id}:cursor`, `playlist:{id}:resume_url`, `playlist:{id}:sweep_max`)
to keep Liked Songs' existing keys untouched.

F-017 does not yet wire the orchestrator loop. F-016b is the consumer.

## Linked tests

[T-017](T-017-multi-playlist-fetch.md)

## Dependencies

- F-002 (Spotify OAuth and `spotifyFetch`)
- F-004 (token decryption)
- F-005 (cursor + mid-sweep design pattern; F-017 mirrors its invariants)
- F-016 (`playlist_configs` table — F-017's `playlist_membership` has FK to it)

## Behavioural specification

### Initial fetch of an extra playlist (cold start)

- **Given** a `playlist_configs` row for `spotify_playlist_id = 'abc123'` exists,
  no `sync_state` rows exist for any of `playlist:abc123:cursor`,
  `playlist:abc123:resume_url`, `playlist:abc123:sweep_max`
- **When** `fetchPlaylistTracks(env, 'abc123', maxPages = 1)` runs
- **Then** the system reads the cold-start cursor `'1970-01-01T00:00:00Z'`
- **And** fetches `GET /v1/playlists/abc123/tracks?limit=50` (one page,
  consuming exactly one Spotify subrequest)
- **And** persists every non-skipped track to `tracks`
- **And** writes a `playlist_membership` row for each persisted track with
  `synced_at = NULL`
- **And** writes `playlist:abc123:cursor`, `playlist:abc123:resume_url`,
  `playlist:abc123:sweep_max` per the F-005 mid-sweep state machine

### Incremental fetch (subsequent runs)

- **Given** `sync_state.playlist:abc123:cursor = T`
- **When** `fetchPlaylistTracks(env, 'abc123', maxPages = N)` runs
- **Then** it paginates the playlist starting from the most recent backwards
- **And** stops paginating early once a track with `added_at <= T - 60s` is seen
- **And** persists only tracks with `added_at > T - 60s` to `tracks`
- **And** writes `playlist_membership` rows for those tracks with
  `synced_at = NULL`

### Membership atomicity (extended I-005)

- **Given** a fetch invocation persists pages P1..Pk
- **When** the last fetched page Pk's transaction is constructed
- **Then** the transaction MUST include, atomically:
  - the `tracks` upserts for Pk
  - one `playlist_membership` upsert per non-skipped track in Pk (across all
    pages of this invocation OR Pk only — see R6)
  - the three `sync_state` writes (cursor, resume_url, sweep_max)
- **And** if any of the above fails, none is persisted

### Skip non-track items

- **Given** a playlist item where `track` is `null` (track removed from
  Spotify catalog), or `track.is_local === true`, or `track.type !== 'track'`
- **When** the persist helper sees it
- **Then** the item is logged as `skipped_non_track` and NOT inserted into
  `tracks` or `playlist_membership`

### Voluntary mid-sweep stop

- **Given** `maxPages = 1` and the playlist has more than 50 new tracks
- **When** the fetch completes its single page
- **Then** the cursor MUST NOT advance
- **And** `playlist:abc123:resume_url` MUST be set to `page.next`
- **And** `playlist:abc123:sweep_max` MUST be set to the run's max `added_at`
- **And** `morePagesPending` in the result MUST be `true`

### Sweep completion

- **Given** the fetch hits either `page.next === null` or the cursor cutoff
- **When** the last page is persisted
- **Then** `playlist:abc123:cursor` MUST advance to
  `max(sweep_max, this_run_max)`
- **And** `playlist:abc123:resume_url` MUST be cleared
- **And** `playlist:abc123:sweep_max` MUST be cleared

### Liked Songs membership write (orchestrator post-fetch hook)

- **Given** `fetchLikedSongs` has just run and inserted N tracks
- **When** the orchestrator's post-fetch step runs
- **Then** N `playlist_membership` rows for `spotify_playlist_id = '__liked__'`
  MUST exist with `synced_at = NULL`
- **Note:** the membership writes for `__liked__` happen in the orchestrator,
  not inside `fetchLikedSongs`. This decision keeps F-005's existing tested
  code unchanged.

## Detailed requirements

| ID | Requirement |
|---|---|
| F-017-R1 | The system MUST expose `fetchPlaylistTracks(env, spotifyPlaylistId, maxPages = Number.POSITIVE_INFINITY): Promise<FetchResult>` from `src/providers/spotify/playlists.ts`. Signature MUST be backward-compatible with `fetchLikedSongs` so the orchestrator (F-016b) consumes both symmetrically. |
| F-017-R2 | The fetch URL MUST be `https://api.spotify.com/v1/playlists/{spotify_playlist_id}/tracks?limit=50`. Pagination follows the `next` URL Spotify returns. |
| F-017-R3 | The URL constant MUST carry a `Verified:` marker on the immediately-preceding non-blank line, citing the canonical Spotify Web API reference. |
| F-017-R4 | Auth handling delegates to `spotifyFetch` (F-002-R11 — coalesced 401 refresh + retry). |
| F-017-R5 | Per-playlist cursor state lives in `sync_state` under three prefixed keys: `playlist:{id}:cursor`, `playlist:{id}:resume_url`, `playlist:{id}:sweep_max`. The synthetic `__liked__` playlist continues to use the legacy flat keys (`spotify_cursor`, `spotify_resume_url`, `spotify_sweep_max`) for backward compatibility — F-005 is unmodified. |
| F-017-R6 | All `playlist_membership` writes for an invocation MUST land in the same transaction as the cursor advance — atomic per the extended I-005. The implementation MAY batch all membership writes into the last page's transaction (matching F-005's track-upsert pattern), or distribute them across per-page transactions; the public contract is "no partial-state outcome where membership disagrees with cursor." |
| F-017-R7 | Items with `track === null`, `track.is_local === true`, or `track.type !== 'track'` MUST be skipped (no `tracks` insert, no `playlist_membership` insert). |
| F-017-R8 | `playlist_membership` upsert MUST be `ON CONFLICT (spotify_playlist_id, spotify_track_id) DO NOTHING`. The composite PK guarantees idempotency: the same track in the same playlist gets exactly one row. `added_at` reflects the FIRST observation; subsequent runs preserve it. |
| F-017-R9 | `playlist_membership.synced_at` MUST be NULL on insert. F-018's write pass is the only path that flips it to a timestamp. |
| F-017-R10 | F-005's mid-sweep behaviour (R12-R16) MUST be preserved verbatim for `fetchPlaylistTracks`, with cursor keys substituted per R5. The `Number.POSITIVE_INFINITY` default for `maxPages` preserves unbounded behaviour for tests that don't specify a budget. |
| F-017-R11 | Spotify HTTP 429 MUST be handled with `Retry-After`-driven sleep + one retry (mirrors F-005-R7); a second 429 fails the run. |
| F-017-R12 | The fetch module MUST emit one log line per page with `event: "fetch_page"`, `playlist_id`, `page_index`, `items_seen`, `items_persisted`, `items_skipped`. |
| F-017-R13 | The orchestrator's post-fetch hook (introduced by F-016b but specified here for clarity) MUST upsert `playlist_membership` rows for `__liked__` after `fetchLikedSongs` completes. The upsert reads from the `tracks` rows just inserted via the cursor delta (newest tracks added since the last sync). This keeps F-005 untouched. |
| F-017-R14 | The DB layer (`src/db/playlist_membership.ts`) MUST expose: `upsertMembership(sql, row)` (composable, single row), `buildMembershipUpsertQueries(txSql, rows)` (sync-callback array form for transactions), `markMembershipSynced(sql, playlistId, trackIds, syncedAt)` (used by F-018), `selectUnsyncedMatchesForPlaylist(sql, playlistId)` (used by F-018, joins membership × matches WHERE synced_at IS NULL AND NOT tidal_id_invalid). All MUST use parameterised neon SQL. |

## Database schema

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

## Q4 backfill (one-shot, applied alongside the migration)

```sql
INSERT INTO playlist_membership (spotify_playlist_id, spotify_track_id, added_at, synced_at)
SELECT '__liked__', t.spotify_id, t.spotify_added_at, m.matched_at
FROM tracks t
JOIN matches m ON m.spotify_id = t.spotify_id
WHERE NOT m.tidal_id_invalid
ON CONFLICT DO NOTHING;
```

The backfill assumes currently-matched tracks are already in the Tidal "Spotify
Liked" playlist (per F-008's prod behaviour and the production observation that
the sync has been running 2x daily since the F-015 deploy). F-008's add-tracks
endpoint is idempotent on already-present items, so even an over-eager backfill
self-corrects on the next sync.

## Data effects

- Inserts/upserts rows into `playlist_membership` (one per Spotify track per
  Spotify playlist).
- Inserts/upserts rows into `tracks` (one per non-skipped track, idempotent per
  F-005-R8).
- Upserts three `sync_state` keys per playlist: `playlist:{id}:cursor`,
  `playlist:{id}:resume_url`, `playlist:{id}:sweep_max`.
- The Q4 backfill seeds existing matched Liked Songs as `synced_at = matched_at`
  for the `__liked__` playlist.

## Subrequest budget

- 1 Spotify subrequest per page fetched (capped by `maxPages`).
- 0 Tidal subrequests — F-017 is read-only against Spotify and write-only against
  the database. Tidal write happens in F-018.
- Default `maxPages = 1` (set by orchestrator wiring in F-016b) keeps each
  invocation at 1 subrequest per playlist.

## Failure modes

| Mode | Cause | Recovery |
|---|---|---|
| HTTP 401 from Spotify | Token expired and not refreshed in time | `spotifyFetch` retries once after refresh (F-002-R11) |
| HTTP 429 from Spotify | Rate limit | Honour `Retry-After`; one retry; second 429 aborts (R11) |
| HTTP 404 from Spotify | Playlist deleted or no longer accessible | Bubble error; orchestrator (F-016b) classifies via F-009 R15 (`fetch_failed`) |
| HTTP 5xx from Spotify | Transient outage | Bubble; F-009 R15 classifies as `spotify_transient` |
| `track === null` in items | Track removed from Spotify catalog | Skip; logged as `skipped_non_track` |
| FK violation on insert | playlist_configs row deleted between read and write | Should not occur — orchestrator seeds configs before fetching. If it occurs, transaction aborts, no partial state. |

## Acceptance criteria

- All tests in T-017 pass.
- `db/schema.sql` contains the `playlist_membership` DDL + 2 indices; the
  schema-drift hook (Stage 4) accepts the file.
- The `Verified:` marker on the new URL constant satisfies the marker hook
  (Stage 5).
- Coverage on touched files (`src/db/playlist_membership.ts`,
  `src/providers/spotify/playlists.ts`, `src/db/sync_state.ts`) meets the
  project's 95% gate.
- `fetchLikedSongs` in `src/providers/spotify/liked.ts` is UNMODIFIED. The
  orchestrator post-fetch hook handles `__liked__` membership writes in F-016b.
- Live Neon migration (CREATE TABLE + indices + Q4 backfill INSERT) applied
  with operator present, verified by SELECT count after.
