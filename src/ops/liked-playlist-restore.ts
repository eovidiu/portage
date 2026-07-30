// TEMPORARY OPS MODULE (2026-07-30 incident recovery — remove after the
// cleanup completes): removes the foreign tracks that the R18 membership
// contamination pushed into the Tidal Liked playlist. The foreign set is
// derived from the copy job's matches (407 tidal ids, verified disjoint from
// genuine Liked membership). Runs as a chunked tick on a temporary cron:
// each invocation scans a bounded number of item pages and deletes what it
// finds, staying inside the free tier's 50-subrequest budget, then persists
// a resume cursor. Terminates by writing the done marker once a scan reaches
// the playlist's end with nothing left to remove.

import { neon } from "@neondatabase/serverless";
import type { Env } from "../env";
import { tidalFetch } from "../providers/tidal/client";
import { playlistTracksUrl } from "../providers/tidal/playlist-endpoints";
import { readState, writeState } from "../db/sync_state";

const CONTAMINATING_JOB_ID = "3b322e67-a5c4-4052-af3e-51754e120cc2";
const CURSOR_KEY = "liked_cleanup_cursor";
const DONE_KEY = "liked_cleanup_done";
// <=35 page reads + <=2 delete calls + ~4 Neon calls stays under 50 subrequests.
const PAGE_BUDGET = 35;
const MAX_DELETES_PER_TICK = 40;
// Mirrors BATCH_SIZE for the add operation (OAS maxItems 20); the remove
// payload declares no maxItems — 20 is the conservative choice.
const DELETE_BATCH_SIZE = 20;

interface ItemRef {
  id: string;
  itemId: string;
}

interface ItemsPage {
  refs: Array<{ id: string; itemId: string | null; itemCursor: string | null }>;
  nextCursor: string | null;
}

// Pause between sequential page reads — 35 back-to-back GETs trip Tidal's
// per-second rate limit (observed: first live tick died with HTTP 429 on the
// items read). ~4 req/s stays under it; the sleep burns wall clock, not CPU.
const PAGE_READ_PAUSE_MS = 250;

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Verified: 2026-07-30 live probe — data[] identifiers carry
// meta.itemId + meta.itemCursor without any include flag
// (openapi-types.ts:20608-20625, Playlists_Items_Resource_Identifier_Meta).
async function readItemsPage(
  env: Env,
  playlistId: string,
  cursor: string | null,
): Promise<ItemsPage | "rate_limited"> {
  let url = playlistTracksUrl(playlistId);
  if (cursor) url += `?page[cursor]=${encodeURIComponent(cursor)}`;
  const response = await tidalFetch(env, url);
  // A 429 ends this tick's scan gracefully — whatever was found so far is
  // still processed, pure-scan progress is still anchored, and the next
  // cron tick resumes. No sleep-and-retry: that's the zombie-isolate trap.
  if (response.status === 429) return "rate_limited";
  if (!response.ok) throw new Error(`liked cleanup: items page HTTP ${response.status}`);
  const json = (await response.json()) as {
    data?: Array<{ id: string; meta?: { itemId?: string; itemCursor?: string } }>;
    links?: { meta?: { nextCursor?: string } };
  };
  return {
    refs: (json.data ?? []).map((d) => ({
      id: d.id,
      itemId: typeof d.meta?.itemId === "string" ? d.meta.itemId : null,
      itemCursor: typeof d.meta?.itemCursor === "string" ? d.meta.itemCursor : null,
    })),
    nextCursor: json.links?.meta?.nextCursor ?? null,
  };
}

// Verified: 2026-07-30 against openapi-types.ts:8210-8235 (DELETE
// /playlists/{id}/relationships/items) and :20511-20522
// (PlaylistsItemsRelationshipRemoveOperation_Payload — data[] of
// { id, type: "tracks", meta: { itemId } }).
async function deleteItems(env: Env, playlistId: string, items: ItemRef[]): Promise<void> {
  const body = JSON.stringify({
    data: items.map((i) => ({ id: i.id, type: "tracks", meta: { itemId: i.itemId } })),
  });
  const response = await tidalFetch(env, playlistTracksUrl(playlistId), { method: "DELETE", body });
  if (!response.ok) throw new Error(`liked cleanup: delete HTTP ${response.status}`);
}

