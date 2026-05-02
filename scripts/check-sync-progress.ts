// F-015: local sync-progress dashboard.
// Usage: npx tsx scripts/check-sync-progress.ts
// Reads DATABASE_URL from .dev.vars (preferred) or process.env.
// Add -w / --watch to poll every 30s.
import { neon } from "@neondatabase/serverless";
import { readFileSync } from "node:fs";

const WATCH_INTERVAL_MS = 30_000;

function loadDatabaseUrl(): string {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  try {
    const raw = readFileSync(".dev.vars", "utf-8");
    const match = raw.match(/^DATABASE_URL\s*=\s*"?([^"\n]+)"?/m);
    if (match) return match[1].trim();
  } catch {
    // .dev.vars missing — fall through to error
  }
  throw new Error(
    "DATABASE_URL not found. Set in env or place in .dev.vars at repo root.",
  );
}

interface ProgressRow {
  tracks: string;
  matches: string;
  matches_isrc: string;
  matches_fuzzy: string;
  matches_manual: string;
  unmatched_pending: string;
  unmatched_skipped: string;
  unmatched_matched: string;
  resume_url: string | null;
  cursor: string | null;
  playlist_id: string | null;
  last_playlist_write: string | null;
  sweep_max: string | null;
}

interface RunRow {
  run_id: string;
  status: string;
  error_code: string | null;
  tracks_seen: number;
  matched_isrc: number;
  matched_fuzzy: number;
  unmatched: number;
  errors: number;
  duration_s: string | null;
  started_at: string;
}

async function fetchProgress(databaseUrl: string): Promise<{ progress: ProgressRow; recent: RunRow[] }> {
  const sql = neon(databaseUrl);
  const [progressRows, runRows] = await Promise.all([
    sql(
      `SELECT
        (SELECT COUNT(*) FROM tracks)::text AS tracks,
        (SELECT COUNT(*) FROM matches)::text AS matches,
        (SELECT COUNT(*) FROM matches WHERE method='isrc')::text AS matches_isrc,
        (SELECT COUNT(*) FROM matches WHERE method='fuzzy')::text AS matches_fuzzy,
        (SELECT COUNT(*) FROM matches WHERE method='manual')::text AS matches_manual,
        (SELECT COUNT(*) FROM unmatched WHERE status='pending')::text AS unmatched_pending,
        (SELECT COUNT(*) FROM unmatched WHERE status='skipped')::text AS unmatched_skipped,
        (SELECT COUNT(*) FROM unmatched WHERE status='matched')::text AS unmatched_matched,
        (SELECT NULLIF(value, '') FROM sync_state WHERE key='spotify_resume_url') AS resume_url,
        (SELECT value FROM sync_state WHERE key='spotify_cursor') AS cursor,
        (SELECT value FROM sync_state WHERE key='tidal_playlist_id') AS playlist_id,
        (SELECT value FROM sync_state WHERE key='last_playlist_write_at') AS last_playlist_write,
        (SELECT NULLIF(value, '') FROM sync_state WHERE key='spotify_sweep_max') AS sweep_max`,
      [],
    ),
    sql(
      `SELECT run_id, status, error_code, tracks_seen, matched_isrc, matched_fuzzy,
              unmatched, errors,
              ROUND(EXTRACT(EPOCH FROM (finished_at - started_at))::numeric, 2)::text AS duration_s,
              started_at::text
       FROM sync_runs
       ORDER BY started_at DESC
       LIMIT 5`,
      [],
    ),
  ]);
  return {
    progress: (progressRows as ProgressRow[])[0],
    recent: runRows as RunRow[],
  };
}

function fmtTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  const ageMs = Date.now() - d.getTime();
  const ageMin = Math.floor(ageMs / 60_000);
  return ageMin < 60 ? `${ageMin}m ago` : `${Math.floor(ageMin / 60)}h ${ageMin % 60}m ago`;
}

function fmtStatus(s: string, errCode: string | null): string {
  if (s === "succeeded") return "✓ succeeded";
  if (s === "failed") return `✗ failed (${errCode ?? "?"})`;
  if (s === "partial") return "~ partial";
  if (s === "running") return "… running";
  return s;
}

function render({ progress, recent }: { progress: ProgressRow; recent: RunRow[] }): string {
  const tracks = Number(progress.tracks);
  const matches = Number(progress.matches);
  const pending = Number(progress.unmatched_pending);
  const skipped = Number(progress.unmatched_skipped);
  const accountedFor = matches + pending + skipped;
  const queueDepth = tracks - accountedFor;

  const lines: string[] = [];
  lines.push(`portage sync — ${new Date().toISOString().replace("T", " ").slice(0, 19)}Z`);
  lines.push("─".repeat(60));
  lines.push(`tracks ingested      ${tracks.toString().padStart(6)}`);
  lines.push(`  matched (ISRC)     ${progress.matches_isrc.padStart(6)}`);
  lines.push(`  matched (fuzzy)    ${progress.matches_fuzzy.padStart(6)}`);
  lines.push(`  matched (manual)   ${progress.matches_manual.padStart(6)}`);
  lines.push(`  unmatched pending  ${pending.toString().padStart(6)}`);
  lines.push(`  unmatched skipped  ${skipped.toString().padStart(6)}`);
  lines.push(`  unattempted        ${queueDepth.toString().padStart(6)}  ← match queue`);
  lines.push("");
  lines.push("sweep state:");
  lines.push(`  resume_url   ${progress.resume_url ? progress.resume_url.replace(/^https:\/\/api\.spotify\.com\/v1\/me\/tracks\?/, "[Spotify] ") : "(sweep complete)"}`);
  lines.push(`  cursor       ${progress.cursor ?? "(cold)"}`);
  lines.push(`  sweep_max    ${progress.sweep_max ?? "(cleared)"}`);
  lines.push("");
  lines.push("playlist:");
  lines.push(`  tidal_id     ${progress.playlist_id ?? "(not yet created)"}`);
  lines.push(`  last write   ${fmtTime(progress.last_playlist_write)}`);
  lines.push("");
  lines.push("recent runs:");
  for (const r of recent) {
    const status = fmtStatus(r.status, r.error_code).padEnd(20);
    const dur = r.duration_s ? `${r.duration_s}s` : "—";
    lines.push(
      `  ${fmtTime(r.started_at).padStart(10)}  ${status}  seen=${r.tracks_seen}  isrc=${r.matched_isrc}  fuzzy=${r.matched_fuzzy}  unmatched=${r.unmatched}  errors=${r.errors}  ${dur}`,
    );
  }
  return lines.join("\n");
}

async function main(): Promise<void> {
  const watch = process.argv.includes("-w") || process.argv.includes("--watch");
  const databaseUrl = loadDatabaseUrl();

  const tick = async () => {
    try {
      const data = await fetchProgress(databaseUrl);
      if (watch) process.stdout.write("\x1Bc"); // clear screen
      process.stdout.write(render(data) + "\n");
    } catch (err) {
      process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
      if (!watch) process.exit(1);
    }
  };

  await tick();
  if (watch) {
    setInterval(tick, WATCH_INTERVAL_MS);
  }
}

main();
