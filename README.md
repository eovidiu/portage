# portage

Sync your Spotify Liked Songs (and optional extra playlists) into a Tidal
playlist on a schedule, so Roon picks them up natively as Tidal content. Runs
as a single Cloudflare Worker against a Neon Postgres instance — no Roon
plugin, no server to babysit.

## What it does

- Pulls your Spotify Liked Songs (and any extra Spotify playlists you list) via
  the official Web API on a 2x-daily cron.
- Matches each track to its Tidal counterpart using ISRC first; falls back to a
  fuzzy title/artist search when ISRC is missing or doesn't resolve.
- Writes confirmed matches into a Tidal playlist (default: "Spotify Liked")
  via the official Tidal Open API v2.
- Persists everything it sees in Neon Postgres so re-runs are cheap and the
  history is queryable. Tracks the API can't auto-match land in an
  `unmatched` queue with the top fuzzy candidates ranked for manual review.
- Ships an optional companion UI ([portage-ui](https://github.com/eovidiu/portage-ui))
  for browsing sync runs and picking among fuzzy candidates from a browser.
- Optionally pushes a notification to an [ntfy](https://ntfy.sh) topic after
  every sync run — quiet on success, high-priority when a run fails, goes
  partial, or a previous run was killed before finishing. Enabled by setting
  the `NTFY_TOPIC` secret; off otherwise.
- Roon, configured with your Tidal account, picks the playlist up natively
  the next time it scans. No Roon-side integration required.

## Who it's for

Roon users with a Tidal subscription who want their Spotify-discovered Liked
Songs flowing into Roon. You should be comfortable with:

- A Cloudflare account and the `wrangler` CLI.
- Reading a small TypeScript Worker if something breaks.
- Doing your own OAuth-app registration on the Spotify and Tidal developer
  portals (more on why below).

If you'd rather pay for a maintained product, see "Alternatives" at the
bottom.

## Architecture

A single Cloudflare Worker (TypeScript + [Hono](https://hono.dev)) runs on a
cron trigger twice a day. State lives in [Neon Postgres](https://neon.tech),
accessed via `@neondatabase/serverless` (the `pg` driver doesn't work in
Workers). The Worker talks to Spotify's Web API and Tidal's Open API v2 over
their official OAuth flows; refresh tokens are encrypted at rest with
AES-GCM. An optional SPA (the `portage-ui` repo) runs on Cloudflare Pages and
authenticates browser users via Cloudflare Access with Sign-in-with-Google.

## Quick start

Roughly an hour, end-to-end. Each step is detailed in
[`docs/operations/self-hosting.md`](docs/operations/self-hosting.md).

1. Register a Spotify Dev Mode app and a Tidal developer app.
2. Provision a Neon Postgres project and apply [`db/schema.sql`](db/schema.sql).
3. Clone the repo, `npm install`, copy `wrangler.toml.example` → `wrangler.toml`
   and `.dev.vars.example` → `.dev.vars`, fill in the placeholders.
4. Set Worker secrets with `wrangler secret put` (see the guide).
5. `npm run deploy` and confirm `/healthz` returns `200`.
6. Visit `/auth/spotify` and `/auth/tidal` to mint the initial tokens.
7. Trigger the first sync; verify the playlist appears in Tidal.

## What it does NOT do

- Not multi-tenant. One operator, one Spotify account, one Tidal playlist set.
- Not a hosted SaaS. There is no `portage.example.com` you can sign up for.
- No SLA, no uptime promise, no roadmap commitment.
- No reverse direction (Tidal → Spotify) and no other source/sink providers.
- Not affiliated with Spotify, Tidal, Roon, Cloudflare, or Neon.

## Why this exists (and why it isn't a SaaS)

Spotify tightened the Web API's
[Extended Quota Mode criteria](https://developer.spotify.com/blog/2025-04-15-updating-the-criteria-for-web-api-extended-access)
in May 2025 and again in February 2026. Production access now requires the
application to have 250 000 monthly active users and a use case that
"promotes artists and creator discovery on Spotify." Exporting a user's
library to a competing streaming service is precisely the opposite of what
Spotify is willing to approve. A paid product that did this for strangers
would be stuck in Dev Mode forever, capped at 25 invited test users.

Self-hosting sidesteps the wall entirely. Each user runs the Worker against
their own Spotify Dev Mode app, where the 25-user cap is plenty for a
population of one. The trade-off is operational: you do the OAuth-app
registration yourself, you own the Cloudflare and Neon accounts, you handle
your own re-auths when Spotify or Tidal revoke a token. In exchange, the
mechanism is durable in a way no SaaS can be.

## Limitations and risks

- **Spotify may tighten further.** The criteria have already moved twice in
  twelve months. A third tightening could close Dev Mode access for
  individuals too. Nothing portage can do about that.
- **Tidal Open API churn.** The v2 API is relatively young and has shipped
  breaking changes in living memory (JSON:API content-type migration,
  batch-size validation). Self-hosters may need to pull updates after a
  Tidal-side change.
- **Workers free-tier limits.** Each scheduled invocation gets 10 ms CPU,
  50 subrequests, and 30 s wall-clock. The orchestrator caps match-queue
  batches at 2 per run to stay inside this budget; on the Workers Paid plan
  ($5/month) you can remove the clamp and drain large libraries faster. See
  [`docs/operations/self-hosting.md`](docs/operations/self-hosting.md) for
  details.
- **Neon free tier** is fine for portage's workload (0.5 GB storage, the
  schema is small) but worth knowing about if you intend to push a very
  large playlist library through it.
- **You accept Spotify's and Tidal's terms yourself** when you create the
  developer apps. Your relationship is with them, not with this project.

## License and maintainer posture

MIT — see [`LICENSE`](LICENSE).

portage is a personal project published for fellow Roon users who want
Spotify-sourced playlists in Tidal. There is no support contract, no SLA, and
no roadmap. Issues are triaged best-effort. Pull requests are welcome but
reviewed when I have time — see [`CONTRIBUTING.md`](CONTRIBUTING.md).

For security reports, please follow [`SECURITY.md`](SECURITY.md) rather than
opening a public issue.

## Alternatives

If you need a maintained commercial product (or you'd rather not run a
Worker yourself), look at [Soundiiz](https://soundiiz.com),
[Tune My Music](https://www.tunemymusic.com), or
[FreeYourMusic](https://freeyourmusic.com). All three offer hosted
Spotify → Tidal sync with paid plans and customer support.

## Spec layout

portage was specified before any code was written. Two documentation patterns
coexist:

- F-001 through F-018: legacy `docs/specs/F-NNN-*.md` plus matching
  `T-NNN-*.md`. Indexed in [`docs/specs/SPEC_INDEX.md`](docs/specs/SPEC_INDEX.md).
- F-019 onwards: OpenSpec change folders under
  `openspec/changes/archive/<date>-<change-name>/` with `proposal.md` +
  `design.md` + `tasks.md` + `specs/<capability>/spec.md`.

[`docs/README.md`](docs/README.md) is the canonical doc index.
