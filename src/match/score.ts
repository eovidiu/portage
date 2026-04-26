import { tokenSortRatio } from "./artist";
import { normaliseTitle, normaliseAlbum } from "./title";

const WEIGHTS = { title: 0.40, artist: 0.30, duration: 0.20, album: 0.10 };
const DURATION_CAP_MS = 5000;
const ALBUM_THRESHOLD = 0.9;

export interface SpotifyTrackInput {
  title: string;
  artist: string;
  album: string | null;
  duration_ms: number | null;
}

export interface TidalCandidateInput {
  title?: string;
  artists?: Array<{ name: string }>;
  album?: { title?: string };
  duration?: number;
}

export interface ScoreBreakdown {
  total: number;
  titleScore: number;
  artistScore: number;
  durationScore: number;
  albumScore: number;
}

/** Returns the candidate's duration in ms (Tidal duration field is in seconds). */
export function tidalDurationMs(candidate: TidalCandidateInput): number {
  return typeof candidate.duration === "number" ? candidate.duration * 1000 : 0;
}

/** Compute the weighted score for a single Tidal candidate against a Spotify track. */
export function scoreCandidate(
  sp: SpotifyTrackInput,
  td: TidalCandidateInput,
): ScoreBreakdown {
  const titleScore = tokenSortRatio(
    normaliseTitle(sp.title),
    normaliseTitle(td.title ?? ""),
  );

  const tidalArtist = td.artists?.[0]?.name ?? "";
  const artistScore = tokenSortRatio(sp.artist, tidalArtist);

  const spDuration = sp.duration_ms ?? 0;
  const tdDuration = tidalDurationMs(td);
  const durationDelta = Math.abs(tdDuration - spDuration);
  const durationScore = 1 - Math.min(durationDelta, DURATION_CAP_MS) / DURATION_CAP_MS;

  const spAlbum = normaliseAlbum(sp.album ?? "");
  const tdAlbum = normaliseAlbum(td.album?.title ?? "");
  const albumScore = tokenSortRatio(spAlbum, tdAlbum) >= ALBUM_THRESHOLD ? 1.0 : 0.0;

  const total =
    WEIGHTS.title * titleScore +
    WEIGHTS.artist * artistScore +
    WEIGHTS.duration * durationScore +
    WEIGHTS.album * albumScore;

  return { total, titleScore, artistScore, durationScore, albumScore };
}
