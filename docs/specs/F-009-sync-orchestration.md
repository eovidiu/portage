# F-009: Sync orchestration

## Summary

The orchestrator runs the full sync sequence: fetch from Spotify (F-005), match (F-006 then F-007), write to Tidal playlist (F-008), and record run statistics (F-011). It enforces a single-run lock, handles abandoned runs, and produces a structured outcome consumed by F-011 logging.

## Linked tests

[T-009](../tests/T-009-sync-orchestration.md)

## Dependencies

- F-005, F-006, F-007, F-008
- F-011 (logging consumes the orchestrator's output)
- Postgres `sync_runs` table

## Behavioural specification

### Successful run, end to end

- **Given** valid tokens for both providers and a non-empty new-likes set
- **When** the orchestrator runs
- **Then** it inserts a `sync_runs` row with `status = 'running'` and `started_at = now()`
- **And** acquires the run lock (Postgres advisory lock with key `sync_run_lock`)
- **And** invokes F-005 to fetch new tracks
- **And** invokes F-006 then F-007 for each new track
- **And** invokes F-008 to write the matched tracks to the Tidal playlist
- **And** updates the `sync_runs` row with counts and `status = 'succeeded'`, `finished_at = now()`
- **And** releases the run lock

### Run with partial errors

- **Given** some per-track errors (e.g., F-006 returned 5xx for individual tracks)
- **When** the orchestrator completes
- **Then** the `sync_runs` row is set to `status = 'partial'` if `errors > 0` AND `(matched_isrc + matched_fuzzy + unmatched) > 0`

### Run with hard failure before any progress

- **Given** the Spotify token cannot be refreshed
- **When** the orchestrator attempts F-005
- **Then** the `sync_runs` row is set to `status = 'failed'`, `finished_at = now()`, with `error_code = 'spotify_reauth_required'`

### Abandoned run cleanup

- **Given** a previous `sync_runs` row in `status = 'running'` whose `started_at` is more than 600 seconds ago
- **When** a new orchestrator invocation begins
- **Then** the orchestrator marks the abandoned row as `failed` with `error_code = 'abandoned'`
- **And** proceeds with the new run

### Concurrent invocation

- **Given** another orchestrator instance is already running
- **When** the second invocation tries to acquire the lock
- **Then** the lock acquisition fails immediately
- **And** the second invocation exits with `status = 'skipped_locked'` (logged but no `sync_runs` row created)

## Detailed requirements

| ID | Requirement |
|---|---|
| F-009-R1 | The orchestrator MUST acquire a Postgres advisory lock named `sync_run_lock` (a deterministic 64-bit integer key) at the start of every run. |
| F-009-R2 | If the lock cannot be acquired immediately, the orchestrator MUST exit with code `skipped_locked` and emit a log line; it MUST NOT create a `sync_runs` row. |
| F-009-R3 | A `sync_runs` row MUST be created before any provider API call. |
| F-009-R4 | The orchestrator MUST honour a hard wall-time cap of 300 seconds; on hitting the cap, it MUST update the run row to `status = 'partial'` with `error_code = 'wall_time_exceeded'`. |
| F-009-R5 | An abandoned run (>600s since `started_at`, status still `running`) MUST be transitioned to `failed` by the next orchestrator invocation. |
| F-009-R6 | Per-track errors in F-006/F-007 MUST NOT abort the run; they MUST be counted and the next track MUST proceed. |
| F-009-R7 | A failure in F-005 (fetch) MUST abort the run before matching begins. |
| F-009-R8 | A failure in F-008 (playlist write) MUST NOT delete or alter the matches that were created in this run. |
| F-009-R9 | The orchestrator MUST be idempotent at the run level: re-running the orchestrator after a failure MUST NOT cause duplicate `tracks` rows, duplicate `matches` rows, or duplicate playlist entries. |
| F-009-R10 | The orchestrator MUST emit one structured log line on completion summarising the run (consumed by F-011). |
| F-009-R11 | The lock MUST be released in a finally block; lock leaks MUST NOT occur on exceptions. |
| F-009-R12 | Per-track errors caught by F-006 (matchByIsrc) and F-007 (matchByFuzzy) MUST be persisted to `sync_runs.error_details` as a JSONB array of `{spotify_id, error_code, message}` records. The array length MUST equal `sync_runs.errors`. |
| F-009-R13 | `error_details` MUST be `NULL` for runs with `errors = 0` (succeeded runs and outer-fatal failed runs that never reached matching). |
| F-009-R14 | The `error_code` values inside `error_details[]` MUST be drawn from the closed set defined by F-006, F-007, and F-023: `tidal_429`, `tidal_<status>` (e.g. `tidal_404`, `tidal_500`), `tidal_error`, `tidal_parse_error`, `isrc_fatal`, `fuzzy_fatal`, `orchestrator_fatal`. |

## State machine

The `sync_runs.status` state machine is defined in `architecture.md` §8.1.

## Data effects

- Inserts one `sync_runs` row per attempted run (except `skipped_locked`)
- Drives all downstream data effects (via F-005 through F-008)

## Failure modes

| Mode | Cause | Recovery |
|---|---|---|
| `skipped_locked` | Concurrent run | Next scheduled run will pick up |
| `abandoned` | Worker died mid-run | Next run cleans up the orphan and proceeds |
| `wall_time_exceeded` | Very large catch-up batch | Next run continues from cursor |
| `spotify_reauth_required` | Spotify token unrecoverable | Operator runs `GET /auth/spotify` |
| `tidal_reauth_required` | Tidal token unrecoverable | Operator runs `GET /auth/tidal` |
| `orchestrator_fatal` | Uncaught error in runSync outer body (seedPlaylistConfigs, listPlaylistConfigs, post-fetch membership INSERT, or final updateRun); see F-023 amendment | Operator inspects `error_details[0].message`; next run retries from cursor |

## Acceptance criteria

- All tests in T-009 pass
- An end-to-end run on a synthetic dataset produces correct counts in the `sync_runs` row
- Killing the worker mid-run leaves the database in a recoverable state; the next run completes successfully
- Two concurrent invocations: one runs, the other exits cleanly with no `sync_runs` row

## Amendment 2026-05-02 (F-015): per-invocation budgets

To fit within the Cloudflare Workers Free 50-subrequest cap, the orchestrator
imposes per-invocation budgets on every loop:

- **R10** — Each invocation MUST process at most `MATCH_BATCH_ISRC` tracks via
  the ISRC stage and at most `MATCH_BATCH_FUZZY` tracks via the fuzzy stage.
  Defaults are 5 each; operator overrides via env vars.
- **R11** — Each invocation MUST fetch at most `LIKED_PAGES_PER_RUN` Spotify
  pages (default 1). Mid-sweep state survives in `sync_state` per F-005-R12-R16.
- **R12** — Status `succeeded` means "this slice completed without errors".
  Pending queue depth (un-matched tracks remaining, mid-sweep resume URL set)
  is normal operational state and does NOT downgrade the run to `partial`.
  The `partial` status is reserved for `errors > 0 ∧ progress > 0` per the
  state machine in `architecture.md` §8.1.
- **R13** — Defaults can be overridden via Worker env vars:
  - `MATCH_BATCH_ISRC` — integer ≥1 (defaults to 5; invalid input ⇒ default)
  - `MATCH_BATCH_FUZZY` — integer ≥1 (defaults to 5; invalid input ⇒ default)
  - `LIKED_PAGES_PER_RUN` — integer ≥1 (defaults to 1; invalid input ⇒ default)

## Amendment 2026-05-03: per-track error_details persistence (R12-R14)

Phase 1 diagnostic audit (`.harness/diagnostics/phase1-partials-2026-05-03.md`)
established that ~5–7% of cron runs land as `partial` with `errors > 0`, but
the per-track error code and `spotify_id` are emitted only as `console.log`
JSON (24-hour retention via `wrangler tail`) and never persisted. This makes
intermittent partials undiagnosable from DB alone.

This amendment makes any partial run diagnosable from a single SQL query by
persisting the per-track failure detail to a new column.

- Adds R12 (persist), R13 (null discipline), R14 (closed code set).
- Adds column `sync_runs.error_details JSONB DEFAULT NULL`. Migration is
  purely additive; old rows remain `NULL`.
- Existing `errors` INT and `error_code` TEXT columns retained unchanged.
- T-009-15 / T-009-16 / T-009-17 added to gate the new persistence behaviour.

Diagnostic query post-deploy:

```sql
SELECT detail->>'error_code' AS code, COUNT(*) AS n
FROM sync_runs, jsonb_array_elements(error_details) AS detail
WHERE status = 'partial' AND started_at > NOW() - INTERVAL '7 days'
GROUP BY 1 ORDER BY 2 DESC;
```

## Amendment 2026-05-08 (M5): outer-error attribution discrimination

Sprint 6 review surfaced that the orchestrator's outer try/catch hardcoded
`error_code = 'spotify_reauth_required'` on every fetch failure. This conflated
genuine reauth requirements with transient network failures, ciphertext
decryption errors, and generic upstream errors — making the failure-modes
table aspirational rather than authoritative. This amendment makes the outer
classifier discriminating per the failure-modes table.

### R15 — Outer-error classifier

The outer try/catch wrapping the F-005 fetch call MUST classify the thrown
error and set `sync_runs.error_code` per this table:

| Thrown by | error_code |
|---|---|
| `SpotifyAuthError` with `code === "reauth_required"` (no tokens, refresh returned `invalid_grant`) | `spotify_reauth_required` |
| `SpotifyAuthError` with `code === "refresh_failed"` (refresh endpoint 5xx, network) | `spotify_transient` |
| Generic `Error` whose message matches `/rate limit|Spotify API error.*: 5\d\d/` (raised by `fetchPage`) | `spotify_transient` |
| `IntegrityError` from F-004 token decrypt | `decrypt_failed` |
| Any other thrown value (Error or non-Error) | `fetch_failed` |

The classifier MUST be exhaustive — every code path through the outer catch
MUST set one of the five codes above. The hardcoded `spotify_reauth_required`
fallback is removed.

### Failure modes (extended)

| Mode | Cause | Recovery |
|---|---|---|
| `skipped_locked` | Concurrent run | Next scheduled run picks up |
| `abandoned` | Worker died mid-run | Next run cleans up the orphan and proceeds |
| `wall_time_exceeded` | Very large catch-up batch | Next run continues from cursor |
| `spotify_reauth_required` | Spotify token unrecoverable | Operator runs `GET /auth/spotify` |
| `tidal_reauth_required` | Tidal token unrecoverable | Operator runs `GET /auth/tidal` |
| `spotify_transient` (NEW) | Refresh 5xx, Spotify 5xx, second 429 | Next cron tick retries; no operator action |
| `decrypt_failed` (NEW) | TOKEN_ENCRYPTION_KEY rotation or ciphertext corruption | Operator investigates secret; may need re-mint + re-OAuth |
| `fetch_failed` (NEW) | Generic fetch failure outside known buckets | Operator inspects logs |

### Test gates

- T-009-05a: `SpotifyAuthError("reauth_required", ...)` → `spotify_reauth_required`
- T-009-05b: `SpotifyAuthError("refresh_failed", ...)` → `spotify_transient`
- T-009-05c: `IntegrityError(...)` → `decrypt_failed`
- T-009-05d: `Error("Spotify API error: 503")` → `spotify_transient`
- T-009-05e: `Error("Spotify rate limit: second 429 received...")` → `spotify_transient`
- T-009-05f: `Error("any other message")` → `fetch_failed`
- T-009-05g: non-Error throw (e.g. string) → `fetch_failed`

Per-track codes (R14) inside `error_details[]` are unchanged by this amendment.

## Amendment 2026-05-09 (F-016b): multi-playlist orchestrator wiring (R16-R20)

Multi-playlist sync (F-016/F-017/F-018) is now wired into the orchestrator.
The fetch/write loop runs once per playlist registered in `playlist_configs`
(capped per-invocation), with the global match queue shared across all
playlists. Subrequest budget at `MAX_PLAYLISTS_PER_RUN=3` (4 playlists total
including Liked Songs) lands at ~18 subrequests per tick under steady state,
well within the Workers Free 50-cap.

### R16 — Seed playlist_configs at the top of every run

The orchestrator MUST call `seedPlaylistConfigs(env)` (from
`src/sync/playlist-config-seeder.ts`, F-016) BEFORE the fetch loop on every
invocation. This ensures the synthetic `__liked__` row is present and any
new IDs in `SPOTIFY_EXTRA_PLAYLIST_IDS` are upserted with their fetched
Spotify name. The seeder is idempotent (F-016-R11) so calling it on every
run is safe.

### R17 — Per-playlist fetch loop

The orchestrator MUST iterate `listPlaylistConfigs(sql)` and fetch tracks
for each row, capped at `MAX_PLAYLISTS_PER_RUN` (default 3, env-configurable,
defaults applied via the F-015 `readBudget` pattern).

The cap MUST always include `__liked__` — Liked Songs is processed every
run, and the cap applies to extras only. Effectively: process Liked Songs
plus up to `(MAX_PLAYLISTS_PER_RUN - 1)` extras per run. (Practical cap of
3 means one __liked__ + up to 2 extras under steady state.) Extras beyond
the cap are deferred to subsequent invocations; ordering is by
`last_synced_at NULLS FIRST, created_at` so newly-added extras get a turn
quickly.

For `__liked__`:
- Call `fetchLikedSongs(env, LIKED_PAGES_PER_RUN)` (F-005). Membership writes
  happen inside its page transactions (R18).

For extras:
- Call `fetchPlaylistTracks(env, spotifyPlaylistId, LIKED_PAGES_PER_RUN)`
  (F-017). Membership writes happen inside the fetch transaction.

Per-playlist fetch failures MUST be classified by F-009 R15 and logged
without aborting subsequent playlists' fetches in the same run. (One bad
playlist must not block others.)

