# Design: playlist-copy

## Context

Portage syncs Spotify Liked Songs + configured playlists into Tidal, one direction,
via two daily crons. All state lives in Neon; per-invocation work is clamped to fit
the Workers free tier (10 ms CPU, 50 subrequests — see grounding below). This change
adds an operator-triggered, one-shot, bidirectional playlist copy that reuses the
matching machinery and free-tier execution patterns without touching the sync
pipeline.

Grounded API facts (full citations in the session research notes; key sources listed
here so the spec stands alone):

| Fact | Source |
|---|---|
| Spotify create playlist is `POST /v1/me/playlists`; the `/users/{id}/playlists` form is legacy | developer.spotify.com Web API reference, "Create Playlist" |
| Spotify add items is `POST /v1/playlists/{id}/items`, max 100 URIs/request, returns `snapshot_id`; `/tracks` path deprecated | Web API reference, "Add Items to Playlist" |
| Scopes: `playlist-read-private` (read own private playlists), `playlist-modify-private` (write private); search needs no scope | Web API reference, Scopes pages |
| `GET /v1/me/playlists`: limit 1–50, offset paging | Web API reference, "Get Current User's Playlists" |
| `GET /v1/search` with `q=isrc:<code>&type=track`: limit default 5, **max 10** (smaller than other endpoints) | Web API reference, "Search" (verbatim: "Default: limit=5 Range: 0 - 10") |
| Spotify rate limiting: 429 + `Retry-After`, rolling 30 s window | Web API docs, Rate Limits |
| Tidal list own playlists: `GET /v2/playlists?filter[owners.id]=me`, scope **`playlists.read` only** (already granted → no Tidal re-auth); full attributes in `data[]`, cursor at `links.meta.nextCursor` | tidal-api-oas.json (tidal-music.github.io/tidal-api-reference), security blocks parsed from raw OAS |
| Tidal playlist items: `?include=items` embeds `isrc`, `title`, `duration` in `included[].attributes`; artist NAMES are not embedded — need batched `GET /v2/artists?filter[id]=` | tidal-api-oas.json, `Tracks_Attributes` |
| Owned playlists only; followed playlists sit behind `collection.read` (not granted) | tidal-api-oas.json, `userCollections` security |
| Workers free plan: cron triggers available, ≤5 schedules, sub-hourly OK; per cron invocation 10 ms CPU + 50 subrequests; cron wall-clock cap 15 min; awaited I/O does not consume CPU time | developers.cloudflare.com Workers Limits + Cron Triggers |
| Multi-cron dispatch: scheduled handler receives `controller.cron` identifying which schedule fired | developers.cloudflare.com scheduled() docs |

Known latent bug, fixed by this change because the copy engine is its first real
caller: `src/providers/tidal/playlist.ts:95` reads `json.meta?.cursor`, which never
exists in the OAS response (`links.meta.nextCursor` is correct), while line 96 treats
a present `links.next` as `hasMore` — an infinite refetch of page 1 on any multi-page
playlist. Its unit tests pass because the mocks encode the same wrong shape; the
mocks get corrected to the OAS shape.

## Goals / Non-Goals

**Goals:**
- One-shot copy of a single playlist, either direction, from the UI.
- Destination: new playlist (same name) or append-to-existing with dedup.
- Runs to completion on the free tier no matter the playlist size (hours are fine).
- Unmatched tracks resolvable manually from the UI after the job finishes.
- Existing sync behavior, tables, and crons untouched.

