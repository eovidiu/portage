# Self-hosting portage

This is the canonical end-to-end walkthrough for running your own portage
instance. Allow roughly an hour for a first deploy. Steps are ordered:
prerequisites and external-portal config first, then secrets, then deploy,
then OAuth, then the first sync.

If a step blocks (e.g., Tidal portal scope mismatch), fix the upstream piece
before moving on — don't deploy with known-bad config.

## 1. Prerequisites

Accounts and subscriptions you'll need:

- **GitHub account** — to clone the repo.
- **Cloudflare account** — free tier works for getting started. Workers Paid
  ($5/month) lifts the per-invocation CPU + subrequest budget and lets you
  drain large libraries faster (see "Cron schedule and free-tier budget"
  below).
- **Neon account** — free tier is fine (0.5 GB storage, 191.9 compute-hours
  per month).
- **Spotify Premium account** — Spotify requires the owner of a developer
  app to have Premium. You'll register a Dev Mode app under this account.
- **Tidal subscription** in a region supported by the Tidal Open API. Used
  to register a developer app and to host the destination playlist.
- **Roon** (optional but the whole reason this exists) — configured with
  your Tidal account, so the synced playlist is picked up natively.

Local tools:

- **Node.js 20 or newer** and **npm**.
- The **`wrangler` CLI** (installed automatically by `npm install` in this
  repo; you can also `npm install -g wrangler`).
- **`openssl`** for generating encryption keys.
- **`psql`** or the Neon SQL editor for applying the schema.

## 2. Register a Spotify Dev Mode app

1. Sign in at <https://developer.spotify.com/dashboard>.
2. Click **Create app**. Name it something like "portage (personal)".
3. **Redirect URI**: `https://<your-worker-domain>/auth/spotify/callback`.
   Replace `<your-worker-domain>` with the hostname you intend to bind the
   Worker to (e.g., `portage.example.com`). You can edit this later if the
   domain changes.
4. **APIs/services used**: tick **Web API**.
5. Accept the terms and save.
6. Copy the **Client ID** and **Client Secret** into your password manager.
7. Under **Settings → User Management**, add your own Spotify account email
   as a test user. Dev Mode caps you at 25 users, which is plenty for a
   single operator.

Notes:

- The owner of the app (you) must have Spotify Premium; Spotify enforces this.
- Spotify Extended Quota Mode (the path off Dev Mode) is not viable for
  portage's use case — see the README's "Why this exists" section.

## 3. Register a Tidal developer app

1. Sign in at <https://developer.tidal.com>.
2. Create a new app. Name it similarly.
3. **Redirect URI**: `https://<your-worker-domain>/auth/tidal/callback`.
4. **Scopes**: at minimum, the playlist read/write scopes the orchestrator
   needs. The canonical scope list lives in
   [`src/providers/tidal/scopes.ts`](../../src/providers/tidal/scopes.ts) —
   make the portal selection match that file. If the portal exposes scopes
   the file doesn't list, leave them unticked.
5. Save and copy the **Client ID** and **Client Secret**.

Pick the **country code** matching your Tidal subscription (two-letter
ISO 3166-1 alpha-2, e.g., `US`, `GB`, `DE`, `RO`). You'll set this as
`TIDAL_COUNTRY_CODE` in step 5.

## 4. Provision Neon Postgres

1. Sign up at <https://neon.tech> (or log in).
2. Create a new project. Any region is fine; choose one close to your
   Cloudflare edge if you care about latency.
3. From the project dashboard, copy the **pooled connection string**. It
   looks like
   `postgres://<user>:<password>@<host>-pooler.neon.tech/<db>?sslmode=require`.
   This is what you'll set as `DATABASE_URL`.
4. Apply the schema. The source of truth is
   [`db/schema.sql`](../../db/schema.sql). Either:
   - Use the Neon SQL editor (Dashboard → SQL Editor → paste + run), or
   - Use `psql`:

     ```bash
     psql "<your DATABASE_URL>" -f db/schema.sql
     ```

   The file is idempotent (`CREATE TABLE IF NOT EXISTS` throughout), so
   re-running it on an existing schema is safe.

## 5. Clone and configure

```bash
git clone https://github.com/eovidiu/portage.git
cd portage
npm install
cp wrangler.toml.example wrangler.toml
cp .dev.vars.example .dev.vars
```

