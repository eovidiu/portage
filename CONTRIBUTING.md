# Contributing to portage

Thanks for considering a contribution. portage is a single-maintainer
project; PRs are welcome but reviewed when I have time. Please don't be
discouraged if responses take a few days.

## Issues

Open an issue if you've hit a real bug, are stuck on something the
documentation didn't explain, or want to discuss a feature before writing
code. There are no formal issue templates yet — a short summary plus
reproduction steps (or, for setup issues, the section of the self-hosting
guide that confused you) is plenty.

For security reports, follow [`SECURITY.md`](SECURITY.md) instead of opening
a public issue.

## Pull requests

A few things will make a PR much easier to merge:

- **Tests for new behaviour.** The full suite runs under
  `@cloudflare/vitest-pool-workers` in a real Workers isolate. `npm test`
  must pass. New code should come with vitest tests in the matching
  `tests/...` directory.
- **Typecheck.** `npm run typecheck` must pass.
- **Ground external-API code against the canonical specs.** For Tidal, the
  generated types at `src/providers/tidal/openapi-types.ts` come from
  <https://tidal-music.github.io/tidal-api-reference/tidal-api-oas.json>
  (regenerate via `npm run gen:tidal-types`). For Spotify, work from the
  official reference at
  <https://developer.spotify.com/documentation/web-api>. Do not invent API
  shapes from memory.
- **Stay inside the coding-standards envelope:** functions ≤ 100 lines,
  cyclomatic complexity ≤ 8, ≤ 5 positional parameters, no dead code, no
  commented-out blocks. See [`CLAUDE.md`](CLAUDE.md) for the working
  coding-standards reference.

## Commit messages

Follow the existing convention:

- `feat:` — new behaviour
- `fix:` — bug fix
- `chore:` — tooling, dependencies, config
- `docs:` — documentation only
- `refactor:` — code change with no behaviour change

Reference the feature ID (`F-NNN`) in the subject or body when the change
maps to a spec. Example: `feat(F-024): Tidal catalog manual-search route`.

## Spec changes

portage is spec-first. If a change alters observable behaviour, the matching
spec needs to move with the code:

- For features F-001 through F-018, the spec lives at
  `docs/specs/F-NNN-*.md` with a paired `T-NNN-*.md` test spec.
- For features F-019 onwards, propose the change as an OpenSpec change
  folder under `openspec/changes/<date>-<change-name>/`. The pattern is
  visible in any archived change at `openspec/changes/archive/`.

For trivial fixes (typo, dependency bump, internal refactor with no
behaviour change), no spec update is needed.

## What's gitignored and why

`.harness/` and `.claude/` are intentionally gitignored. They hold the
maintainer's local long-running-agent state and per-developer Claude Code
hooks; they're not part of the public project. If you fork and run your own
harness, your local `.harness/` stays on your machine.

`wrangler.toml` is gitignored; the template lives at `wrangler.toml.example`.
Same for `.dev.vars` (template at `.dev.vars.example`).

## Code of conduct

Be civil. Disagreements happen; insults don't. I reserve the right to close
threads that stop being productive.
