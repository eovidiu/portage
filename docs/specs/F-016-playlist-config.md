# F-016: Playlist config registry

## Summary

Foundation for multi-playlist sync. Introduces a `playlist_configs` table that
records the set of Spotify playlists this deployment syncs into Tidal: the
synthetic `__liked__` row representing Liked Songs, plus zero or more "extras"
configured via the `SPOTIFY_EXTRA_PLAYLIST_IDS` env var. F-016 owns the
registry, the Spotify name-fetch helper, and the seeder that runs at the top
of every orchestrator invocation. F-016 does not yet wire the orchestrator
loop or perform any fetch/write — that's F-017/F-018/F-016b.

## Linked tests

[T-016](T-016-playlist-config.md)

## Dependencies

- F-002 (Spotify OAuth — `spotifyFetch` for the playlist name lookup)
- Neon database connectivity (for the new `playlist_configs` table)

## Behavioural specification

### Bootstrap: Liked Songs config row

- **Given** the `playlist_configs` table exists and is empty
- **When** `seedPlaylistConfigs(env)` is called for the first time
- **Then** a row is inserted with `spotify_playlist_id = '__liked__'`,
  `spotify_name = 'Spotify Liked'`, `tidal_playlist_id = NULL`,
  `created_at = now()`, `last_synced_at = NULL`
- **And** subsequent seeder invocations leave the row unchanged (idempotent)

### Seeding extras from env

- **Given** `env.SPOTIFY_EXTRA_PLAYLIST_IDS = "abc123,def456"` and Spotify
  returns `{name: "Liked Workout"}` for `abc123` and `{name: "Roadtrip"}` for
  `def456`
- **When** `seedPlaylistConfigs(env)` runs
- **Then** the table contains three rows: `__liked__`, `abc123` (name
  "Liked Workout"), and `def456` (name "Roadtrip")
- **And** each Spotify playlist name fetch is exactly one
  `GET /v1/playlists/{id}?fields=name` subrequest

### Empty env var

- **Given** `env.SPOTIFY_EXTRA_PLAYLIST_IDS` is undefined or `""`
- **When** the seeder runs
- **Then** only the `__liked__` row is present (or persists from a prior run)
- **And** no Spotify subrequests are made

### Refreshing renamed extras

- **Given** an existing `playlist_configs` row for `abc123` with
  `spotify_name = "Old Name"` and `env.SPOTIFY_EXTRA_PLAYLIST_IDS = "abc123"`
- **When** Spotify now returns `{name: "New Name"}` for `abc123`
- **Then** the seeder UPDATEs `spotify_name = "New Name"` for that row
- **And** `tidal_playlist_id` is preserved (the Tidal side does NOT auto-rename
  per Q-rename — see Decisions)
- **And** `created_at` is preserved

### Spotify name fetch failure

- **Given** Spotify returns 404 for an extra playlist ID (e.g., the operator
  put a wrong ID in the env var)
- **When** the seeder processes that ID
- **Then** the seeder logs a structured error with `event: "playlist_name_fetch_failed"`,
  `spotify_playlist_id`, `status: 404`
- **And** the seeder DOES NOT insert or update the row for that ID
- **And** the seeder continues with remaining IDs (one bad ID does not block
  others)

### Empty Spotify name fallback

- **Given** Spotify returns `{name: ""}` (rare but possible)
- **When** the seeder upserts the row
- **Then** `spotify_name = "Spotify Playlist {id}"` (synthetic fallback)

## Detailed requirements