async function loadForeignTidalIds(env: Env): Promise<Set<string>> {
  const sql = neon(env.DATABASE_URL);
  const rows = await sql(
    `SELECT m.tidal_id FROM matches m
     JOIN copy_job_tracks c ON c.source_track_id = m.spotify_id AND c.job_id = $1`,
    [CONTAMINATING_JOB_ID],
  );
  return new Set((rows as Array<{ tidal_id: string }>).map((r) => r.tidal_id));
}

export interface CleanupTickResult {
  outcome: "done_marker_present" | "scan_advanced" | "deleted" | "complete";
  pagesScanned: number;
  deleted: number;
}

/**
 * One cleanup tick. Scans from the persisted cursor, deletes foreign items
 * found (bounded), and only advances the cursor on pure-scan ticks — a tick
 * that deleted anything re-scans the same region next time, because deleting
 * items may invalidate cursors anchored on them. Converges: deleted items
 * vanish from subsequent scans.
 */
export async function runLikedCleanupTick(env: Env, playlistId: string): Promise<CleanupTickResult> {
  const db = neon(env.DATABASE_URL);
  if ((await readState(db, DONE_KEY)) === "1") {
    return { outcome: "done_marker_present", pagesScanned: 0, deleted: 0 };
  }

  const foreign = await loadForeignTidalIds(env);
  let cursor = (await readState(db, CURSOR_KEY)) || null;

  const found: ItemRef[] = [];
  let lastKeptCursor: string | null = null;
  let pages = 0;
  let reachedEnd = false;

  while (pages < PAGE_BUDGET && found.length < MAX_DELETES_PER_TICK) {
    if (pages > 0) await sleep(PAGE_READ_PAUSE_MS);
    const page = await readItemsPage(env, playlistId, cursor);
    if (page === "rate_limited") break;
    pages++;
    for (const ref of page.refs) {
      if (foreign.has(ref.id) && ref.itemId !== null) {
        if (found.length < MAX_DELETES_PER_TICK) found.push({ id: ref.id, itemId: ref.itemId });
      } else if (ref.itemCursor !== null) {
        lastKeptCursor = ref.itemCursor;
      }
    }
    if (page.nextCursor === null) {
      reachedEnd = true;
      break;
    }
    cursor = page.nextCursor;
  }

  for (let i = 0; i < found.length; i += DELETE_BATCH_SIZE) {
    await deleteItems(env, playlistId, found.slice(i, i + DELETE_BATCH_SIZE));
  }

  if (found.length === 0 && reachedEnd) {
    await writeState(db, DONE_KEY, "1");
    await writeState(db, CURSOR_KEY, "");
    console.log(JSON.stringify({ event: "liked_cleanup_complete", pages_scanned: pages }));
    return { outcome: "complete", pagesScanned: pages, deleted: 0 };
  }

  if (found.length === 0) {
    // Pure scan: safe to anchor on the last kept item and continue from here.
    // A tick that scanned nothing (e.g. 429 on the first page) leaves the
    // cursor untouched rather than resetting progress.
    if (lastKeptCursor !== null) {
      await writeState(db, CURSOR_KEY, lastKeptCursor);
    }
    console.log(JSON.stringify({ event: "liked_cleanup_tick", pages_scanned: pages, deleted: 0 }));
    return { outcome: "scan_advanced", pagesScanned: pages, deleted: 0 };
  }

  // Deleted something: keep the incoming cursor unchanged so the next tick
  // re-scans this region against the now-shrunken playlist.
  console.log(
    JSON.stringify({ event: "liked_cleanup_tick", pages_scanned: pages, deleted: found.length }),
  );
  return { outcome: "deleted", pagesScanned: pages, deleted: found.length };
}