### R18 — __liked__ membership written by the liked fetch (amended 2026-07-30)

`fetchLikedSongs` MUST upsert a `playlist_membership` row
(`spotify_playlist_id = '__liked__'`, `added_at` = the track's Spotify
`added_at`, `synced_at` NULL) for every track it fetches, inside the same
per-page transaction that persists the page's `tracks` rows — mirroring
F-017's `fetchPlaylistTracks`. The upserts are idempotent via
ON CONFLICT DO NOTHING, and membership MUST be written for every fetched
track regardless of whether its `tracks` row already existed.

The orchestrator MUST NOT derive `__liked__` membership from the `tracks`
table. The original R18 backfill
(`INSERT ... SELECT FROM tracks LEFT JOIN playlist_membership ...`) assumed
`tracks` contained only liked songs; once F-030's copy engine began seeding
`tracks` with arbitrary copy-source tracks, the backfill turned all of them
into phantom Liked members and the write pass pushed 352 foreign tracks
into the Tidal playlist (2026-07-28..30 incident). Membership provenance
belongs at the fetch site, which is the only place that knows where a track
came from.

### R19 — Per-playlist write loop

After the global ISRC + fuzzy match queue runs (existing R10/R12 paths,
unchanged), the orchestrator MUST iterate the same `playlist_configs` set
processed in R17 and call F-018's `writePlaylist(env, spotifyPlaylistId, tidalPlaylistId)`
for each row. The Tidal id is read from `playlist_configs.tidal_playlist_id`;
if null, F-018 auto-creates the Tidal playlist and persists the new id.

