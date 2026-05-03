# Phase 1 — Partial-Run Diagnosis (wrangler tail)

**Date:** 2026-05-03
**Window:** 07:20 → 08:54 UTC (94 min)
**Mode:** read-only `wrangler tail portage --format json`
**Raw capture:** `phase1-tail-2026-05-03.jsonl` (20 KB, 498 lines, 6 cron ticks)

## Result

**Inconclusive — no partials fired during the observation window.**

| metric | count |
|---|---|
| Cron ticks captured | 6 (07:31, 07:46, 08:01, 08:16, 08:31, 08:46) |
| `outcome: succeeded` runs | 6 |
| `outcome: partial` runs | 0 |
| `error_code` occurrences in logs | 0 |
| Worker `exceptions[]` | empty for all 6 |
| Tracks matched in window | 55 (29 ISRC + 26 fuzzy) |

DB cross-check: `sync_runs` for 07:20–08:54 UTC matches the tail (6 succeeded, 0 errors).

## Why Phase 1 missed

Today's partial rate (DB-side, full day):
- 5 partials over ~16 hours of operation = **~5–7% of runs**
- A 6-tick window has only ~35% probability of catching one

Last partial before the window: **06:16:01 UTC** (run `fbd36802-5668-4bac-bdf4-041d8b04c705`, errors=1).
First clean run after: **06:31** — and clean has held for **9 consecutive runs / 2h 15min** as of snapshot.

This temporal clustering (3 partials within 06:00–06:30 followed by extended clean periods) suggests partials may be triggered by **specific tracks** in the unmatched-retry queue rather than random Tidal API noise. When that track's retry slot lines up with a cron tick, the run goes partial; otherwise clean.

## Confirmed (independent of partial capture)

The tail did confirm structural facts useful for Phase 2/3 design:
- All 6 runs emit `event: sync_run_completed` with the same JSON envelope as designed in F-009
- `event: playlist_write_completed` shows `errors: 0` consistently — playlist-write path is **not** the source of partials
- Per-track `event: fuzzy_decision` lines emit with full scoring detail — useful for future per-track audit
- Worker `exceptions[]` empty across all runs — no unhandled throws; all errors are caught and counted

## Conclusion

Phase 1 cannot reliably diagnose this issue at the current partial rate. Recommend **proceeding to Phase 2** (persist `error_codes` histogram to `sync_runs` column).

## Recommended next step — Phase 2 spec

**Goal:** persist per-run error-code histogram so any partial run is diagnosable from a single SQL query.

**Change:**
1. `db/schema.sql`: `ALTER TABLE sync_runs ADD COLUMN error_codes JSONB` (additive; no backfill needed; old rows stay null)
2. `src/db/sync_runs.ts`: extend `SyncRunUpdate` type with `error_codes?: Record<string, number>`; include in update SQL
3. `src/sync/orchestrator.ts` (~L195): build histogram from `[...isrcResult.errors, ...fuzzyResult.errors]` and pass to `updateRun`
4. Spec: amend `docs/specs/F-009-sync-orchestrator.md` to require error_codes histogram on partial/failed runs
5. Test: extend T-009 with a fixture that injects `tidal_429` once and asserts `error_codes = {"tidal_429": 1}`

**Risk:** zero. Purely additive write path. No reads change. All 503 existing tests should stay green; new test gates the new column.

**Diagnostic query after deploy:**
```sql
SELECT started_at, status, error_codes
FROM sync_runs
WHERE status = 'partial' AND error_codes IS NOT NULL
ORDER BY started_at DESC LIMIT 10;
```

One partial caught after deploy = answer.

## Cleanup

- Tail process (PID 6213) stopped at 08:55 UTC
- Raw tail preserved at `.harness/diagnostics/phase1-tail-2026-05-03.jsonl`
- `/tmp/portage-tail-*` files: ephemeral, will clear at reboot
