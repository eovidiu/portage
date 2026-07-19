# Tasks: playlist-copy

## 1. Schema and provider foundations

- [x] 1.1 Add `copy_jobs` + `copy_job_tracks` tables and `provider_tokens.scopes`
      column to `db/schema.sql`; apply to Neon (additive, inert)
- [x] 1.2 Create `src/providers/spotify/scopes.ts`; switch the authorize-URL builder
      to it; persist granted `scope` string on token exchange/refresh (tests first)
- [x] 1.3 Fix `getPlaylistTracks` cursor path to `links.meta.nextCursor`; correct
      test mocks to the OAS shape; add a multi-page pagination test that fails on
      the old code
- [x] 1.4 Add Tidal rich item reader (id, isrc, title, duration_ms, artist ids from
      `included[]`) + batched `GET /v2/artists?filter[id]=` name resolver
- [x] 1.5 Add Tidal list-own-playlists client
      (`GET /v2/playlists?filter[owners.id]=me`, cursor pagination)
- [x] 1.6 Add Spotify list-own-playlists client (`GET /v1/me/playlists`, offset
      pagination)
- [x] 1.7 Add Spotify write client: `POST /v1/me/playlists` (private) and
      `POST /v1/playlists/{id}/items` (≤50 URIs, 429 retry-once)
- [x] 1.8 Add Spotify catalog search: ISRC lookup with artist/duration gates, fuzzy
      search mapped into `score.ts` ranking, top-3 candidate capture

## 2. Copy job engine

- [x] 2.1 DB modules `src/db/copy_jobs.ts` + `src/db/copy_job_tracks.ts` (create,
      load-active, phase updates, counter recompute, state-flip statements)
- [x] 2.2 `runCopyTick` skeleton: idle fast-path (single query), shared advisory
      lock acquire/skip, phase dispatch, persist-before-exit
- [x] 2.3 Fetch phase: one source page per tick, artist-name resolution for Tidal
      sources, atomic cursor+rows persist, `total_tracks` on completion
- [x] 2.4 Match phase: cache→ISRC→fuzzy for spotify→tidal (write-back to
      `tracks`/`matches`); ISRC→fuzzy for tidal→spotify; `COPY_BATCH_ISRC`/
      `COPY_BATCH_FUZZY` budgets (default 2)
- [x] 2.5 Write phase: dest-create on first write, position-ordered capped batches,
      append dedup via `dest_known_ids`, single-statement written-flip,
      crash reconcile
- [x] 2.6 Terminal-state handling: completed / completed_with_unmatched / failed
      with `error_code`; `finished_at` invariant; ntfy notification
- [x] 2.7 Wire `*/5 * * * *` into `wrangler.toml`; dispatch on `controller.cron` in
      `scheduled.ts`; prove sync crons unaffected

## 3. HTTP API

- [x] 3.1 `GET /api/copy/playlists` (both providers, pagination pass-through,
      `spotify_reauth_required` gate)
- [x] 3.2 `POST /api/copy/jobs` (validation, append snapshot + size cap,
      single-active-job 409)
- [x] 3.3 `GET /api/copy/jobs`, `GET /api/copy/jobs/:id` (recomputed counters),
      `GET /api/copy/jobs/:id/tracks` (state filter + paging)
- [x] 3.4 `POST /api/copy/jobs/:id/cancel`
- [x] 3.5 Manual resolution: `GET /api/copy/search` (rate-limited),
      `POST .../tracks/:position/match` (validate + immediate append),
      `POST .../tracks/:position/skip`
- [x] 3.6 Confirm CF Access middleware covers all `/api/copy/*` routes (no
      skip-list changes) — negative test

## 4. Verification and close-out

- [x] 4.1 Full suite + typecheck green; coverage ≥95% on touched code
- [x] 4.2 Update `docs/README.md` feature map + pre-deploy checklist (Spotify
      re-consent step, cron-slot check, scope-verification step)
- [ ] 4.3 features.json: F-030 entry updates (test_file, coverage, status)
- [ ] 4.4 Deploy + live validation per design Migration Plan (small playlist both
      directions); capture Version ID in context_summary Active Context