Per-playlist write failures (Tidal 5xx, network) MUST be logged but MUST NOT
abort the run — the run continues to subsequent playlists. The
`PlaylistWriteResult` from F-018 surfaces error counts; the orchestrator
aggregates them into the `sync_runs` row.

### R20 — Configuration: `MAX_PLAYLISTS_PER_RUN`

A new env var `MAX_PLAYLISTS_PER_RUN` controls the per-invocation extras
cap. Format: integer ≥1 (defaults to 3; invalid input ⇒ default). Same
fallback semantics as F-015's `LIKED_PAGES_PER_RUN` etc. The seeder + R17
loop both reference this value.

### R21 — Subrequest budget audit (Workers Free 50-cap)

Steady-state per-invocation subrequest count with N extras:
- 1 fetchLikedSongs page = 1
- N fetchPlaylistTracks pages = N
- Up to MATCH_BATCH_ISRC ISRC lookups = 5 (global)
- Up to MATCH_BATCH_FUZZY fuzzy searches = 5 (global)
- Up to (1 + N) Tidal write batches = (1 + N) (one per playlist with
  unsynced rows; getPlaylist sometimes adds 1 per playlist on first sync)

For N=3 (MAX_PLAYLISTS_PER_RUN=3, plus __liked__): 1 + 3 + 5 + 5 + 4 = 18
subrequests, leaving 32 for retries/transients. For N=18, total ≈ 47 (right
at cap, no headroom). Operator MUST keep `MAX_PLAYLISTS_PER_RUN` ≤ 3 unless
upgrading to Workers Paid.

