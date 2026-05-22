# Pre-deploy verification checklist (Ovidiu only)

This list covers everything that requires your hands — credential portals, upstream API doc audits, Worker secrets, OAuth dance, first manual sync. Walk top-to-bottom; later steps depend on earlier ones.

Phases 1 and 2 are independent — you can do them in parallel. Phase 3 has hard ordering: deploy → OAuth → mint JWT → manual run → wait for cron.

If any step blocks (e.g., Tidal portal scope mismatch), fix the upstream piece before proceeding — don't deploy with known-bad config.

---

## Phase 1 — Source-of-truth audits (no deploys yet)

### Step 1: Verify Spotify Liked Songs endpoint

- File: `src/providers/spotify/liked.ts:20-21`
- Constant: `LIKED_SONGS_URL = "https://api.spotify.com/v1/me/tracks?limit=50"`
- Confirm against: <https://developer.spotify.com/documentation/web-api/reference/get-users-saved-tracks>
- Verify: endpoint path + `limit=50` (max is 50 per Spotify docs as of last training data)
- When correct: remove the `TODO(ovidiu)` comment

### Step 2: Verify Tidal ISRC search endpoint

- File: `src/match/isrc.ts:9-10`
- Constant: `TIDAL_TRACKS_URL = "https://openapi.tidal.com/v2/tracks"`
- Confirm against: <https://developer.tidal.com/reference> (look for ISRC filter param on `/tracks`)
- Verify: URL template + the ISRC filter parameter name (the code passes `?filter[isrc]=...` — confirm that's the correct shape)
- When correct: remove the `TODO(ovidiu)` comment

### Step 3: Verify Tidal fuzzy search endpoint

- File: `src/match/fuzzy.ts:11-12`
- Constant: `TIDAL_SEARCH_BASE = "https://openapi.tidal.com/v2/searchresults"`
- Code constructs: `GET {base}/{encodeURIComponent(query)}/relationships/tracks?countryCode={CC}&include=tracks&limit=5`
- Confirm against: Tidal Open API v2 search docs
- Verify: URL pattern, query encoding, `relationships/tracks` path, query params
- When correct: remove the `TODO(ovidiu)` comment

### Step 4: Verify Tidal playlist endpoints

- File: `src/providers/tidal/playlist-endpoints.ts:5-6`
- Constants: `TIDAL_PLAYLISTS_URL = "https://openapi.tidal.com/v2/playlists"` plus the create/get/add-tracks payload shapes used in `playlist.ts`
- Confirm against: Tidal Open API v2 playlist docs
- Verify: create-playlist body (`type: "playlists"`, `attributes.name`, `attributes.description`, `attributes.privacy`); add-tracks body shape; `users/{userId}/relationships/playlists` linking call
- When correct: remove the `TODO(ovidiu)` comment

### Step 5: Verify Tidal track-by-id endpoint (manual match)

- File: `src/routes/unmatched.ts:10-11`
- Constant: `TIDAL_TRACKS_BASE = "https://openapi.tidal.com/v2/tracks"`
- Used as `${TIDAL_TRACKS_BASE}/${tidal_id}` to verify a manually-supplied tidal_id resolves before the I-001 atomic move
- Confirm: same as Step 2 but for the per-id GET path
- When correct: remove the `TODO(ovidiu)` comment

### Step 6: Verify Tidal app scopes

- File: `src/providers/tidal/scopes.ts`
- Cross-check: log into <https://developer.tidal.com> → your portage app → confirm the OAuth scope list there matches the constant in this file
- This blocks Step 14 (first OAuth) if mismatched

---

## Phase 2 — Production secrets & dev-portal config

### Step 7: Generate `JWT_SECRET` (32+ bytes, hex)

```
openssl rand -hex 48
```

Save the value somewhere safe (1Password / similar). Don't commit it anywhere.

### Step 8: Generate `TOKEN_ENCRYPTION_KEY` (32 bytes, base64-encoded)

```
openssl rand -base64 32
```

Same — save securely, don't commit.

### Step 9: Set Worker secrets via wrangler

```
cd /Users/fameftimie/work/portage
wrangler secret put JWT_SECRET                # paste Step 7 value
wrangler secret put TOKEN_ENCRYPTION_KEY      # paste Step 8 value
wrangler secret put SPOTIFY_CLIENT_ID         # from .env
wrangler secret put SPOTIFY_CLIENT_SECRET     # from .env
wrangler secret put TIDAL_CLIENT_ID           # from .env
wrangler secret put TIDAL_CLIENT_SECRET       # from .env
wrangler secret put DATABASE_URL              # Neon pooled connection string
```

Plus the non-secret env vars (in `wrangler.toml` `[vars]`): `SPOTIFY_REDIRECT_URI`, `TIDAL_REDIRECT_URI`, `TIDAL_COUNTRY_CODE`, `TIDAL_PLAYLIST_TITLE`. Confirm `wrangler secret list` shows all 7 secrets after.

### Step 10: Configure Spotify OAuth redirect URI

- <https://developer.spotify.com/dashboard> → your portage app → Settings → Redirect URIs
- Add: `https://portage.eovidiu.co.uk/auth/spotify/callback`
- Save

### Step 11: Configure Tidal OAuth redirect URI

- <https://developer.tidal.com> → your portage app → settings
- Add: `https://portage.eovidiu.co.uk/auth/tidal/callback`
- Save

---

## Phase 3 — Deploy & first run

### Step 12: Deploy the Worker

```
cd /Users/fameftimie/work/portage
wrangler deploy
```

Confirm output shows the Worker uploaded with the cron triggers (`23 7 * * *`, `23 19 * * *`).

### Step 13: Smoke-test deployed Worker

```
curl -s https://portage.eovidiu.co.uk/healthz | jq
curl -s https://portage.eovidiu.co.uk/readyz  | jq
```

- `/healthz` → 200 with `{status: "ok"}`-shaped body
- `/readyz` → 503 expected here (no provider tokens persisted yet)

### Step 14: Authorize Spotify

- Open in browser: `https://portage.eovidiu.co.uk/auth/spotify`
- Complete the Spotify consent flow → should land on `/auth/spotify/callback?code=...`
- Worker decrypts, persists, redirects (or returns success body)
- Verify in Neon: `SELECT provider, status, expires_at FROM provider_tokens WHERE provider='spotify';` → one row, `status='active'`, non-null ciphertext

### Step 15: Authorize Tidal

- Open in browser: `https://portage.eovidiu.co.uk/auth/tidal`
- Same flow as Step 14 for Tidal
- Verify in Neon: same query for `provider='tidal'`

### Step 16: Re-check `/readyz`

- Should now return 200 with `{status: "ok", checks: {db: ok, spotify: ok, tidal: ok}}`-shaped body
- If still 503, inspect the response — it lists which provider failed

### Step 17: Mint bootstrap JWT

```
cd /Users/fameftimie/work/portage
JWT_SECRET="<value from Step 7>" \
  npx tsx scripts/mint-bootstrap-token.ts
```

Save the printed JWT in 1Password as "Portage owner token". You'll use it for every authenticated API call.

### Step 18: Manual sync trigger

```
curl -s -X POST https://portage.eovidiu.co.uk/sync/run \
  -H "Authorization: Bearer <JWT from Step 17>" | jq
```

Possible outcomes:

- `200` with counts → first run succeeded; verify in Neon: `SELECT * FROM sync_runs ORDER BY started_at DESC LIMIT 1;`
- `202 {run_id, status: "running"}` → still running past 25s; check status with `curl https://portage.eovidiu.co.uk/sync/status -H "Authorization: ..."`
- `409 {error: "run_in_progress", current_run_id}` → wait + retry
- Anything else → check `wrangler tail` for structured log lines

### Step 19: Verify the Tidal playlist exists

- Open Tidal → check that "Spotify Liked" playlist now exists with the matched tracks
- If empty → check `sync_runs.unmatched` count — likely fuzzy-fallback misses on small ISRC overlap

### Step 20: Wait for the first cron fire (or verify in CF dashboard)

- Crons fire at 07:23 + 19:23 UTC
- Bucharest time (UTC+3 in summer / UTC+2 in winter) = 10:23 + 22:23 in summer; 09:23 + 21:23 in winter
- After the first auto-fire, verify a second `sync_runs` row appeared with `started_at` matching the cron time
