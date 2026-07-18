// F-030 task 2.5: copy-job write phase — dest-create on first write,
// position-ordered capped batches, append dedup, single-statement
// written-flip, crash reconcile (design.md D7).

import type { Env } from "../env";
import { setDestPlaylist, type CopyJobRow, type CopyDirection } from "../db/copy_jobs";
import { listMatchedForWrite, updateTracksState, type CopyJobTrackRow } from "../db/copy_job_tracks";
import { readDestTailIds, type DestProvider } from "./dest-reader";
import { createPlaylist as createTidalPlaylist, addTracksToPlaylist } from "../providers/tidal/playlist";
import { createPlaylist as createSpotifyPlaylist, addItems } from "../providers/spotify/playlist-write";

// design.md D6: ≤20 Tidal / ≤50 Spotify URIs per write-phase tick.
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

async function addToDestination(
  env: Env,
  direction: CopyDirection,
  destPlaylistId: string,
  destTrackIds: string[],
): Promise<void> {
  if (direction === "spotify_to_tidal") {
    await addTracksToPlaylist(env, destPlaylistId, destTrackIds);
  } else {
    await addItems(env, destPlaylistId, destTrackIds);
  }
}

interface Partitioned {
  reconciled: CopyJobTrackRow[];
  alreadyKnown: CopyJobTrackRow[];
  toWrite: CopyJobTrackRow[];
}

/** Reconciled (D7) takes priority over the append-dedup snapshot (D3). */
function partitionCandidates(
  candidates: CopyJobTrackRow[],
  tailIds: Set<string>,
  knownIds: Set<string>,
): Partitioned {
  const reconciled: CopyJobTrackRow[] = [];
  const alreadyKnown: CopyJobTrackRow[] = [];
  const toWrite: CopyJobTrackRow[] = [];
  for (const c of candidates) {
    const destId = c.dest_track_id as string;
    if (tailIds.has(destId)) reconciled.push(c);
    else if (knownIds.has(destId)) alreadyKnown.push(c);
    else toWrite.push(c);
  }
  return { reconciled, alreadyKnown, toWrite };
}

/** One write-phase tick step. */
export async function runWritePhaseStep(env: Env, job: CopyJobRow): Promise<void> {
  const { destPlaylistId, isFresh } = await ensureDestPlaylist(env, job);

  const batchCap = batchCapFor(job.direction);
  const candidates = await listMatchedForWrite(env, job.job_id, batchCap);
  if (candidates.length === 0) return;

  // A freshly created destination is guaranteed empty — skip the reconcile
  // read entirely (design.md D7: "a cheap, targeted check", not run when
  // there is nothing yet to reconcile against).
  const tailIds = isFresh
    ? new Set<string>()
    : await readDestTailIds(env, destProviderFor(job.direction), destPlaylistId);
  const knownIds = new Set(job.dest_known_ids ?? []);
  const { reconciled, alreadyKnown, toWrite } = partitionCandidates(candidates, tailIds, knownIds);

  if (reconciled.length > 0) {
    await updateTracksState(env, job.job_id, reconciled.map((t) => t.position), "written");
  }
  if (alreadyKnown.length > 0) {
    await updateTracksState(env, job.job_id, alreadyKnown.map((t) => t.position), "skipped", "already_present");
  }
  if (toWrite.length > 0) {
    await addToDestination(env, job.direction, destPlaylistId, toWrite.map((t) => t.dest_track_id as string));
    await updateTracksState(env, job.job_id, toWrite.map((t) => t.position), "written");
  }
}