### R22 — sync_runs row aggregation across playlists

The `sync_runs` row counts (`tracks_seen, matched_isrc, matched_fuzzy,
unmatched, errors`) MUST aggregate across ALL playlists processed in the
invocation. Per-playlist totals are logged via the F-018 `playlist_write_completed`
event but NOT persisted as separate rows. This keeps the sync_runs schema
flat and compatible with existing F-011 read paths (status/runs/stats
endpoints).

### R23 — Test gates (T-009 extension)

- T-009-21: orchestrator calls seedPlaylistConfigs before fetch loop
- T-009-22: orchestrator processes __liked__ + extras within MAX_PLAYLISTS_PER_RUN cap
- T-009-23: orchestrator emits the post-fetch __liked__ membership upsert query
- T-009-24: per-playlist write failure does NOT abort the run
- T-009-25: 0 extras (env var empty) preserves the pre-multi-playlist behaviour
- T-009-26: legacy single-arg `writePlaylist(env)` call site replaced with
  per-playlist invocation

## Amendment 2026-05-13 (F-023): orchestrator_fatal catch-all

Production query of `sync_runs` on 2026-05-13 revealed that 7 of 8 failed runs
in the trailing 14 days were "silent abandons" — rows with `status='running'`,
`error_code=null`, and all counters at zero. They sat as `running` for ~12h
until `markAbandonedRuns` swept them via the existing F-009-R5 path. Root
cause: `runSync()` had only a `finally { releaseLock() }` clause and no
`catch`, so errors from the un-wrapped outer code in `runSyncBody`
(`seedPlaylistConfigs`, `listPlaylistConfigs`, the post-fetch membership
`INSERT`, and the final `updateRun`) escaped `runSync` entirely. They
propagated to `scheduled.ts`'s `.catch` which only logged a
`scheduled_failed` event — the `sync_runs` row was never updated.

