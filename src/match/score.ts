import { tokenSortRatio } from "./artist";
import { normaliseTitle, normaliseAlbum } from "./title";

/**
 * Fuzzy-match scoring per F-007. Inputs are ALREADY-RESOLVED candidates —
 * fuzzy.ts walks the Tidal JSON:API graph (data + included[]) and produces
 * `ResolvedTidalCandidate` values with title/artist/album/duration already
 * extracted. The scorer does no parsing; it just computes the weighted score.
 *
 * Spec: docs/specs/F-007-fuzzy-matching.md (R4–R9).
 */

const WEIGHTS = { title: 0.40, artist: 0.30, duration: 0.20, album: 0.10 };
const DURATION_CAP_MS = 5000;
const ALBUM_THRESHOLD = 0.9;

export interface SpotifyTrackInput {
  title: string;
  artist: string;
  album: string | null;
  duration_ms: number | null;
}

/** A Tidal track candidate after JSON:API resolution. */
export interface ResolvedTidalCandidate {
  /** Tidal track id from the resource object. */
  id: string;
  /** `attributes.title` from the Tidal track resource (default ""). */
  title: string;
  /** `attributes.name` of the first artist resolved via included[] (default ""). */
  primaryArtist: string;
  /** `attributes.title` of the first album resolved via included[] (default ""). */
  albumTitle: string;
  /** Parsed from `attributes.duration` (ISO-8601), null if missing/unparseable. */
  durationMs: number | null;
}

export interface ScoreBreakdown {
  total: number;
  titleScore: number;
  artistScore: number;
  durationScore: number;
  albumScore: number;
}

/** Compute the weighted score for a single resolved Tidal candidate. */
export function scoreCandidate(
  sp: SpotifyTrackInput,
  td: ResolvedTidalCandidate,
): ScoreBreakdown {
  const titleScore = tokenSortRatio(normaliseTitle(sp.title), normaliseTitle(td.title));
  const artistScore = tokenSortRatio(sp.artist, td.primaryArtist);

  const spDuration = sp.duration_ms ?? 0;
  const tdDuration = td.durationMs ?? 0;
  const durationDelta = Math.abs(tdDuration - spDuration);
  const durationScore = 1 - Math.min(durationDelta, DURATION_CAP_MS) / DURATION_CAP_MS;

  const spAlbum = normaliseAlbum(sp.album ?? "");
  const tdAlbum = normaliseAlbum(td.albumTitle);
  const albumScore = tokenSortRatio(spAlbum, tdAlbum) >= ALBUM_THRESHOLD ? 1.0 : 0.0;

  const total =
    WEIGHTS.title * titleScore +
    WEIGHTS.artist * artistScore +
    WEIGHTS.duration * durationScore +
    WEIGHTS.album * albumScore;

  return { total, titleScore, artistScore, durationScore, albumScore };
}
