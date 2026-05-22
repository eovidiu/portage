# portage

Scheduled Cloudflare Worker that syncs Spotify Liked Songs (plus optional extra
playlists) into a Tidal playlist so Roon picks them up natively. Single-tenant,
spec-first, no Roon plugin.

The complete specification is in `docs/` and `openspec/changes/archive/` and is
authoritative. **Implementation MUST follow the specs; deviations require
updating the spec first.**

## Tech Stack

- **Language**: TypeScript
- **Runtime**: Cloudflare Workers (free tier today; see "Free-tier budget" below)
- **Framework**: Hono
- **Database**: Neon Postgres via `@neondatabase/serverless` (the `pg` driver does NOT work in Workers)
- **Tests**: vitest under `@cloudflare/vitest-pool-workers` (full suite runs in a real Workers isolate)
- **Deploy**: wrangler

## Current State

Production-stable. 29 features shipped, all `passing` in `.harness/features.json`.
Cron schedule: `23 7 * * *` and `23 19 * * *` UTC. The UI lives in a separate
repo at [github.com/eovidiu/portage-ui](https://github.com/eovidiu/portage-ui)
and is served from `app.portage.eovidiu.co.uk` via Cloudflare Pages.

## Spec Layout

Two documentation patterns coexist:

- **F-001 through F-018**: legacy `docs/specs/F-NNN-*.md` + matching `T-NNN-*.md`.
  Indexed by [`docs/specs/SPEC_INDEX.md`](docs/specs/SPEC_INDEX.md).
- **F-019 onwards**: OpenSpec change folders under
  [`openspec/changes/archive/<date>-<change-name>/`](openspec/changes/archive/)
  with `proposal.md` + `design.md` + `tasks.md` + `specs/<capability>/spec.md`.

See [`docs/README.md`](docs/README.md) for the full map of which feature lives
where.

Reference `F-NNN` in commit messages and PR descriptions.

## Harness

This project uses the Long-Running Agent Harness v3.5.0.

- `.harness/features.json` — feature tracking with verified `depends_on` graph
- `.harness/context_summary.md` — **READ THIS at session start** (decisions, patterns, gotchas, retrospectives)
- `.harness/claude-progress.txt` — session handoff
- `.harness/init.sh smoke_test|full_test` — build/test runner
- `.claude/hooks/` — quality gates: scope enforcement, git identity check, TaskCompleted test gate, TeammateIdle next-feature picker, PostCompact context recovery

## Git Identity

This project uses: **Ovidiu Eftimie <eovidiu@gmail.com>** with SSH key `~/.ssh/id_ed25519`
(host `github.com`, GitHub user `eovidiu`). Remote: `git@github.com:eovidiu/portage.git`.

The `verify-git-identity.sh` hook blocks `git push/pull/clone/fetch` if the
active identity doesn't match `.harness/harness.json`.

## CI / Deploy

- `.github/workflows/ci.yml` — runs on every PR: typecheck, full test suite, `npm audit --omit=dev --audit-level=high`, gitleaks
- Deploys are operator-driven via `npm run deploy` (wrangler) — there is no
  auto-deploy on merge to main. Capture the Version ID in
  `.harness/context_summary.md` Active Context the same minute you deploy.

## Free-tier budget (operational gotcha)

The Workers free tier caps each cron invocation at **10 ms CPU + 50 subrequests +
30 s wall**. The orchestrator can bump against these limits on busy runs; when
that happens Cloudflare terminates the isolate before any JS catch handler can
record an error code, leaving `sync_runs.status='running'` until the next cron's
`markAbandonedRuns` sweep marks it `'abandoned'` 12 h later.

Mitigation in production: `wrangler.toml` `[vars]` clamps
`MATCH_BATCH_ISRC=2` and `MATCH_BATCH_FUZZY=2` (vs the defaults of 5 each in
`src/sync/orchestrator.ts`). If the Worker is promoted to Paid (CPU 10ms→50ms,
subrequests 50→1000), these clamps can be removed and the defaults take over.

The "Why is this run taking 12 hours?" question is a measurement artifact —
`finished_at - started_at` measures gap between two crons for abandoned rows,
not work time. Real successful runs finish in 2–17 s.

## Pre-deploy checklist

First-time setup, secret generation, OAuth dances, and the first manual sync
are documented in
[`docs/operations/pre-deploy-checklist.md`](docs/operations/pre-deploy-checklist.md).

## Local commands

```bash
npm install              # install deps
npm test                 # full unit suite in Workers isolate
npm run typecheck        # tsc --noEmit
npm run dev              # wrangler dev (local Worker)
npm run deploy           # wrangler deploy (production)
npm run test:integration # tests requiring Node APIs (separate config)
npm run test:e2e         # runs scripts/run-e2e.sh against wrangler dev
```
