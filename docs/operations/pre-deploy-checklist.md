# Pre-deploy verification checklist

The full step-by-step walkthrough for a fresh deployment lives in
[`self-hosting.md`](self-hosting.md). Follow that document for the
canonical path: prerequisites, Spotify and Tidal app registration, Neon
provisioning, secret setup, deploy, OAuth dance, first sync, optional
Cloudflare Access, troubleshooting, updates, and uninstall.

The checklist below is a slimmer companion to use when you're re-deploying
a known-good setup (e.g., re-pointing at a new domain, rotating a secret,
or upgrading after a `git pull`) and want a quick "did I cover everything?"
pass. Skip it if you're doing a fresh install.

## Source-of-truth audits

Before deploying, confirm that no upstream API contracts have moved since
the last release:

- Spotify Liked Songs endpoint — `src/providers/spotify/liked.ts` against
  <https://developer.spotify.com/documentation/web-api/reference/get-users-saved-tracks>
  (URL path, `limit=50` cap).
- Tidal ISRC search — `src/match/isrc.ts` against the Tidal Open API v2
  `/tracks` reference (URL template, `filter[isrc]` parameter name).
- Tidal fuzzy search — `src/match/fuzzy.ts` against the Tidal Open API v2
  `searchresults` reference.
- Tidal playlist endpoints — `src/providers/tidal/playlist-endpoints.ts`
  against the Tidal Open API v2 playlists reference (create-playlist body
  shape, add-tracks body shape).
- Tidal track-by-id endpoint — `src/routes/unmatched.ts` (used for the
  manual-match flow's existence check).
- Tidal app scopes — `src/providers/tidal/scopes.ts` against the scope
  list currently selected in your <https://developer.tidal.com> app.

If any of these have drifted, fix the code (and regenerate
`src/providers/tidal/openapi-types.ts` via `npm run gen:tidal-types`)
before deploying.

## Pre-flight

- `npm test` passes.
- `npm run typecheck` passes.
- `wrangler secret list` shows all seven secrets:
  `JWT_SECRET`, `TOKEN_ENCRYPTION_KEY`, `DATABASE_URL`,
  `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`, `TIDAL_CLIENT_ID`,
  `TIDAL_CLIENT_SECRET`.
- `wrangler.toml` `[vars]` has the public values set:
  `SPOTIFY_REDIRECT_URI`, `TIDAL_REDIRECT_URI`, `TIDAL_COUNTRY_CODE`,
  `TIDAL_PLAYLIST_TITLE`, `OPERATOR_EMAIL`, `UI_ORIGIN`, and (if
  Cloudflare Access is enabled) `CF_ACCESS_TEAM` + `CF_ACCESS_AUD`.
- If ntfy notifications are enabled (F-029): `NTFY_TOPIC` (and optionally
  `NTFY_TOKEN`) appear in `wrangler secret list` and the topic is
  subscribed in the ntfy app. Unset = notifications off, which is also
  the rollback path.
- Schema is current: `db/schema.sql` re-applied if the release notes
  mention schema changes.
- Playlist copy (F-030) preconditions:
  - `wrangler.toml` `crons` includes `*/5 * * * *` (copy-engine tick) and
    `[vars]` sets `COPY_BATCH_ISRC` + `COPY_BATCH_FUZZY`.
  - `wrangler.toml` has the `[[kv_namespaces]]` block binding `COPY_STATE`
    (F-032). Create it once with
    `npx wrangler kv namespace create COPY_STATE` and paste the printed id —
    wrangler does not patch TOML configs for you. Confirm `COPY_STATE`
    appears in the binding list `wrangler deploy` prints. Without it the
    Worker still runs correctly, but every copy tick queries Neon, which on
    the Neon free plan holds the compute awake around the clock and exhausts
    the monthly CU-hour quota in about two weeks.
  - The Cloudflare account has a free cron-schedule slot available
    (free tier allows 5; portage now uses 3).
  - After the first deploy with the widened Spotify scope set: re-run the
    Spotify OAuth dance via `/auth/spotify` and verify the stored grant —
    `provider_tokens.scopes` for `spotify` must contain
    `playlist-read-private` and `playlist-modify-private`. Until then,
    `/api/copy/playlists?provider=spotify` intentionally returns
    `409 spotify_reauth_required`. (Whether re-consent alone suffices
    without a Spotify dashboard change is unverified in docs — this live
    check is the verification.)

## Deploy + verify

- `npm run deploy` succeeds and lists the cron triggers.
- `curl /healthz` returns `200`.
- `curl /readyz` returns `200` (or, if tokens were rotated, `503` until
  the OAuth dance is re-run).
- If tokens were rotated, re-authorize via `/auth/spotify` and
  `/auth/tidal` and re-check `/readyz`.
- Trigger a manual `/sync/run` and confirm a fresh row in `sync_runs`.

For first-time setup, skip this file and follow
[`self-hosting.md`](self-hosting.md) instead.
