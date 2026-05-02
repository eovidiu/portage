// Dump the unmatched-pending queue to a markdown file for manual review.
// Usage: npx tsx scripts/dump-unmatched.ts [out.md]
// Default output: ./unmatched-review.md
import { neon } from "@neondatabase/serverless";
import { readFileSync, writeFileSync } from "node:fs";

function loadDatabaseUrl(): string {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const raw = readFileSync(".dev.vars", "utf-8");
  const match = raw.match(/^DATABASE_URL\s*=\s*"?([^"\n]+)"?/m);
  if (!match) throw new Error("DATABASE_URL not in .dev.vars");
  return match[1].trim();
}

interface Row {
  spotify_id: string;
  title: string;
  artist: string;
  album: string | null;
  isrc: string | null;
  duration_ms: number | null;
  reason: string;
  attempts: number;
  last_attempt_at: string;
  spotify_added_at: string;
}

function fmtDur(ms: number | null): string {
  if (ms === null) return "—";
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function escapePipe(s: string | null | undefined): string {
  return (s ?? "").replace(/\|/g, "\\|");
}

async function main(): Promise<void> {
  const out = process.argv[2] ?? "unmatched-review.md";
  const sql = neon(loadDatabaseUrl());
  const rows = (await sql(
    `SELECT t.spotify_id, t.title, t.artist, t.album, t.isrc, t.duration_ms,
            u.reason, u.attempts, u.last_attempt_at::text AS last_attempt_at,
            t.spotify_added_at::text AS spotify_added_at
     FROM unmatched u
     JOIN tracks t ON t.spotify_id = u.spotify_id
     WHERE u.status = 'pending'
     ORDER BY u.last_attempt_at DESC`,
    [],
  )) as Row[];

  const reasonCounts = rows.reduce<Record<string, number>>((acc, r) => {
    acc[r.reason] = (acc[r.reason] ?? 0) + 1;
    return acc;
  }, {});

  const lines: string[] = [];
  lines.push(`# Unmatched (pending) — ${rows.length} tracks`);
  lines.push("");
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push("");
  lines.push("## Reasons");
  lines.push("");
  for (const [reason, count] of Object.entries(reasonCounts).sort((a, b) => b[1] - a[1])) {
    lines.push(`- \`${reason}\`: ${count}`);
  }
  lines.push("");
  lines.push("## Tracks");
  lines.push("");
  lines.push("| Artist | Title | Album | Dur | ISRC | Reason | Attempts | Spotify ID |");
  lines.push("|---|---|---|---|---|---|---|---|");
  for (const r of rows) {
    lines.push(
      `| ${escapePipe(r.artist)} | ${escapePipe(r.title)} | ${escapePipe(r.album)} | ${fmtDur(r.duration_ms)} | ${r.isrc ?? "—"} | ${r.reason} | ${r.attempts} | \`${r.spotify_id}\` |`,
    );
  }
  lines.push("");
  lines.push("## Spotify links (for cross-reference)");
  lines.push("");
  for (const r of rows) {
    lines.push(`- [${r.artist} — ${r.title}](https://open.spotify.com/track/${r.spotify_id})`);
  }
  lines.push("");

  writeFileSync(out, lines.join("\n"));
  console.log(`Wrote ${rows.length} unmatched-pending rows to ${out}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
