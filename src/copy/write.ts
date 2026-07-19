// F-030 task 2.5: copy-job write phase — dest-create on first write,
// position-ordered capped batches, append dedup, crash-safe write+flip via a
// batch-in-flight marker (design.md D7, review B1: count-based reconcile).

import type { Env } from "../env";
import {
  setDestPlaylist,
  setWriteBatchPositions,
  resolveWriteBatch,
  type CopyJobRow,
  type CopyDirection,
} from "../db/copy_jobs";
import {
  listMatchedForWrite,
  listTracksByPositions,
  updateTracksState,
  type CopyJobTrackRow,
} from "../db/copy_job_tracks";
import { readDestItemCount, type DestProvider } from "./dest-reader";
import { createPlaylist as createTidalPlaylist, addTracksToPlaylist } from "../providers/tidal/playlist";
import { createPlaylist as createSpotifyPlaylist, addItems } from "../providers/spotify/playlist-write";

// design.md D6: ≤20 Tidal / ≤50 Spotify URIs per write-phase tick. Note these
// equal BATCH_SIZE (Tidal) / MAX_ADD_ITEMS_BATCH (Spotify) exactly, so a
// write-phase batch is always exactly one provider HTTP request — see B1's
// "single HTTP request" assumption below.
const WRITE_BATCH_TIDAL = 20;
const WRITE_BATCH_SPOTIFY = 50;

function destProviderFor(direction: CopyDirection): DestProvider {
  return direction === "spotify_to_tidal" ? "tidal" : "spotify";
}

function batchCapFor(direction: CopyDirection): number {
  return direction === "spotify_to_tidal" ? WRITE_BATCH_TIDAL : WRITE_BATCH_SPOTIFY;
}

async function ensureDestPlaylist(
  env: Env,
  job: CopyJobRow,
): Promise<{ destPlaylistId: string; isFresh: boolean }> {
  if (job.dest_playlist_id) return { destPlaylistId: job.dest_playlist_id, isFresh: false };

  const name = job.dest_name ?? job.source_name;
  const destPlaylistId =
    job.direction === "spotify_to_tidal"
      ? await createTidalPlaylist(env, name)
      : await createSpotifyPlaylist(env, name);
  await setDestPlaylist(env, job.job_id, destPlaylistId);
  return { destPlaylistId, isFresh: true };
}

interface Partitioned {
  alreadyKnown: CopyJobTrackRow[];
  toWrite: CopyJobTrackRow[];
}

/** Append-mode dedup: rows whose dest id is already in the job-creation-time snapshot. */
function partitionCandidates(candidates: CopyJobTrackRow[], knownIds: Set<string>): Partitioned {
  const alreadyKnown: CopyJobTrackRow[] = [];
  const toWrite: CopyJobTrackRow[] = [];
  for (const c of candidates) {
    const destId = c.dest_track_id as string;
    if (knownIds.has(destId)) alreadyKnown.push(c);
    else toWrite.push(c);
  }
  return { alreadyKnown, toWrite };
}

/**
 * A write batch that made zero forward progress (nothing written, nothing
 * write_failed — e.g. a whole-batch provider rejection with no per-id detail,
 * or a persistent rate limit). The marker is cleared before this is thrown:
 * nothing landed, so the next attempt safely re-selects. The engine's B3
 * handler counts it into the consecutive-error streak so a persistently
 * stalled batch fails the job instead of looping forever (review NEW-B3a).
 */
export class WriteBatchStalledError extends Error {
  constructor(jobId: string, detail: string) {
    super(`write batch stalled for job ${jobId}: ${detail}`);
    this.name = "WriteBatchStalledError";
  }
}

/**
 * Calls the provider's add() for a fresh batch and interprets the result
 * (review S1): invalid ids -> write_failed (permanent, won't be retried by
 * listMatchedForWrite since it only selects state='matched'); an aborted/
 * rate-limited batch (or any non-specific error count) leaves the remaining
 * rows untouched (still 'matched') so the next tick retries them; only
 * confirmed-added rows flip to 'written'. The batch-in-flight marker is
 * persisted before the add() call and always cleared once we have a result
 * (resolveWriteBatch) — see design.md D7's rewritten paragraph.
 */