| ID | Requirement |
|---|---|
| F-016-R1 | A new table `playlist_configs(spotify_playlist_id TEXT PK, spotify_name TEXT NOT NULL, tidal_playlist_id TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), last_synced_at TIMESTAMPTZ)` MUST exist. |
| F-016-R2 | The synthetic `__liked__` row MUST be present after the first seeder invocation, with `spotify_name = 'Spotify Liked'`. The string `__liked__` is the stable synthetic key for Liked Songs and MUST NOT be used for any real Spotify playlist ID. |
| F-016-R3 | `env.SPOTIFY_EXTRA_PLAYLIST_IDS` MUST be parsed as a comma-separated list. Whitespace around individual IDs MUST be trimmed. Empty entries (e.g., trailing commas) MUST be ignored. |
| F-016-R4 | For each non-`__liked__` ID in the env var, the seeder MUST fetch the playlist name via `GET https://api.spotify.com/v1/playlists/{id}?fields=name` using `spotifyFetch` (which handles 401-coalesced refresh per F-002-R11). |
| F-016-R5 | The seeder MUST upsert (`INSERT ... ON CONFLICT (spotify_playlist_id) DO UPDATE`) the row with the fetched name. `tidal_playlist_id` and `created_at` MUST NOT be touched on update. |
| F-016-R6 | If Spotify returns a non-OK response for an extra ID's name fetch, the seeder MUST emit a structured log line and skip that ID without aborting the seeder. The 401-retry path is delegated to `spotifyFetch`. |
| F-016-R7 | If the Spotify response body has `name === ""` or missing `name`, the upserted name MUST fall back to `Spotify Playlist {id}`. |
| F-016-R8 | The Spotify name lookup constant URL `https://api.spotify.com/v1/playlists/{id}?fields=name` MUST carry a `Verified:` marker citing the canonical Spotify Web API reference (per the External-API-grounding cross-cutting rule). |
| F-016-R9 | A new env var `MAX_PLAYLISTS_PER_RUN` MUST exist (string, optional). The reader MUST follow the F-015 `readBudget` pattern: `undefined`/`""`/non-numeric/non-positive falls back to default `3`. F-016 itself does not consume this var; F-016b enforces the cap. |
| F-016-R10 | The DB layer (`src/db/playlist_configs.ts`) MUST expose `upsertPlaylistConfig(sql, row)`, `listPlaylistConfigs(sql)`, `getPlaylistConfig(sql, id)`, `setTidalPlaylistId(sql, id, tidalId)`, `markSynced(sql, id, at)`. All MUST use parameterised neon SQL. |
| F-016-R11 | The seeder MUST be safely concurrent: two parallel seeder invocations on the same DB MUST NOT produce duplicate rows or corrupt state. The DB-side ON CONFLICT clause is the enforcer; no advisory lock needed. |

## Data effects

- Adds one table: `playlist_configs`.
- Adds one synthetic row (`__liked__`) on first seeder invocation.
- Per-run cost: 0 subrequests (steady state, no env-var changes); N subrequests
  for N freshly-added or newly-renamed extras.
- No other tables are affected.

## Schema migration (additive)

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

The migration is purely additive. The `__liked__` seed runs in the same DDL
batch so a fresh deployment never sees an empty registry.

## Failure modes

| Mode | Cause | Recovery |
|---|---|---|
| `playlist_name_fetch_failed` | Spotify 4xx/5xx for a specific extra ID | Operator inspects the ID; corrects env var if typo; seeder retries on next tick |
| `playlist_seeder_db_error` | Neon connectivity failure during upsert | Standard retry on next tick; orchestrator surfaces as transient |

## Decisions

- **Q-rename: NO auto-rename of the Tidal playlist when the Spotify playlist
  is renamed.** The Tidal playlist is treated as a fixed artefact created at
  first sync. Renaming would require a Tidal v2 PATCH call requiring its own
  OAS-grounding pass; deferred. `playlist_configs.spotify_name` is refreshed
  on every seeder run, but no Tidal-side propagation occurs.
- **Q-collab: NO `owner.id` filter on the env var.** The operator-controlled
  env var accepts any playlist ID Spotify will return tracks for (owned,
  collab, followed). Single-tenant tool; the env var is the policy boundary.
- **Q-empty-name: fall back to `Spotify Playlist {id}` if Spotify returns an
  empty name.** Deterministic synthetic name, never null.

## Acceptance criteria

- All tests in T-016 pass.
- The `playlist_configs` table is present in `db/schema.sql` and the
  schema-drift hook (Stage 4) accepts the file.
- The `Verified:` marker above the `/v1/playlists/{id}?fields=name` URL
  satisfies the external-API-grounding hook (Stage 5).
- Coverage on touched files (`src/db/playlist_configs.ts`,
  `src/providers/spotify/playlists.ts`, `src/sync/playlist-config-seeder.ts`)
  meets the project's 95% gate.
- The orchestrator is unchanged; the seeder is wired by F-016b.