Edit `wrangler.toml` and fill in:

- `account_id` — your Cloudflare account UUID (Dashboard → top right →
  **Copy account ID**).
- `routes` — set `pattern` to the hostname you want the Worker bound to
  (e.g., `portage.example.com`). The domain must already exist in your
  Cloudflare account; `custom_domain = true` then provisions the DNS and
  SSL automatically.
- `TIDAL_COUNTRY_CODE` — your country code from step 3.
- `TIDAL_PLAYLIST_TITLE` — name of the Tidal playlist to create on first
  sync. Default is `Spotify Liked`.
- `SPOTIFY_REDIRECT_URI` and `TIDAL_REDIRECT_URI` — replace
  `<YOUR_WORKER_DOMAIN>` with your hostname; both must exactly match what
  you registered in steps 2 and 3.
- `OPERATOR_EMAIL` — your email. This is the only email allowed past the
  Cloudflare Access JWT check (step 11). Without Cloudflare Access in
  front, this value is unused but should still be set to a real value.
- `UI_ORIGIN` — if you plan to run the [portage-ui](https://github.com/eovidiu/portage-ui)
  companion SPA, set this to its origin (e.g., `https://app.portage.example.com`).
  Otherwise set it to a placeholder like `https://example.com`.
- `CF_ACCESS_TEAM` and `CF_ACCESS_AUD` — only relevant if you enable
  Cloudflare Access (step 11). You can fill them in later.

Edit `.dev.vars` with the same values, plus the secrets — `.dev.vars` is
read by `wrangler dev` for local development. It is gitignored and must
never be committed.

## 6. Generate secrets and set them via wrangler

Generate the two long-lived secrets:

```bash
# JWT_SECRET — used to sign the operator's Bearer JWT. 32+ bytes, hex.
openssl rand -hex 48

# TOKEN_ENCRYPTION_KEY — used to AES-GCM-encrypt Spotify/Tidal refresh
# tokens at rest in Neon. 32 bytes, base64-encoded.
openssl rand -base64 32
```

Save both in your password manager. You'll need them again only if you
rotate or re-deploy from scratch.

Then push every secret into the Worker via `wrangler secret put`. Each
command prompts for the value:

```bash
wrangler secret put JWT_SECRET              # paste the openssl rand -hex 48 output
wrangler secret put TOKEN_ENCRYPTION_KEY    # paste the openssl rand -base64 32 output
wrangler secret put DATABASE_URL            # the Neon pooled connection string
wrangler secret put SPOTIFY_CLIENT_ID
wrangler secret put SPOTIFY_CLIENT_SECRET
wrangler secret put TIDAL_CLIENT_ID
wrangler secret put TIDAL_CLIENT_SECRET
```

Confirm all seven are set:

```bash
wrangler secret list
```

The remaining variables (`TIDAL_COUNTRY_CODE`, `TIDAL_PLAYLIST_TITLE`,
`SPOTIFY_REDIRECT_URI`, `TIDAL_REDIRECT_URI`, `OPERATOR_EMAIL`,
`UI_ORIGIN`, `MATCH_BATCH_*`) are non-secret and live in `wrangler.toml`
under `[vars]` — wrangler picks them up at deploy.

## 7. Deploy the Worker

```bash
npm run deploy
```

The output lists the cron triggers being installed (`23 7 * * *` and
`23 19 * * *`). Verify the Worker is up by hitting its health endpoints:

```bash
curl -s https://<your-worker-domain>/healthz | jq
# → 200 {"status":"ok"}

curl -s https://<your-worker-domain>/readyz | jq
# → 503 expected here: no provider tokens persisted yet. The response body
#   tells you which check failed.
```

If `/healthz` returns anything other than `200`, check `wrangler tail` for
the structured error log.

## 8. First OAuth dance

Mint the initial Spotify token by visiting the authorize endpoint in your
browser:

```text
https://<your-worker-domain>/auth/spotify
```

You'll be redirected to Spotify's consent page. Approve, and the callback
exchanges the code and persists the encrypted token. A successful response
body looks like `{"status":"connected","provider":"spotify"}`.

Repeat for Tidal:

```text
https://<your-worker-domain>/auth/tidal
```

Verify both tokens landed in Neon:

```sql
SELECT provider, status, expires_at FROM provider_tokens
 WHERE provider IN ('spotify','tidal');
```

You should see two rows, both `status='active'`, with non-null ciphertext
columns.

Re-check `/readyz` — it should now return `200`:

```bash
curl -s https://<your-worker-domain>/readyz | jq
# → 200 {"status":"ready","database":true,"secrets":{...},"tokens":{"spotify":"active","tidal":"active"}}
```

## 9. First sync

The `/sync/run` endpoint requires authentication. The simplest path for a
one-off manual trigger is to mint a Bearer JWT signed by `JWT_SECRET`:

```bash
JWT_SECRET="<value from step 6>" npx tsx scripts/mint-bootstrap-token.ts
```

The first invocation of `npx tsx` may prompt to install `tsx@4.x` —
accept it. `tsx` is not a project dependency because the bootstrap
token mint is a one-off setup step, not part of the runtime.

Save the printed JWT in your password manager. Then trigger a sync:

```bash
curl -s -X POST https://<your-worker-domain>/sync/run \
  -H "Authorization: Bearer <JWT>" \
  -H "Content-Type: application/json" \
  -d '{}' | jq
```

Possible outcomes:

- `200` with counts → the sync finished inside the 25 s request budget.
  Check the body for `tracks_seen`, `matched_isrc`, `matched_fuzzy`,
  `unmatched`, `errors`.
- `202 {"run_id":"...","status":"running"}` → still in progress past 25 s;
  the orchestrator continues in the background. Poll
  `GET /sync/status` (same auth) to follow it.
- `409 {"error":"run_in_progress","current_run_id":"..."}` → another run is
  already going. Wait and retry.
- Anything else → run `wrangler tail` and check the structured logs.

Verify the run landed in Neon:

```sql
SELECT * FROM sync_runs ORDER BY started_at DESC LIMIT 1;
```

Open Tidal and look for the "Spotify Liked" playlist (or whatever you
configured as `TIDAL_PLAYLIST_TITLE`). It should be populated with the
matched tracks. If it's empty, check `sync_runs.unmatched` — a small ISRC
overlap on a fresh deployment is normal; the fuzzy-fallback pass picks up
the rest over subsequent cron runs.

## 10. Optional: portage-ui

The [portage-ui](https://github.com/eovidiu/portage-ui) repo holds a small
SPA for browsing sync runs, inspecting unmatched tracks, and picking among
fuzzy candidates from a browser. It deploys to Cloudflare Pages, talks to
the Worker over the API routes (`/api/me`, `/api/playlists`,
`/sync/runs`, `/unmatched/*`), and authenticates via the same Cloudflare
Access setup described below.

Setup instructions live in that repo's README. The two pieces that need to
agree between the Worker and the UI:

- `UI_ORIGIN` on the Worker side must equal the Pages deployment's origin.
- Both must sit behind the same Cloudflare Access application (same
  `CF_ACCESS_AUD`).

The UI is optional. Skip this section if you only need the playlist to
appear in Roon — the cron handles that without any UI.

## 11. Optional: Cloudflare Access (recommended)

For any production deployment, putting the Worker behind Cloudflare Access
is the recommended hardening posture. Access enforces Sign-in-with-Google
(or any other identity provider you configure) at Cloudflare's edge, so the
Worker only ever sees authenticated requests from your email.

Outline:

1. In the Cloudflare dashboard, navigate to **Zero Trust → Access →
   Applications**.
2. Add a **Self-hosted** application for your worker hostname (e.g.,
   `portage.example.com`).
3. Configure Sign-in-with-Google as the identity provider.
4. Create an access policy that allows only your `OPERATOR_EMAIL`.
5. Copy the **Application Audience (AUD) tag** from the application's
   settings page into `CF_ACCESS_AUD` in `wrangler.toml`.
6. Set `CF_ACCESS_TEAM` to your team name (the subdomain in your
   `<team>.cloudflareaccess.com` URL).
7. Re-deploy: `npm run deploy`.

The Worker's `cfAccessMiddleware` then validates every incoming request's
`Cf-Access-Jwt-Assertion` header against the team's JWKS. The full
contract is documented in
[`openspec/specs/cf-access-auth/spec.md`](../../openspec/specs/cf-access-auth/spec.md).

The Bearer JWT path (step 9) continues to work for service callers and the
cron, so you don't need to re-mint anything when you enable Access.

## 12. Cron schedule and free-tier budget

`wrangler.toml` ships with two daily cron triggers:

```toml
[triggers]
crons = ["23 7 * * *", "23 19 * * *"]
```

That's 07:23 and 19:23 UTC — adjust to taste. Twice a day is a good
trade-off between freshness and free-tier headroom.

The Workers free tier caps each cron invocation at **10 ms CPU,
50 subrequests, and 30 s wall-clock**. The orchestrator can bump against
these limits on busy runs; when it does, Cloudflare terminates the isolate
before any JS catch handler can record an error code, leaving the run row
at `status='running'` until the next cron's `markAbandonedRuns` sweep
marks it `'abandoned'` 12 hours later.

The shipped `wrangler.toml.example` mitigates by clamping
`MATCH_BATCH_ISRC=2` and `MATCH_BATCH_FUZZY=2` (the defaults in
[`src/sync/orchestrator.ts`](../../src/sync/orchestrator.ts) are 5 each).
The queue drains more slowly but every run completes. If you upgrade to
Workers Paid (CPU 10 ms → 50 ms, subrequests 50 → 1000), remove these
`[vars]` entries and the defaults take over.

## 13. Troubleshooting

**`/sync/run` returns `spotify_reauth_required` or `tidal_reauth_required`.**
The provider revoked the refresh token (commonly happens if you change the
app's redirect URI or scopes, or if Spotify/Tidal age out long-idle
tokens). Re-run the OAuth dance from step 8 for the affected provider.

**`/readyz` shows `tokens.spotify == "revoked"`.** Same fix: re-authorize
via `/auth/spotify`.

**A run shows `status='running'` for hours.** The Worker hit the free-tier
budget and was terminated. The next cron's `markAbandonedRuns` sweep will
flip the row to `'abandoned'` 12 hours after `started_at`. The
`finished_at - started_at` gap on those rows is a measurement artefact —
it's the time between two crons, not actual work time. Real successful
runs finish in 2 to 17 seconds. Lower `MATCH_BATCH_ISRC` /
`MATCH_BATCH_FUZZY`, or upgrade to Workers Paid.

**Cloudflare Access redirects loop or 403.** Your `OPERATOR_EMAIL` doesn't
match the email Google sent through Access. Check the email claim in the
Cloudflare Access logs (Zero Trust → Logs → Access) and update
`OPERATOR_EMAIL` to match exactly.

**Tidal calls return 400/415 with JSON:API errors.** Tidal's Open API v2
has shipped breaking changes before. Regenerate the typed client (`npm run
gen:tidal-types`) against the current spec and look for diffs. If the spec
itself has moved, file an issue.

**Spotify Liked Songs endpoint returns 401 after working previously.** Same
as the reauth flow — Spotify revoked the token. Re-authorize.

**`npm test` fails locally with Workers-runtime errors.** Check that you're
on Node 20+ and that `npm install` completed successfully. The test pool
runs in a real Workers isolate and is picky about local Node version.

## 14. Updating

```bash
git pull
npm install
npm run deploy
```

The schema is forward-only: re-applying [`db/schema.sql`](../../db/schema.sql)
is always safe because every `CREATE TABLE` and `CREATE INDEX` uses
`IF NOT EXISTS` and every `ALTER TABLE ... ADD COLUMN` uses
`IF NOT EXISTS`. After pulling an update, re-apply the schema file before
deploying if the release notes mention schema changes.

Check `wrangler.toml.example` against your local `wrangler.toml` after each
pull — if a release added a new `[vars]` entry, the example file is the
canonical reference.

## 15. Uninstalling

If you want to tear it all down:

1. Disable the cron — remove or comment out the `[triggers]` block in
   `wrangler.toml`, then `npm run deploy` once.
2. Delete the Worker — Cloudflare dashboard → **Workers & Pages** → your
   worker → **Manage → Delete**.
3. Delete the Neon project — Neon dashboard → project settings →
   **Delete project**. (This removes all sync history and encrypted
   tokens.)
4. Revoke the app's Spotify access — <https://www.spotify.com/account/apps>
   → find "portage (personal)" → **Remove access**.
5. Revoke the app's Tidal access — sign in at <https://tidal.com> →
   account settings → connected apps.
6. Optionally, delete the developer apps themselves at
   <https://developer.spotify.com/dashboard> and
   <https://developer.tidal.com>.

Nothing portage stores survives steps 2 and 3.