### R24 — Top-level catch in runSync

The orchestrator MUST wrap the `try { ... }` block of `runSync` with a
`catch (err)` that:

1. If `runId !== undefined` (i.e., `insertRun` succeeded), MUST call
   `updateRun(env, runId, { status: 'failed', error_code:
   'orchestrator_fatal', errors: 1, error_details: [{ spotify_id: 'unknown',
   error_code: 'orchestrator_fatal', message }], finished_at: <timestamp> })`.
   The `message` is `err instanceof Error ? err.message : String(err)`. The
   `error_details[]` entry follows the existing R12 shape
   (`{spotify_id, error_code, message}`) using the project-standard
   `spotify_id: 'unknown'` placeholder for non-per-track errors (same as
   `isrc_fatal` / `fuzzy_fatal` in `runSyncBody`); R14's closed set is
   extended to include `orchestrator_fatal`. `errors: 1` keeps the row
   consistent with R13 (which requires `error_details = NULL` only when
   `errors = 0`).
2. If that `updateRun` itself throws (e.g., Neon still unreachable), MUST
   log a `sync_run_update_failed_in_catch` event with the primary and
   secondary error messages, then continue. The next cron's
   `markAbandonedRuns` is the safety net.
3. MUST emit a `sync_run_completed` log line with `outcome=failed`,
   `error_code=orchestrator_fatal`, and the primary message.
4. MUST return `{ outcome: 'failed', run_id: runId, error_code: 'orchestrator_fatal' }`.
5. The pre-existing `finally { releaseLock() }` MUST continue to release the
   advisory lock.

### R25 — Test gates (T-023)

- T-023-01: `seedPlaylistConfigs` throws → row marked
  `failed/orchestrator_fatal`
- T-023-02: `listPlaylistConfigs` throws → row marked
  `failed/orchestrator_fatal`
- T-023-03: `error_details[0].message` contains the original error message
- T-023-04: recovery `updateRun` also throws → run still returns
  `failed/orchestrator_fatal`, lock still released
- T-023-05: `insertRun` itself throws → `runId` undefined, no
  `updateRun` call, lock released, `outcome=failed`,
  `error_code=orchestrator_fatal`