async function performAddAndResolve(
  env: Env,
  job: CopyJobRow,
  destPlaylistId: string,
  toWrite: CopyJobTrackRow[],
): Promise<void> {
  const positions = toWrite.map((t) => t.position);
  await setWriteBatchPositions(env, job.job_id, positions);
  const ids = toWrite.map((t) => t.dest_track_id as string);

  let written: number[];
  let writeFailed: number[] = [];

  if (job.direction === "spotify_to_tidal") {
    const result = await addTracksToPlaylist(env, destPlaylistId, ids);
    const invalidSet = new Set(result.invalidIds);
    writeFailed = toWrite.filter((t) => invalidSet.has(t.dest_track_id as string)).map((t) => t.position);
    // result.errors > 0 covers both a persistent-429 abort and any
    // unidentified per-batch failure — in either case we cannot tell which
    // specific ids landed, so conservatively leave the non-invalid remainder
    // 'matched' for retry rather than risk marking an unwritten row 'written'.
    written =
      result.errors > 0
        ? []
        : toWrite.filter((t) => !invalidSet.has(t.dest_track_id as string)).map((t) => t.position);
  } else {
    const result = await addItems(env, destPlaylistId, ids);
    written = result.rateLimited ? [] : positions;
  }

  await resolveWriteBatch(env, job.job_id, written, writeFailed);
  if (written.length === 0 && writeFailed.length === 0) {
    // Provider reported the batch as not applied (rate limit or whole-batch
    // rejection) — nothing landed, so the cleared marker is accurate.
    throw new WriteBatchStalledError(job.job_id, "provider applied no rows in this batch");
  }
}

/**
 * Resumes a batch that was already marked in-flight on a previous tick —
 * i.e. the isolate may have died between performAddAndResolve's add() call
 * and its resolveWriteBatch flip. Reconciles via a single item-count read
 * (design.md D7, review B1) instead of re-adding blindly:
 *   expectedPreWrite = (append-mode's original dest_known_ids snapshot size,
 *                        else 0 for a 'new' destination)
 *                      + job.written (rows this job has already landed,
 *                        persisted by the previous tick's recomputeCounters
 *                        call — see engine.ts's maybeCompleteWriting)
 *   actual == expectedPreWrite            -> the add() never landed; retry it.
 *   actual == expectedPreWrite + batchSize -> it landed; flip without re-adding.
 *   otherwise                              -> unexpected (violates the
 *     single-HTTP-request assumption below, or the destination was mutated
 *     externally mid-reconcile); conservatively treat as landed to avoid
 *     re-introducing the duplicate-add bug this fix closes.
 *
 * Both provider add() calls are exactly one HTTP request per batch (Tidal's
 * BATCH_SIZE and Spotify's MAX_ADD_ITEMS_BATCH both equal this module's
 * write-phase batch caps), so there is no partial-landing state to reconcile
 * beyond these two cases.
 */
async function reconcileInFlightBatch(
  env: Env,
  job: CopyJobRow,
  destPlaylistId: string,
  toWrite: CopyJobTrackRow[],
): Promise<void> {
  const positions = toWrite.map((t) => t.position);
  const expectedPreWrite = (job.dest_mode === "append" ? job.dest_known_ids?.length ?? 0 : 0) + job.written;
  const actualCount = await readDestItemCount(env, destProviderFor(job.direction), destPlaylistId);

  if (actualCount === expectedPreWrite) {
    await performAddAndResolve(env, job, destPlaylistId, toWrite);
    return;
  }
  if (actualCount === expectedPreWrite + toWrite.length) {
    await resolveWriteBatch(env, job.job_id, positions, []);
    return;
  }

  console.log(
    JSON.stringify({
      event: "copy_write_reconcile_unexpected_count",
      job_id: job.job_id,
      expected_pre_write: expectedPreWrite,
      expected_post_write: expectedPreWrite + toWrite.length,
      actual: actualCount,
    }),
  );
  await resolveWriteBatch(env, job.job_id, positions, []);
}

/** One write-phase tick step. */
export async function runWritePhaseStep(env: Env, job: CopyJobRow): Promise<void> {
  const { destPlaylistId } = await ensureDestPlaylist(env, job);

  // Review NEW-B1a: an in-flight marker is reconciled against its OWN rows,
  // never against a freshly-selected batch — append-mode dedup-skips recorded
  // before a crash shrink the matched pool, so a fresh selection can backfill
  // past the marker and diverge from it. The marker rows still carry their
  // dest_track_id, so they are self-sufficient for the count reconcile; a
  // fresh batch is only ever selected when no marker is pending.
  if (job.write_batch_positions != null) {
    const markerRows = await listTracksByPositions(env, job.job_id, job.write_batch_positions);
    const stillMatched = markerRows.filter((t) => t.state === "matched");
    if (stillMatched.length === 0) {
      // Every marker row was already resolved before the crash — nothing to
      // reconcile, just clear the marker.
      await resolveWriteBatch(env, job.job_id, [], []);
    } else {
      await reconcileInFlightBatch(env, job, destPlaylistId, stillMatched);
    }
    return;
  }

  const batchCap = batchCapFor(job.direction);
  const candidates = await listMatchedForWrite(env, job.job_id, batchCap);
  if (candidates.length === 0) return;

  const knownIds = new Set(job.dest_known_ids ?? []);
  const { alreadyKnown, toWrite } = partitionCandidates(candidates, knownIds);

  if (alreadyKnown.length > 0) {
    await updateTracksState(env, job.job_id, alreadyKnown.map((t) => t.position), "skipped", "already_present");
  }
  if (toWrite.length === 0) return;

  await performAddAndResolve(env, job, destPlaylistId, toWrite);
}
