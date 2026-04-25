# spotify-roon-sync

Scheduled Cloudflare Worker that syncs Spotify Liked Songs into a Tidal playlist so Roon picks them up natively. Single-tenant, spec-first, no Roon plugin.

The complete specification is in `docs/` and is authoritative. **Implementation MUST follow the specs; deviations require updating the spec first.**

## Tech Stack

- **Language**: TypeScript
- **Runtime**: Cloudflare Workers
- **Framework**: Hono
- **Database**: Neon Postgres via `@neondatabase/serverless` (the `pg` driver does NOT work in Workers)
- **Tests**: vitest (95% coverage gate on touched code)
- **Deploy**: wrangler

## Spec Layout

- `docs/architecture.md` — system architecture, domain model, invariants (I-001..I-005), ADRs, NFRs, security model
- `docs/specs/F-NNN-*.md` — 14 feature specifications (F-001..F-014)
- `docs/specs/T-NNN-*.md` — corresponding test specifications
- `docs/specs/SPEC_INDEX.md` and `docs/README.md` — spec indexes (note: their internal links reference `docs/features/` and `docs/tests/` but the actual layout is flat under `docs/specs/`)

Reference `F-NNN` in commit messages and PR descriptions.

## Harness

This project uses the Long-Running Agent Harness v3.5.0.

- `.harness/features.json` — feature tracking with verified `depends_on` graph
- `.harness/context_summary.md` — **READ THIS at session start** (decisions, patterns, gotchas)
- `.harness/claude-progress.txt` — session handoff
- `.harness/init.sh smoke_test|full_test` — build/test runner
- `.claude/hooks/` — quality gates: scope enforcement, git identity check, TaskCompleted test gate, TeammateIdle next-feature picker, PostCompact context recovery

## Git Identity

This project uses: **Ovidiu Eftimie <eovidiu@gmail.com>** with SSH key `~/.ssh/id_ed25519` (host `github.com`, GitHub user `eovidiu`).

The `verify-git-identity.sh` hook blocks `git push/pull/clone/fetch` if the active identity doesn't match `.harness/harness.json`. No remote is configured yet.

## First-Feature Recommendations

Two features have zero dependencies and can ship in parallel:
- **F014** — `/healthz` (then `/readyz` incrementally as providers ship)
- **F004** — Token encryption helper (AES-256-GCM via Web Crypto)

After F004 + F001 land, F002 (Spotify OAuth) and F003 (Tidal OAuth) can also run in parallel.

## Bootstrap-Cycle Gotchas (read before planning)

The spec has two soft-dep cycles that `features.json` resolves by recording hard blockers only. See `.harness/context_summary.md` Gotchas section for the resolution patterns:
- F-001 ↔ F-014 (auth ↔ health)
- F-009 ↔ F-011 (orchestrator ↔ logging)
