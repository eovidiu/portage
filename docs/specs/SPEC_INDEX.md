# spotify-roon-sync

A scheduled service that syncs Spotify Liked Songs into a Tidal playlist so Roon picks them up natively.

## Document set

This repository contains the complete specification before any code exists. Implementation MUST follow these documents; deviations require updating the spec first.

### Architecture

- [`docs/architecture.md`](docs/architecture.md): system architecture, component responsibilities, data model, deployment topology, ADRs

### Feature specifications

Each feature is self-contained, implementable without clarification.

| ID | Title |
|----|-------|
| [F-001](F-001-authentication.md) | API authentication (JWT) |
| [F-002](F-002-spotify-oauth.md) | Spotify OAuth integration |
| [F-003](F-003-tidal-oauth.md) | Tidal OAuth integration |
| [F-004](F-004-token-encryption.md) | OAuth token encryption at rest |
| [F-005](F-005-liked-songs-fetch.md) | Spotify Liked Songs incremental fetch |
| [F-006](F-006-isrc-matching.md) | ISRC-based track matching |
| [F-007](F-007-fuzzy-matching.md) | Fuzzy track matching fallback |
| [F-008](F-008-tidal-playlist-write.md) | Tidal playlist write |
| [F-009](F-009-sync-orchestration.md) | Sync orchestration |
| [F-010](F-010-scheduled-execution.md) | Scheduled execution |
| [F-011](F-011-sync-logging.md) | Sync run logging and metrics |
| [F-012](F-012-unmatched-queue.md) | Unmatched review queue |
| [F-013](docs/specs/retired/F-013-captures-api.md) | Captures API (iOS-ready) [RETIRED 2026-05-26 — see docs/specs/retired/] |
| [F-014](F-014-health-status.md) | Health and status endpoints |

### Test specifications

Each test validates one thing and returns either a boolean or a single numeric metric.

| ID | Covers |
|----|--------|
| [T-001](T-001-authentication.md) | F-001 |
| [T-002](T-002-spotify-oauth.md) | F-002 |
| [T-003](T-003-tidal-oauth.md) | F-003 |
| [T-004](T-004-token-encryption.md) | F-004 |
| [T-005](T-005-liked-songs-fetch.md) | F-005 |
| [T-006](T-006-isrc-matching.md) | F-006 |
| [T-007](T-007-fuzzy-matching.md) | F-007 |
| [T-008](T-008-tidal-playlist-write.md) | F-008 |
| [T-009](T-009-sync-orchestration.md) | F-009 |
| [T-010](T-010-scheduled-execution.md) | F-010 |
| [T-011](T-011-sync-logging.md) | F-011 |
| [T-012](T-012-unmatched-queue.md) | F-012 |
| [T-013](docs/specs/retired/T-013-captures-api.md) | F-013 [RETIRED 2026-05-26 — see docs/specs/retired/] |
| [T-014](T-014-health-status.md) | F-014 |

## Specification conventions

- RFC 2119 language: MUST, MUST NOT, SHOULD, SHOULD NOT, MAY
- Test IDs follow `T-NNN-MM` where NNN matches a feature ID and MM is a sequential test number
- Every test produces exactly one output: a boolean OR a single numeric metric with a defined threshold
- Functional requirements use Given / When / Then where behavior is observable
- Failure modes are documented per feature; no silent failures permitted
