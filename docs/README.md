# portage — documentation index

This directory holds the canonical architecture, spec set, and operator
runbooks for the Spotify → Tidal sync Worker. The repository was specified
before any code existed; implementation follows these documents and any
deviation requires updating the spec first.

## Start here

If you're new to the project:

- [`../README.md`](../README.md) — what portage is, who it's for, what it
  does and doesn't do.
- [`operations/self-hosting.md`](operations/self-hosting.md) — canonical
  end-to-end walkthrough for running your own portage instance.
- [`../SECURITY.md`](../SECURITY.md) — how to report a vulnerability and
  what the threat model looks like.
- [`../CONTRIBUTING.md`](../CONTRIBUTING.md) — how to file issues, send
  PRs, and what the coding-standards envelope is.

## Architecture and specs

- [`architecture.md`](architecture.md) — system architecture, domain model,
  invariants (I-001..I-005), ADRs, NFRs, security model.
- [`specs/F-NNN-*.md`](specs/) — legacy feature specifications **for F-001
  through F-018 only**. Each pairs with a matching `T-NNN-*.md` test spec.
- [`specs/SPEC_INDEX.md`](specs/SPEC_INDEX.md) — index of the legacy
  F-001..F-018 specs.

## Operations

- [`operations/self-hosting.md`](operations/self-hosting.md) — fresh-deploy
  walkthrough (start here for any first-time setup).
- [`operations/pre-deploy-checklist.md`](operations/pre-deploy-checklist.md)
  — slim companion checklist for re-deploys of a known-good setup.

## Security review notes

- [`security/`](security/) — periodic security review notes (pen-tests,
  threat-model deltas).

## Where to find specs for F-019 and later

Features **from F-019 onwards** were authored via the OpenSpec workflow
rather than the legacy `docs/specs/F-NNN-*.md` pattern. Their full
proposal + design + spec deltas + task lists live under:

```
openspec/changes/archive/<YYYY-MM-DD>-<change-name>/
  proposal.md           — why the change exists
  design.md             — decisions, trade-offs, risks
  tasks.md              — implementation checklist
  specs/<capability>/spec.md  — ADDED / MODIFIED requirements with scenarios
```

Shipped OpenSpec features at time of writing:

| Feature | Capability | Archive path |
|---|---|---|
| F-019 | CF Access JWT middleware | `openspec/changes/archive/2026-05-16-portage-ui-foundation/specs/cf-access-auth/` |
| F-020 | `GET /api/me` | included with portage-ui-foundation change |
| F-021 | `GET /api/playlists` | included with portage-ui-foundation change |
| F-022 | `POST /api/playlists` | included with portage-ui-foundation change |
| F-023 | Silent-abandon orchestrator catch | (predates archive workflow) |
| F-024 | Manual Tidal catalog search | `openspec/changes/archive/2026-05-15-f-024-tidal-catalog-search/` |
| F-025 | Rematch heuristic sweep | `openspec/changes/archive/2026-05-16-f-025-rematch-heuristic/` |
| F-026, F-026a, F-026b | Playlist toggle + enabled column | `openspec/changes/archive/2026-05-17-playlists-table-and-toggle/` |
| F-027 | Per-run track manifest | `openspec/changes/archive/2026-05-17-per-run-track-detail/` |
| F-027a | Persisted fuzzy candidates + manual-match `sync_run_id` | `openspec/changes/archive/2026-05-17-pick-from-fuzzy-candidates/` |
| F-028 | Flexible fuzzy matching algorithm | `openspec/changes/archive/2026-07-12-flexible-fuzzy-matching/` |
| F-029 | ntfy push notifications for sync runs | `openspec/changes/archive/2026-07-12-f-029-ntfy-notifications/` |

If you're looking for the spec for any feature ≥ F-019, search
`openspec/changes/archive/` rather than `docs/specs/`.

## Why two layouts coexist

F-001..F-018 predate the project's adoption of OpenSpec, so their legacy
`docs/specs/F-NNN-*.md` + matching `T-NNN-*.md` files remain authoritative.
Re-platforming the early specs into OpenSpec was deliberately skipped —
they're stable, shipped, and have no in-flight changes. New work uses
OpenSpec exclusively; we'll only revisit a legacy spec if a substantive
change is proposed against it (in which case the change will be authored
as an OpenSpec `MODIFIED Requirements` delta).