**Non-Goals:**
- Ongoing/linked sync of copied pairs (explicitly rejected in planning).
- Followed/saved playlists as sources (requires Tidal `collection.read` re-auth).
- Multiple concurrent copy jobs (v1 allows one active job; 409 otherwise).
- Public destination playlists (`playlist-modify-public` not requested; destinations
  are private/unlisted, matching the sync pipeline's `UNLISTED` convention).

## Decisions

### D1 — Job engine: dedicated `*/5` cron, dispatch on `controller.cron`

A copy of a few hundred tracks needs dozens of small chunks; the 2×-daily sync crons
would stretch that into weeks. A `*/5 * * * *` schedule adds 288 invocations/day
(0.3 % of the request quota) and the handler exits in microseconds when
`copy_jobs` has no active row (one Neon query, one subrequest). `scheduled.ts`
routes: existing cron expressions → `runSync`, new expression → `runCopyTick`.
Alternatives rejected: self-invoking fetch chains (fragile, burns subrequests),
Durable Objects alarms (new platform dependency for a single-tenant tool).

### D2 — Concurrency: copy engine shares the sync advisory lock

`runCopyTick` acquires the SAME Postgres advisory lock as `runSync`. Twice a day a
copy tick lands in the same window as a sync run and simply skips (retries ≤5 min
later). This buys total serialization: no token-refresh races on the shared
`provider_tokens` rows, no interleaved writes, no new lock-ordering rules.
Alternative (separate lock) rejected: the only benefit is avoiding a ≤5-minute delay
twice a day; the cost is reasoning about two engines refreshing the same tokens
concurrently.

### D3 — Schema: self-contained `copy_jobs` + `copy_job_tracks`

The sync tables are directionally keyed (`matches.spotify_id` PK → FK `tracks`;
`unmatched` likewise). Reverse-direction rows cannot live there without breaking
I-001's meaning. Copy state is therefore self-contained:

```sql
CREATE TABLE copy_jobs (
    job_id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    direction           TEXT NOT NULL CHECK (direction IN ('spotify_to_tidal','tidal_to_spotify')),
    source_playlist_id  TEXT NOT NULL,
    source_name         TEXT NOT NULL,
    dest_mode           TEXT NOT NULL CHECK (dest_mode IN ('new','append')),
    dest_playlist_id    TEXT,            -- set at create for append; after first write for new
    dest_name           TEXT,
    status              TEXT NOT NULL DEFAULT 'queued'
                        CHECK (status IN ('queued','fetching','matching','writing',
                                          'completed','completed_with_unmatched',
                                          'failed','cancelled')),
    error_code          TEXT,
    fetch_cursor        TEXT,            -- resumable source-page cursor
    dest_known_ids      JSONB,           -- append-mode dedup snapshot (dest track ids)
    total_tracks        INT,             -- NULL until fetch completes
    fetched             INT NOT NULL DEFAULT 0,
    matched             INT NOT NULL DEFAULT 0,
    written             INT NOT NULL DEFAULT 0,
    unmatched           INT NOT NULL DEFAULT 0,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at         TIMESTAMPTZ
);

CREATE TABLE copy_job_tracks (
    job_id          UUID NOT NULL REFERENCES copy_jobs(job_id) ON DELETE CASCADE,
    position        INT NOT NULL,        -- source playlist order, preserved on write
    source_track_id TEXT NOT NULL,
    isrc            TEXT,
    title           TEXT NOT NULL,
    artist          TEXT,                -- resolved lazily for Tidal sources
    album           TEXT,
    duration_ms     INT,
    state           TEXT NOT NULL DEFAULT 'pending'
                    CHECK (state IN ('pending','matched','unmatched','skipped',
                                     'written','write_failed')),
    match_method    TEXT CHECK (match_method IN ('isrc','fuzzy','manual','cached')),
    confidence      NUMERIC(3,2),
    dest_track_id   TEXT,
    candidates      JSONB,               -- top-3 on fuzzy rejection, like unmatched
    reason          TEXT,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (job_id, position)
);
CREATE INDEX idx_copy_job_tracks_state ON copy_job_tracks(job_id, state);
```

Terminal statuses have non-null `finished_at` (mirrors I-004). Job status is the
engine's resume point: each tick loads the single active job and continues its
current phase. `dest_known_ids` is captured once at append-job creation (bounded:
dest playlists are operator-owned; guard with a size cap and fail the job creation
past ~5 000 ids).

### D4 — Match-cache interplay: read `matches`, write back Spotify→Tidal only

Spotify→Tidal chunks consult `matches` first (`method='cached'`, no subrequests),
then ISRC, then fuzzy — new confirmed pairings are written back to `tracks` +
`matches` so future syncs and copies benefit (allowed by I-001: a spotify_id in
`matches` and absent from `unmatched` is a legal state regardless of how it got
there). Tidal→Spotify pairings live only in `copy_job_tracks` (no reverse cache
table in v1; a second reverse copy re-matches, which is acceptable for a one-shot
feature).

### D5 — Reverse matching (Tidal→Spotify)

ISRC-first: `GET /v1/search?q=isrc:<code>&type=track&limit=10` + the same artist
agreement and ±2000 ms duration checks as `src/match/isrc.ts`. Fuzzy fallback:
text query from title+artist, ranked with the existing weights in
`src/match/score.ts` (title .40 / artist .30 / duration .20 / album .10) — the
scorer is provider-agnostic; only the candidate mapper is new. Artist names for
Tidal source tracks are resolved in batched `GET /v2/artists?filter[id]=` calls
during the fetch phase and persisted on `copy_job_tracks.artist`, so matching
chunks never re-fetch them.

### D6 — Per-tick budget (calibrated to the sync engine's production history)

The sync engine needed `MATCH_BATCH_* = 2` to stop free-tier CPU kills (~36 % of
runs were silently terminated at batch 5). The copy engine adopts the same
conservatism, env-tunable via `[vars]`:

| Phase (one per tick) | Work per tick | Subrequests |
|---|---|---|
| fetching | 1 source page (50 Spotify / 20 Tidal items) + ≤2 artist-batch lookups (Tidal src) | ≤4 |
| matching | `COPY_BATCH_ISRC=2` ISRC lookups, then `COPY_BATCH_FUZZY=2` fuzzy searches | ≤5 |
| writing | 1 batch (≤20 Tidal / ≤50 Spotify URIs) | ≤2 |

Plus lock + a handful of Neon queries (HTTP driver: 1 subrequest each). Worst
observed matching tick (ISRC-pool tracks failing both ISRC and fuzzy at budgets
2/2) is 19 subrequests — still well under the 50 hard cap. State is persisted after every step (cursor advance
rule mirrors I-005: persist page rows atomically with the cursor). A 250-track
playlist ≈ 5 fetch + 63 match + 13 write ticks ≈ 7 hours at `*/5` — within the
"may take hours" acceptance.

### D7 — Write idempotency on crash

Adding items is not idempotent on either provider (Spotify allows duplicates; Tidal
too for UNLISTED playlists). Protocol: mark the batch's rows `state='writing'`… is
not a state — instead, the tick re-checks before writing: it selects the next ≤N
`matched` rows, writes them, then flips them to `written` in one statement. If the
isolate dies between write and flip, the next tick re-reads the destination
playlist's tail (1 subrequest) and reconciles: rows whose `dest_track_id` already
appears are flipped to `written` without re-adding. The reconcile read happens only
when the previous tick's batch is still `matched` but the job's `written` counter
lags — a cheap, targeted check, not a full-playlist scan (append-mode's
`dest_known_ids` plus written history reconstructs the expected tail).

### D8 — Spotify scopes: centralize + detect stale grants

New `src/providers/spotify/scopes.ts` (mirroring the Tidal pattern) exporting
`SPOTIFY_SCOPES = "user-library-read playlist-read-private playlist-modify-private"`;
the authorize-URL literal at `oauth.ts:71` switches to it. The token-exchange and
refresh responses' `scope` field is persisted to a new `provider_tokens.scopes TEXT`
column. Copy endpoints that need the new scopes return
`409 { error: "spotify_reauth_required" }` when the stored grant lacks them, and the
UI surfaces a "Reconnect Spotify" prompt. (Grounding gap, flagged in research: no doc
confirms whether re-consent alone suffices without a Spotify dashboard change —
verified empirically as the first step of the deploy checklist.)

### D9 — API contract (the UI change in portage-ui is written against this)

All routes CF Access-protected like existing `/api/*`; no auth skip-list changes.

```
GET  /api/copy/playlists?provider=spotify|tidal[&cursor=]
  200 { playlists: [{ id, name, track_count }], next_cursor: string|null }

POST /api/copy/jobs
  body { source_provider: "spotify"|"tidal", source_playlist_id: string,
         dest_mode: "new"|"append", dest_playlist_id?: string, dest_name?: string }
  201 { job_id }        409 { error: "job_already_active" | "spotify_reauth_required" }
  422 on validation (unknown playlist, append target not owned, dest cap exceeded)

GET  /api/copy/jobs?limit=20
  200 { jobs: [ JobSummary ] }        -- newest first
GET  /api/copy/jobs/:job_id
  200 JobSummary                      -- status, direction, names, counters, error_code
GET  /api/copy/jobs/:job_id/tracks?state=&cursor=&limit=50
  200 { tracks: [ { position, source_track_id, title, artist, state, match_method,
                    confidence, dest_track_id, candidates, reason } ], next_cursor }
POST /api/copy/jobs/:job_id/cancel
  200 { status: "cancelled" }         409 if already terminal

GET  /api/copy/search?provider=spotify|tidal&q=          -- manual-resolution search,
  200 { candidates: [{ id, title, artist, album, duration_ms }] }   rate-limited like
                                                                    /unmatched/:id/search
POST /api/copy/jobs/:job_id/tracks/:position/match   body { dest_track_id }
  200 — validates the id resolves on the destination provider, writes the track
        immediately (single append, ≤2 subrequests), state → written, method manual
POST /api/copy/jobs/:job_id/tracks/:position/skip
  200 — state → skipped
```

Manual match/skip after a terminal `completed_with_unmatched` job operates directly
in the HTTP request (like the existing unmatched flow) — no engine involvement.

### D10 — Notifications

`notifyNtfy` gains a copy-job terminal message (title, direction, written/unmatched
counts). Sent from the tick that lands the job in a terminal state; delivery
failures are non-fatal (existing pattern).

## Risks / Trade-offs

- [CPU kill mid-tick despite clamps] → same mitigation lineage as the sync engine's
  batch clamp; every step persists before the next; a killed tick loses ≤1 step and
  the write path reconciles (D7). Counters may transiently undercount; they are
  recomputed from `copy_job_tracks` on job load, not trusted blindly.
- [Cron-schedule account cap (5)] → portage moves 2→3. Deploy checklist verifies no
  other Workers on the account consume the remaining slots.
- [Spotify re-consent assumption unverified in docs] → first deploy-checklist step is
  the live re-auth; if scopes don't materialize, stop and investigate before any
  copy-endpoint work is exposed in the UI.
- [Spotify search limit 10 constrains candidate pools] → matcher uses top-10; the
  sync-side fuzzy matcher already accepts from pools this size.
- [Append dedup snapshot staleness (operator edits dest mid-job)] → accepted for v1;
  documented. Worst case: a duplicate track in the destination.
- [Two engines, one token store] → eliminated by sharing the advisory lock (D2).
- [tidal cursor bugfix changes tested behavior] → mocks currently encode a wrong
  contract; they are corrected to the OAS shape, and the fix is covered by a
  multi-page pagination test that fails on the old code.

## Migration Plan

1. Apply additive schema (2 new tables + `provider_tokens.scopes` column) via Neon —
   inert until routes/cron ship.
2. Deploy Worker (new cron in `wrangler.toml` ships in the same deploy; ticks no-op
   while no job exists).
3. Operator re-auths Spotify; `/readyz`-adjacent scope check confirms the new grant.
4. UI change (portage-ui) merges + deploys against the D9 contract.
5. Live validation: small playlist both directions.
Rollback: remove the cron + `/api/copy` routes (revert deploy); tables and the
scopes column are inert and keep their data; the widened Spotify grant is harmless.

## Open Questions

None blocking. Deferred by decision: followed-playlist sources (`collection.read`
re-auth), reverse match cache, multi-job concurrency.
