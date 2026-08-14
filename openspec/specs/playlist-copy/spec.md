# playlist-copy Specification

## Purpose
One-shot bidirectional playlist copy between Spotify and Tidal: chunked copy-job engine on the */5 cron sharing the sync advisory lock, /api/copy/* HTTP API, and manual match/skip resolution for unmatched tracks. Created by archiving change playlist-copy.
## Requirements
### Requirement: Create copy job
The Worker SHALL expose `POST /api/copy/jobs` accepting
`{ source_provider, source_playlist_id, dest_mode, dest_playlist_id?, dest_name? }`
and creating a `copy_jobs` row with status `queued`. `dest_mode='new'` SHALL default
`dest_name` to the source playlist's name; `dest_mode='append'` SHALL require a
`dest_playlist_id` owned by the operator on the destination provider and SHALL
snapshot that playlist's current track ids into `dest_known_ids` for dedup. Only one
non-terminal job may exist at a time.

#### Scenario: New-playlist job created
- **WHEN** the operator posts a valid `dest_mode='new'` job and no active job exists
- **THEN** the response is 201 with `job_id` and the job row is `queued` with
  `dest_name` set to the source playlist name

#### Scenario: Append job snapshots destination
- **WHEN** the operator posts a valid `dest_mode='append'` job
- **THEN** the destination playlist's current track ids are persisted to
  `dest_known_ids` before the job is queued

#### Scenario: Second concurrent job rejected
- **WHEN** a non-terminal copy job already exists
- **THEN** the response is `409 { error: "job_already_active" }` and no row is created

#### Scenario: Oversized append target rejected
- **WHEN** the append destination reports more tracks than the configured snapshot cap
- **THEN** the response is 422 and no job is created

### Requirement: Chunked execution on a dedicated cron
A `*/5 * * * *` cron schedule SHALL drive `runCopyTick`. `scheduled.ts` SHALL
dispatch on `controller.cron`: the existing two schedules keep invoking `runSync`
unchanged. A tick SHALL read the active-job flag before any database access and, when the flag is
absent, SHALL return without performing **any** Neon query and without acquiring the lock — an idle
heartbeat SHALL cost zero database work, because Neon's free plan autosuspends only after five
minutes of inactivity and a query every five minutes holds the compute awake permanently. When the
flag is present the tick SHALL query `copy_jobs` for the authoritative answer; if that query finds
no non-terminal job the tick SHALL clear the stale flag before returning. A tick
SHALL acquire the same Postgres advisory lock as the sync engine and skip (not fail)
when it is held. Each tick SHALL advance exactly one phase step (fetch one source
page, or match one batch, or write one batch) within the documented budget
(`COPY_BATCH_ISRC`/`COPY_BATCH_FUZZY` env-tunable, defaults 2), persisting all state
before the tick ends. The fetch cursor SHALL only advance atomically with the
persistence of that page's rows.

#### Scenario: Idle tick performs no database work
- **WHEN** the copy cron fires and the active-job flag is absent
- **THEN** the tick performs zero Neon queries, does not acquire the lock, and exits

#### Scenario: Stale flag is self-healed
- **WHEN** the copy cron fires with the flag present but no `copy_jobs` row is non-terminal
- **THEN** the tick clears the flag and exits, so subsequent idle ticks perform no database work

#### Scenario: Lock contention skips the tick
- **WHEN** the copy cron fires while a sync run holds the advisory lock
- **THEN** the tick exits without processing and the job resumes on a later tick

#### Scenario: Job progresses across ticks
- **WHEN** an active job exists in phase `fetching` with a stored cursor
- **THEN** the tick fetches exactly one source page, persists its tracks and the new
  cursor atomically, and leaves the job resumable

#### Scenario: Sync crons unaffected
- **WHEN** either of the two original cron expressions fires
- **THEN** `runSync` executes exactly as before this change

### Requirement: Matching pipeline per direction
For `spotify_to_tidal`, matching SHALL consult the `matches` cache first
(`match_method='cached'`), then ISRC, then fuzzy — reusing the existing Tidal
matchers — and SHALL write newly confirmed pairings back to `tracks` and `matches`.
For `tidal_to_spotify`, matching SHALL use Spotify ISRC search
(`q=isrc:<code>&type=track&limit=10`) with artist-agreement and ±2000 ms duration
checks, then fuzzy text search ranked by the existing `score.ts` weights with the
existing 0.80 acceptance threshold. Tracks failing both stages SHALL become
`state='unmatched'` with top-3 candidates persisted.

#### Scenario: Cached match short-circuits
- **WHEN** a spotify→tidal job track's `spotify_id` exists in `matches`
- **THEN** the track is marked `matched` with `match_method='cached'` and no provider
  request is made

#### Scenario: Reverse ISRC match accepted
- **WHEN** a tidal→spotify track's ISRC search returns a candidate whose artist
  agrees and duration is within tolerance
- **THEN** the track is `matched` with `match_method='isrc'`

#### Scenario: Below-threshold fuzzy becomes unmatched
- **WHEN** the best fuzzy candidate scores below 0.80
- **THEN** the track becomes `unmatched` with its top-3 candidates persisted

### Requirement: Write phase with append dedup and preserved order
The write phase SHALL create the destination playlist on first write for
`dest_mode='new'` (Tidal: `UNLISTED`; Spotify: private via `POST /v1/me/playlists`),
SHALL append matched tracks in source-playlist `position` order in provider-capped
batches (≤20 Tidal, ≤50 Spotify URIs), SHALL skip tracks whose `dest_track_id` is in
`dest_known_ids` (append mode, marked `skipped` with reason `already_present`), and
SHALL flip written rows to `state='written'` in one statement per batch. After a
crash between write and flip, the next tick SHALL reconcile against the destination
before re-adding.

#### Scenario: Destination created on first write
- **WHEN** a `dest_mode='new'` job enters its first write tick
- **THEN** the destination playlist is created and `dest_playlist_id` persisted
  before any tracks are added

#### Scenario: Append skips already-present tracks
- **WHEN** a matched track's destination id appears in `dest_known_ids`
- **THEN** it is marked `skipped`/`already_present` and not sent to the provider

#### Scenario: Crash between write and flip does not duplicate
- **WHEN** a batch was added to the destination but the isolate died before rows
  flipped to `written`
- **THEN** the next tick detects the lag, verifies those ids against the
  destination, and flips them without re-adding

### Requirement: Job completion and terminal states
When every track reaches a terminal per-track state, the job SHALL finish as
`completed` (zero unmatched) or `completed_with_unmatched`, with `finished_at` set.
Provider-fatal errors (revoked token, playlist deleted) SHALL land the job in
`failed` with an `error_code`. Job counters returned by the API SHALL be recomputed
from `copy_job_tracks`, not read from possibly-stale counter columns.

A non-terminal job that has shown no observable change for longer than a configured staleness
window SHALL be swept into `failed` with an `error_code` distinguishing it from a provider-fatal
failure, and the sweep SHALL release the active-job flag. The sweep SHALL run on the twice-daily
sync path, never on the copy tick, because running it on the tick would reintroduce the
per-heartbeat database query this capability removes. For staleness to be measurable, `updated_at`
on `copy_jobs` SHALL advance only when job state actually changes, and SHALL NOT be advanced by a
tick that observes no change.

#### Scenario: Clean completion
- **WHEN** the last matched track is written and no tracks are unmatched
- **THEN** the job status becomes `completed` with non-null `finished_at`

#### Scenario: Completion with leftovers
- **WHEN** all tracks are written, skipped, or unmatched and at least one is unmatched
- **THEN** the job status becomes `completed_with_unmatched`

#### Scenario: Stalled job is swept
- **WHEN** a non-terminal job has not changed for longer than the staleness window
- **THEN** the sync path moves it to `failed` with a stalled `error_code`, sets `finished_at`,
  and releases the active-job flag

#### Scenario: Slow but progressing job is left alone
- **WHEN** a large job is advancing only a few tracks per tick but its counters are still changing
- **THEN** the sweep does not touch it, however long it has been running in total

#### Scenario: A tick that changes nothing does not refresh staleness
- **WHEN** a tick completes without changing job status, counters, or error state
- **THEN** `updated_at` is unchanged, so a wedged job remains detectable as stale

### Requirement: Job inspection API
The Worker SHALL expose `GET /api/copy/jobs?limit=` (newest first),
`GET /api/copy/jobs/:job_id` (summary with recomputed counters), and
`GET /api/copy/jobs/:job_id/tracks?state=&cursor=&limit=` (paged per-track detail
including match method, confidence, candidates, and reason).

#### Scenario: Per-track detail filtered by state
- **WHEN** the operator requests `/api/copy/jobs/:id/tracks?state=unmatched`
- **THEN** only unmatched rows are returned, with candidates included

### Requirement: Cancel job
`POST /api/copy/jobs/:job_id/cancel` SHALL move a non-terminal job to `cancelled`
(engine ticks observe the status and stop); cancelling a terminal job SHALL return
409. Tracks already written remain in the destination playlist.

#### Scenario: Active job cancelled
- **WHEN** the operator cancels a job in phase `matching`
- **THEN** the job becomes `cancelled` with `finished_at` set and later ticks ignore it

### Requirement: Manual resolution of unmatched copy tracks
The Worker SHALL expose `POST /api/copy/jobs/:job_id/tracks/:position/match`
(`{ dest_track_id }`) for terminal jobs: it MUST validate the id against the
destination provider, append the single track to the destination playlist within
the request, and mark the row `written`/`manual`. The Worker SHALL expose
`POST .../skip`, which MUST mark the row `skipped`.
`GET /api/copy/search?provider=&q=` SHALL provide rate-limited candidate search on
the destination provider, mirroring the existing `/unmatched/:id/search` limits.

#### Scenario: Manual match writes immediately
- **WHEN** the operator posts a valid destination track id for an unmatched row
- **THEN** the track is validated, appended to the destination playlist, and the row
  becomes `written` with `match_method='manual'`

#### Scenario: Invalid destination id rejected
- **WHEN** the posted id does not resolve on the destination provider
- **THEN** the response is 422 and the row stays `unmatched`

### Requirement: Tidal playlist-items pagination is OAS-correct
`getPlaylistTracks` SHALL read the next-page cursor from `links.meta.nextCursor` and
report `hasMore` accordingly; its tests SHALL mock the OAS response shape. The item
reader used by copy jobs SHALL also surface `isrc`, `title`, `duration_ms`, and
artist ids from `included[]`, with artist names resolved via batched
`GET /v2/artists?filter[id]=`.

#### Scenario: Multi-page playlist paginates to completion
- **WHEN** a Tidal playlist spans more than one items page
- **THEN** successive calls advance through distinct cursors and terminate after the
  last page

### Requirement: Active-job flag gates database access
The Worker SHALL maintain an advisory flag in a Cloudflare KV namespace recording whether a
non-terminal copy job exists. The flag SHALL be armed when a copy job is created and released on
every transition into a terminal status. The flag SHALL be treated as a cache of `copy_jobs` and
never as a source of truth: any KV failure — read error, write error, or an unbound namespace —
SHALL be reported as "an active job may exist" so the caller falls through to the authoritative
Postgres query. No KV failure may fail a copy job, reject an API request, or abort a tick.

#### Scenario: Flag armed on job creation
- **WHEN** a copy job row is successfully inserted
- **THEN** the active-job flag is present in KV

#### Scenario: Losing the single-active race does not arm the flag
- **WHEN** the insert is rejected by the single-active-job unique index
- **THEN** no flag is written and the request still returns `409 { error: "job_already_active" }`

#### Scenario: Flag released on a terminal transition
- **WHEN** a job moves to `completed`, `completed_with_unmatched`, `failed`, or `cancelled`
- **THEN** the active-job flag is removed from KV

#### Scenario: Non-terminal transition retains the flag
- **WHEN** a job moves from `matching` to `writing`
- **THEN** the active-job flag remains present, so later ticks still see the live job

#### Scenario: KV failure never breaks correctness
- **WHEN** the KV namespace is unavailable or unbound at any call site
- **THEN** job creation, cancellation and status transitions all succeed, the failure is logged,
  and the tick falls back to querying `copy_jobs` exactly as it did before this capability existed

#### Scenario: A lost flag write is recovered
- **WHEN** the flag write is lost but a non-terminal job exists in the database
- **THEN** reading that job through the job inspection API re-arms the flag, and the twice-daily
  sync path reconciles the flag from `copy_jobs` as a backstop

