// TEMP DIAGNOSTIC — runs ISRC + fuzzy match against a specific spotify_id
// and returns the full Tidal request/response trace plus per-candidate
// scoring breakdown. JWT-protected via the global middleware. Intended for
// understanding why a specific track lands in unmatched. Remove once the
// match-stage logic is confirmed working in prod.
import { Hono } from "hono";
import { neon } from "@neondatabase/serverless";
import type { Env } from "../env";
import { tidalFetch } from "../providers/tidal/client";
import { normaliseTitle } from "../match/title";
import { scoreCandidate, type ResolvedTidalCandidate, type SpotifyTrackInput } from "../match/score";
import {
  parseIsoDurationMs,
  buildIncludedIndex,
  lookupIncluded,
  type JsonApiResource,
  type IncludedIndex,
} from "../match/json-api";

interface TrackRow {
  spotify_id: string;
  isrc: string | null;
  title: string;
  artist: string;
  album: string | null;
  duration_ms: number | null;
}

function resolveTrack(track: JsonApiResource, idx: IncludedIndex): ResolvedTidalCandidate {
  const attrs = track.attributes ?? {};
  const title = typeof attrs.title === "string" ? attrs.title : "";
  const durationMs = parseIsoDurationMs(attrs.duration);
  const artistRel = track.relationships?.artists?.data;
  const artistRef = Array.isArray(artistRel) ? artistRel[0] : undefined;
  const artistRes = artistRef ? lookupIncluded(idx, "artists", artistRef.id) : undefined;
  const primaryArtist = typeof artistRes?.attributes?.name === "string" ? artistRes.attributes.name : "";
  const albumRel = track.relationships?.albums?.data;
  const albumRef = Array.isArray(albumRel) ? albumRel[0] : undefined;
  const albumRes = albumRef ? lookupIncluded(idx, "albums", albumRef.id) : undefined;
  const albumTitle = typeof albumRes?.attributes?.title === "string" ? albumRes.attributes.title : "";
  return { id: track.id, title, primaryArtist, albumTitle, durationMs };
}

const debugRoutes = new Hono<{ Bindings: Env }>();

debugRoutes.get("/match-trace/:spotify_id", async (c) => {
  const spotifyId = c.req.param("spotify_id");
  const sql = neon(c.env.DATABASE_URL);
  const rows = (await sql(
    `SELECT spotify_id, isrc, title, artist, album, duration_ms FROM tracks WHERE spotify_id = $1`,
    [spotifyId],
  )) as TrackRow[];
  if (rows.length === 0) return c.json({ error: "track_not_found" }, 404);
  const track = rows[0];
  const sp: SpotifyTrackInput = {
    title: track.title,
    artist: track.artist,
    album: track.album,
    duration_ms: track.duration_ms,
  };

  const trace: Record<string, unknown> = { track };

  if (track.isrc) {
    const isrcUrl = `https://openapi.tidal.com/v2/tracks?filter[isrc]=${encodeURIComponent(track.isrc)}&include=artists`;
    const r = await tidalFetch(c.env, isrcUrl);
    const body = r.ok ? await r.json() : await r.text();
    trace.isrc = { url: isrcUrl, status: r.status, body };
  } else {
    trace.isrc = { skipped: "no isrc on track" };
  }

  const fuzzyQuery = `${normaliseTitle(track.artist)} ${normaliseTitle(track.title)}`;
  const fuzzyUrl = `https://openapi.tidal.com/v2/searchResults/${encodeURIComponent(fuzzyQuery)}?include=tracks,artists,albums`;
  const fr = await tidalFetch(c.env, fuzzyUrl);
  if (!fr.ok) {
    trace.fuzzy = { query: fuzzyQuery, url: fuzzyUrl, status: fr.status, body: await fr.text() };
    return c.json(trace);
  }
  const fbody = (await fr.json()) as {
    data?: { relationships?: { tracks?: { data?: Array<{ id: string; type: string }> } } };
    included?: JsonApiResource[];
  };
  const trackRefs = fbody.data?.relationships?.tracks?.data ?? [];
  const idx = buildIncludedIndex(fbody.included ?? []);
  const candidates: Array<ResolvedTidalCandidate & ReturnType<typeof scoreCandidate>> = [];
  for (const ref of trackRefs) {
    if (ref.type !== "tracks") continue;
    const t = lookupIncluded(idx, "tracks", ref.id);
    if (!t) continue;
    const resolved = resolveTrack(t, idx);
    const breakdown = scoreCandidate(sp, resolved);
    candidates.push({ ...resolved, ...breakdown });
  }
  candidates.sort((a, b) => b.total - a.total);
  trace.fuzzy = { query: fuzzyQuery, url: fuzzyUrl, status: fr.status, candidates };

  return c.json(trace);
});

export default debugRoutes;
