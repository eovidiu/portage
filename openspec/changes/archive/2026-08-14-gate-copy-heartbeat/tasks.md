## 1. Binding and configuration

- [x] 1.1 Run `npx wrangler kv namespace create COPY_STATE` and record the printed id
- [x] 1.2 Add the `[[kv_namespaces]]` block with the real id to the gitignored `wrangler.toml`, placed as its own top-level table before `[triggers]` so it cannot be absorbed into `[vars]`
- [x] 1.3 Mirror the same block into the tracked `wrangler.toml.example` with a placeholder id and a comment explaining why the namespace exists and that the Worker degrades gracefully without it
- [x] 1.4 Add `COPY_STATE: KVNamespace` to the `Env` interface in `src/env.ts` with a doc comment
- [x] 1.5 Run `npm run typecheck` and confirm `src/routes/health.ts` still narrows correctly now that `Env` has a non-string member

## 2. The flag module

- [x] 2.1 Write `tests/copy/active-flag.test.ts` covering: absent key reads false, present key reads true, read error reads true, missing binding reads true, arm writes the key, release deletes the key, and write failures are swallowed
- [x] 2.2 Add a test in the same file that round-trips against the real bound namespace via `cloudflare:test`, so CI fails if the `[[kv_namespaces]]` block is ever dropped from the tracked template
- [x] 2.3 Implement `src/copy/active-flag.ts` with a read helper whose name states the hedge, plus arm and release helpers; import only the `Env` type so no cycle can form with `src/db/copy_jobs.ts`

## 3. Gate the tick

- [x] 3.1 Add failing tests to `tests/copy/engine.test.ts`: an absent flag makes zero Neon calls and never acquires the lock; a present flag runs the tick normally; a KV read error falls back to the query; a stale flag is cleared when the query finds no job; the flag is left alone when a job is found
- [x] 3.2 Add the flag read at the top of `runCopyTick` before `loadActiveJob`, returning a distinct outcome so the fast path is visible in production logs
- [x] 3.3 Clear the flag when the flag was present but `loadActiveJob` returns null
- [x] 3.4 Confirm all pre-existing engine tests still pass unmodified

## 4. Flag lifecycle on the job

- [x] 4.1 Add failing tests to `tests/db/copy_jobs.test.ts`: `createJob` arms the flag; a 23505 rejection does not; a KV write failure still returns the created row; a terminal `setStatus` releases the flag; the non-terminal `matching → writing` transition does not; a no-op terminal `setStatus` does not; `cancelJob` releases it only when it actually cancelled
- [x] 4.2 Arm the flag in `createJob` after a successful insert
- [x] 4.3 Release the flag in `setStatus` only when the update applied and the target status is terminal
- [x] 4.4 Release the flag in `cancelJob` only on the `cancelled` outcome

## 5. Self-heal for a lost flag write

- [x] 5.1 Add `NON_TERMINAL_STATUSES` to the `db/copy_jobs` mock factory in `tests/routes/copy/jobs.test.ts`, which currently omits it and would throw
- [x] 5.2 Add failing tests: `GET /api/copy/jobs/:job_id` re-arms the flag for a non-terminal job, leaves it untouched for a terminal job, and touches nothing on a 404
- [x] 5.3 Re-arm the flag in the job detail route when the loaded job is non-terminal
- [x] 5.4 Mock `db/copy_jobs` in `tests/sync/orchestrator.test.ts` and `tests/sync/orchestrator-notify.test.ts` so the new query does not consume their ordered mock-response queues
- [x] 5.5 Add failing tests: `runSync` re-arms the flag when a non-terminal copy job exists, clears it when none does, and completes normally when the reconcile fails
- [x] 5.6 Reconcile the flag from `copy_jobs` at the top of `runSync`, alongside the existing abandoned-run sweep

## 6. Make `updated_at` mean "last actual change"

- [x] 6.1 Add failing tests: a tick that changes nothing leaves `updated_at` untouched, while a real counter change or error still advances it
- [x] 6.2 Guard `resetConsecutiveErrors` with `AND consecutive_errors <> 0` so a clean tick is a no-op
- [x] 6.3 Make `recomputeCounters` skip its `UPDATE` when the recomputed counters equal the stored ones
- [x] 6.4 Confirm the existing copy-engine and copy-jobs suites still pass, since both functions run on every tick

## 7. Stalled-job sweep

- [x] 7.1 Add failing tests: a job with no change beyond the staleness window is failed with a stalled error code, its `finished_at` is set and the flag released; a job that is progressing slowly is untouched however long it has run; a terminal job is untouched
- [x] 7.2 Implement the sweep as a guarded `UPDATE` over non-terminal jobs whose `updated_at` is older than the window, returning the swept job ids
- [x] 7.3 Call it from the `runSync` path next to the abandoned-run sweep, never from the copy tick, and release the flag for anything it swept
- [x] 7.4 Fire the existing terminal notification for swept jobs so a killed job is not silent

## 8. Documentation

- [x] 8.1 Add the namespace-creation step to `docs/operations/pre-deploy-checklist.md`
- [x] 8.2 Document the binding in `docs/operations/self-hosting.md`, including that the Worker still runs without it at the old cost
- [x] 8.3 Note the corrected meaning of `copy_jobs.updated_at` wherever the copy engine is documented

## 9. Ship and verify

- [x] 9.1 Run `npm test` and `npm run typecheck` clean
- [x] 9.2 Open a PR from a feature branch, never pushing to main, and merge on green CI
- [x] 9.3 Deploy and confirm `COPY_STATE` appears in the binding list wrangler prints
- [x] 9.4 Confirm the new idle outcome appears in `wrangler tail` and that no `copy_active_flag_failed` events do
- [x] 9.5 Confirm via the Neon control plane that the compute reaches `idle` and `active_time` stops tracking wall clock — the only check that proves the fix
- [x] 9.6 Record the deployed Version ID in `.harness/context_summary.md` Active Context
