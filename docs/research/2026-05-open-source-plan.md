# Open-Sourcing portage: Analysis & Plan

Status: **draft, awaiting Ovidiu's go-ahead**.
Date: 2026-05-22.

## Why this document exists

The SaaS path for portage is closed by Spotify's May 2025 + Feb 2026
developer-terms tightening (`docs/research/` companion piece TK, but the short
version: Extended Quota Mode now requires 250k MAU and a use case Spotify
explicitly approves, and portage's "export library to a competitor" mechanic
is the opposite of what they'll approve). Last.fm doesn't carry a Spotify-likes
signal, so it can't substitute as the source.

That leaves three honest options. This document lays out the chosen one:
publish portage as an open-source, self-hostable project. Each user deploys
their own Worker against their own Spotify Dev Mode app (5-user cap is fine
for a population of one), their own Tidal developer app, their own Neon
project, their own Cloudflare account. No multi-tenancy, no revenue, no SLA.

## Goal & non-goals

**Goal**: a Roon-using stranger with Spotify Premium can clone the repo, follow
a README, and have portage syncing their Liked Songs to a Tidal playlist
inside one hour.

**Explicit non-goals**:

- No multi-tenancy. Stays single-tenant. Anyone wanting SaaS forks and hits
  the same Spotify wall, which is fine.
- No "deploy with one click" button. Cloudflare's deploy-button can't drive
  the Spotify + Tidal OAuth registration the user must do themselves; a
  half-working magic button is worse than a clear manual checklist.
- No docker-compose / local-only mode. Workers don't run as containers;
  `wrangler dev` is the local story.
- No promised support, no SLA, no roadmap commitment. Be honest in the README:
  "personal project published as a courtesy; PRs welcome, issues triaged
  best-effort."
- No active community building. If Roon's forum picks it up, great; if not,
  also fine.

## What we're starting from (audit findings)

Concrete blockers to immediate publication:

1. **No README**. Top of `README.md` is empty.
2. **`wrangler.toml` carries Ovidiu-personal data**: `account_id` (Cloudflare
   account UUID), `routes` (`portage.eovidiu.co.uk`), `SPOTIFY_REDIRECT_URI`
   + `TIDAL_REDIRECT_URI` (same hostname), `CF_ACCESS_TEAM = "eovidiu"`,
   `CF_ACCESS_AUD` (audience hash for the operator's Access app).
3. **`.harness/` contents are inside-baseball**: `harness.json` has
   `git_identity` (name + email + ssh key path), `context_summary.md` is
   ~87 KB of architectural notes including production Version IDs and Neon
   data shape, `claude-progress.txt` is ~38 KB of session handoffs.
   `features.json` (~75 KB) is genuinely interesting reference material.
4. **`.claude/` hooks reference `.harness/harness.json`** for git identity
   checks — if we strip harness, the hooks break for anyone who clones.
5. **Test fixtures contain `eovidiu.co.uk`** strings in ~15+ test files
   (likely as origin/redirect URIs in fixtures). Not secrets, but should be
   replaced with `example.com` or env-driven.
6. **Two existing `.env`-style files**: `.env` (~946 B) and `.dev.vars`
   (~842 B). Both must be `.gitignore`d (need to verify they are).
7. **Git history is small (~30 commits)** and likely clean — gitleaks is
   already wired in CI — but a full-history scan before publication is cheap
   insurance.
8. **`docs/operations/pre-deploy-checklist.md`** is operator-facing and almost
   certainly references the production domain + Ovidiu's setup. Needs
   templating, not just stripping.

Things that are already in good shape:

- `.dev.vars.example` exists — the Workers idiomatic way to document
  required local-dev secrets.
- gitleaks is in CI (`.github/workflows/ci.yml`).
- The codebase is spec-first and well-commented; documentation surface is
  thinner than implementation surface, which is the right way around.
- Tidal-side integration uses the official Open API — no
  reverse-engineered endpoints to scrub.
- Single-tenant is a stated design decision (ADR-005), so we don't need
  to remove tenancy plumbing that doesn't exist.

## Decisions to make

### License

Recommend **MIT**. Three reasons:

1. The Spotify ToS wall is the moat. No one can SaaS-ify a fork of portage
   because Spotify won't let them past Dev Mode. Whatever the license,
   competitive commercial use is structurally impossible.
2. MIT maximizes adoption. Roon community is technically savvy but not
   legally savvy — AGPL would create friction for no upside.
3. If `portage` ever wants to incorporate code from MIT-licensed neighbors
   in the Cloudflare Workers / Hono ecosystem, MIT is compatible by default.

Alternative worth flagging but not recommending: **AGPL-3.0**. Sends a
stronger anti-commercialization signal and forces network-deployed
modifications to be shared. Use only if Ovidiu actively wants to deter forks.
I don't think he does.

### Scope of the public release

Recommend **publish current `main` after two audit commits**:

- **Commit (a) `feat: retire F-013 captures`** — removes the dead
  iOS-companion endpoint + spec, since it would otherwise generate
  "what's this empty section for?" questions in the public repo (Ovidiu
  asked this himself looking at the prod UI on 2026-05-22).
- **Commit (b) `chore: exclude local-dev tooling + strip personal data`** —
  adds README/LICENSE/CONTRIBUTING/SECURITY, scrubs personal data from
  `wrangler.toml`, replaces `eovidiu.co.uk` test fixtures, runs
  `git rm -r --cached .harness/ .claude/`, and adds both to
  `.gitignore`. Per Ovidiu (2026-05-22): "harness is for my local
  development. doesn't need to be part of the open source project."
  Same logic applied to `.claude/` since its hooks are keyed to the
  excluded harness state.

After commit (b), `.harness/` and `.claude/` won't appear in any
**future** commit. They will still be in the 30 existing commits on
`main`. **Open question:** do we also `git filter-repo` to scrub them
from that history (~30 min, rewrites all commit hashes — nothing in
there is *secret* per gitleaks CI, but it's unpolished internal prose:
Claude session handoffs, Sprint retros, production Version IDs)? My
lean: yes — going public is a one-time event and `git log -p` exposing
87 KB of Claude prose isn't the first impression we want. Hash-rewrite
disruption is moot because we're the only consumer of the repo today.

### Support posture

State explicitly in README:

> "portage is a personal project published for fellow Roon users who want
> Spotify-sourced playlists in Tidal. There is no support contract, no SLA,
> and no roadmap. Issues are triaged best-effort. Pull requests are
> welcome but reviewed when I have time. If you need a maintained
> commercial product, look at Soundiiz, Tune My Music, or FreeYourMusic."

This is honest and sets the right expectations. Better than implicit
silence that disappoints.

### Repository location

Stay at `github.com/eovidiu/portage`. No org needed, no rename.

## Risks to acknowledge in the README

These are not blockers to publishing, but readers deserve to know:

1. **Spotify can break self-hosters at any time.** Dev Mode has tightened
   twice in 12 months. A third tightening could brick the Spotify side.
   Mitigation: zero — out of our hands.
2. **Tidal API changes.** Tidal Open API is relatively young (post-2022)
   and has had breaking changes in living memory (JSON:API content-type
   migration, batch-size validation). Self-hosters might need to pull
   updates after Tidal-side changes.
3. **Cloudflare Workers free-tier limits.** Already documented in
   `CLAUDE.md` — the `MATCH_BATCH_*=2` clamp exists for a reason. Users
   with large libraries may need Workers Paid ($5/mo) to drain backfills
   quickly.
4. **Neon free tier.** 0.5 GB storage, 191.9 compute-hours. Fine for
   portage's workload but document it.
5. **Spotify Premium required for the Spotify Dev Mode app to function.**
   Already true for any current portage user — they have to have Premium
   to listen — but worth stating.
6. **Each self-hoster accepts Spotify + Tidal terms themselves.** Not just
   ours to assert. README should link both ToS pages.

## The plan (6 phases)

Each phase is checkpoint-able. Stop after any phase for review.

### Phase 1 — Pre-publication audit (1–2h)

1. Run gitleaks against full history: `gitleaks detect --log-opts="--all"`
2. Verify `.gitignore` covers `.env`, `.dev.vars`, `.wrangler/`, `coverage/`,
   `node_modules/`
3. Search for personal-data leaks across all tracked files:
   `git grep -i "eovidiu\|fameftimie\|dc223a5a0db5a99a0ba194aff0c98c58"`
4. Inventory list of every file that needs touching, save to
   `docs/research/2026-05-audit-checklist.md`
5. Decide finally on license (recommend MIT) and confirm with Ovidiu

**Deliverable**: audit checklist file + license decision.

### Phase 2 — Code & config hygiene (2–3h)

1. **Remove F-013 Captures (dead iOS-companion endpoint).** Delete
   `src/routes/captures.ts`, `src/db/captures.ts`, both captures tests,
   the `captures` table + 2 indices from `db/schema.sql`, and the F-013
   import + `app.route("/", capturesRoute)` line from `src/index.ts`.
   Move `docs/specs/F-013-captures-api.md` +
   `docs/specs/T-013-captures-api.md` to `docs/specs/retired/` and
   update `docs/specs/SPEC_INDEX.md`. Notes: (a) for Ovidiu's prod
   Neon, follow up with a one-off `DROP TABLE captures` after the
   public push — not publication-blocking; (b) portage-ui has a
   matching `Captures` section that must be removed in a parallel PR
   before the public push so `app.portage.eovidiu.co.uk` doesn't render
   a broken section; (c) local-only bookkeeping: mark F-013 retired in
   `.harness/features.json` and update test-count comments in
   `.harness/context_summary.md` — those aren't tracked any more, so
   this is just Ovidiu's local harness state, not part of any commit.
2. Rename current `wrangler.toml` → `wrangler.toml.example`, scrubbed of
   personal data (account_id, eovidiu.co.uk hostnames, CF_ACCESS_TEAM,
   CF_ACCESS_AUD)
3. Add `wrangler.toml` to `.gitignore`
4. Update `.dev.vars.example` to include every variable a self-hoster
   needs to set
5. Replace `eovidiu.co.uk` references in test fixtures with `example.com`
   (**27 test files** per Phase 1 audit, not the ~15 originally
   estimated). Two global find/replaces cover them all: the Spotify and
   Tidal callback URIs.
5a. **Env-var-ize the operator-email allowlist** (new finding from
   Phase 1 audit, 2026-05-26). `src/middleware/cf_access.ts:7`
   hard-codes `"eovidiu@gmail.com"`; promote to `env.OPERATOR_EMAIL`,
   add to `src/env.ts`, update `.dev.vars.example` + the templated
   `wrangler.toml.example`, fix `tests/middleware/cf_access.test.ts`
   fixtures. ~15 min.
5b. **Scrub absolute paths** (3 lines, `fameftimie` macOS username):
   `docs/operations/pre-deploy-checklist.md` (3× `cd /Users/fameftimie/work/portage`)
   and one absolute-path `diff` in
   `openspec/changes/archive/2026-05-15-f-024-tidal-catalog-search/tasks.md:65`.
5c. **Template live OpenSpec specs** that reference `eovidiu`:
   `openspec/specs/api-me/spec.md` and
   `openspec/specs/cf-access-auth/spec.md`. **Leave
   `openspec/changes/archive/**` alone** — historical fidelity, anyone
   reading early-project archives will understand they're snapshots.
6. **Exclude local-dev tooling from public history going forward.** Add
   `.harness/` and `.claude/` to `.gitignore`, then run
   `git rm -r --cached .harness/ .claude/` so the next commit removes
   them from the index. (Files remain on Ovidiu's disk untouched.) Both
   directories are personal-developer environment — `.harness/` is
   long-running-agent state, `.claude/` is per-dev hooks + slash
   commands keyed to that harness. Neither belongs in a project anyone
   else clones. Separate decision: do we also scrub them from the 30
   commits already on `main` (filter-repo, ~30 min, rewrites all commit
   hashes), or just gitignore going forward and accept the historical
   leak? See Open Questions.

**Deliverables**: two commits — (a) `feat: retire F-013 captures (dead
iOS-companion endpoint)` touching code + schema + specs only,
(b) `chore: exclude local-dev tooling + strip personal data` touching
`.gitignore` + `wrangler.toml` + test fixtures + the cached-tracking
removal of `.harness/` and `.claude/`.

### Phase 3 — Documentation (3–4h)

1. **README.md** — what is portage, who is it for, what does it do, what
   does it not do, screenshots/screencast (if I record one), 5-line
   quick-start, link to detailed self-hosting guide
2. **docs/operations/self-hosting.md** — full step-by-step:
   prerequisites → Spotify Dev app → Tidal Dev app → Cloudflare account →
   Neon project → secret setup → DB migration → wrangler deploy → first
   OAuth dance → test sync. Aim for "follow this for 45 min, you're done."
3. **LICENSE** — MIT text with Ovidiu Eftimie copyright
4. **SECURITY.md** — short: "Email <address> with vulnerabilities. No
   bounty program. Response best-effort."
5. **CONTRIBUTING.md** — short: "Issues welcome; PRs reviewed when I have
   time; coding standards in CLAUDE.md; tests required."
6. **Update `docs/operations/pre-deploy-checklist.md`** → template for
   any self-hoster, not just Ovidiu
7. Update `docs/README.md` to reflect the public-facing doc layout

**Deliverable**: a documentation commit (separable from the hygiene commit
per CLAUDE.md `docs:` convention).

### Phase 4 — Clean-room smoke test (3–4h, can defer)

Spin up a clean second Cloudflare account, fresh Neon project, fresh
Spotify + Tidal developer apps. Follow `self-hosting.md` from scratch as
if I'd never seen the codebase. Time it. Document every "huh?" moment
and fix the docs.

This is the highest-value phase and the most-skipped. Recommend not
skipping. The first 5 external users will give us this data anyway — but
they'll give up at the first friction point. Better to find the friction
ourselves.

**Deliverable**: smoke-test log + doc patches.

### Phase 4.5 — History scrub (30 min)

After the smoke test confirms docs and code work end-to-end, rewrite
`main`'s history to remove `.harness/` and `.claude/` from all
historical commits (~32 by the time Phases 2–3 add their two-to-three
commits on top of the existing 30):

```bash
# One-time tool install
pip install git-filter-repo   # or: brew install git-filter-repo

# Rewrite all commits to drop .harness/ and .claude/
git filter-repo --invert-paths --path .harness/ --path .claude/ --force

# Verify the rewrite landed cleanly
git log --all -- .harness/ .claude/   # should be empty
git log --oneline | wc -l             # should still be ~32

# Force-push the rewritten history to the (still-private) remote
git push --force-with-lease origin main
```

Verify on GitHub by opening a few historical commits and confirming
their diffs contain no `.harness/` or `.claude/` files.

**Deliverable**: rewritten `main` on GitHub with zero historical
references to local-dev tooling.

### Phase 5 — Publication (15 min)

1. `gh repo edit eovidiu/portage --visibility public --description "Sync Spotify Liked Songs into a Tidal playlist on a Cloudflare Worker"`
2. Add topics: `cloudflare-workers`, `spotify`, `tidal`, `roon`, `music`,
   `hono`, `typescript`, `self-hosted`
3. Optional: add a social preview image.

**Announcement deferred** (per Ovidiu, 2026-05-22 — "don't bother now").
Repo goes public but quiet. Promotion to the Roon forum / HN / reddit
can happen anytime later when there's appetite.

**Deliverable**: public repo with description + topics.

### Phase 6 — Ongoing posture (perpetual, low-cost)

- Issue templates (bug, question, feature-request) keep triage cheap
- A monthly "do I still care about this?" check-in. Honest answer
  determines whether to keep maintaining or to archive with a note.
- If Spotify breaks self-hosters: post one issue acknowledging it, link
  to whatever migration option exists (e.g., GDPR-export-based fork if
  someone builds one). Don't fight Spotify; it's not winnable.
- No proactive feature work. If a contributor sends a PR for, e.g.,
  Apple Music as a source, review it on its merits.

## Rough total estimate

| Phase | Effort |
|-------|--------|
| 1 Audit | 1–2h |
| 2 Code hygiene | 2–3h (incl. F-013 removal, harness/claude exclusion) |
| 3 Docs | 3–4h |
| 4 Smoke test | 3–4h |
| 4.5 History scrub | 30m |
| 5 Publish | 15m |
| 6 Ongoing | 1h/month at peak, 0h/month steady-state |

**Total to public: ~10.5–14.5h of focused work**, splittable across
3–4 evenings.

## Open questions

_None — all decisions resolved 2026-05-22 → 2026-05-26. Plan is ready
to execute._

### Resolved

- **License** (2026-05-26, Ovidiu): **MIT**. Chosen after the
  scenario-by-scenario walkthrough. Aligns with the recommendation:
  the SaaS-fork protection AGPL would provide is already structurally
  delivered by the Spotify ToS wall, and MIT keeps the
  contributor / embedding / compliance surface friendly.
- **`.harness/` in public repo** (2026-05-22, Ovidiu): excluded
  entirely. "Harness is for my local development. Doesn't need to be
  part of the open source project."
- **History scrub** (2026-05-22, Ovidiu): yes — `git filter-repo`
  `.harness/` + `.claude/` out of the 30 existing commits before going
  public. Added as Phase 4.5.
- **`.claude/` exclusion** (2026-05-22, Ovidiu): yes — same treatment
  as `.harness/`, excluded entirely going forward + scrubbed from
  history. The opsx slash commands + openspec skills are republishable
  separately as standalone skill packages if Ovidiu later decides they
  have value to other Claude Code users; they don't need to live in
  this repo.
- **Phase 4 smoke test** (2026-05-22, Ovidiu): do it. Clean-room deploy
  from a fresh Cloudflare account + Neon project + Spotify/Tidal apps
  before publishing.
- **Announcement** (2026-05-22, Ovidiu): skip for now. Phase 5 reduced
  to visibility flip + topics; Roon forum / HN / reddit posting
  deferred indefinitely.
- **Backstop policy** (2026-05-22, Ovidiu): keep the "best-effort, no
  SLA" stance from README; revisit if/when load warrants. Phase 6
  stays as written.
