import { tokenSortRatio, tokenSetRatio } from "./artist";
import { normaliseTitle, normaliseAlbum, normaliseText } from "./title";

/**
 * Fuzzy-match scoring per F-007 + F-028. Inputs are ALREADY-RESOLVED
 * candidates — fuzzy.ts walks the Tidal JSON:API graph (data + included[])
 * and produces `ResolvedTidalCandidate` values with title/artist/album/
 * duration/isrc already extracted. The scorer does no parsing; it just
 * computes the weighted score.
 *
 * F-028 changes vs the original F-007 scorer:
 *   1. Title comparison uses tokenSetRatio (robust to asymmetric qualifier
 *      suffixes like `- 2014 Remastered`) instead of tokenSortRatio.
 *   2. Artist comparison passes both sides through normaliseText first so
 *      smart-quote variants (`'` vs `'`) score identically.
 *   3. ISRC-prefix boost: when both sides carry an ISRC and the first 7
 *      characters (CC + registrant + year) match, +0.05 is added to the
 *      total. Surfaced on ScoreBreakdown.isrcPrefixBoost for log auditing.
 *
 * Specs: openspec/changes/flexible-fuzzy-matching/specs/fuzzy-matching/spec.md
 */

const WEIGHTS = { title: 0.40, artist: 0.30, duration: 0.20, album: 0.10 };
const DURATION_CAP_MS = 5000;
const ALBUM_THRESHOLD = 0.9;

// F-028 D5: 7-char prefix = ISO 3901 country (2) + registrant (3) + year (2).
const ISRC_PREFIX_LEN = 7;
const ISRC_PREFIX_BOOST = 0.05;

export interface SpotifyTrackInput {
  title: string;
  artist: string;
  album: string | null;
  duration_ms: number | null;
  /** F-028 D5: optional ISRC enables the prefix tiebreaker. */
  isrc?: string | null;
}

/** A Tidal track candidate after JSON:API resolution. */
export interface ResolvedTidalCandidate {
  /** Tidal track id from the resource object. */
  id: string;
  /** `attributes.title` from the Tidal track resource (default ""). */
  title: string;
  /** `attributes.name` of the first artist resolved via included[] (default ""). */
  primaryArtist: string;
  /**
   * All artists resolved from `relationships.artists.data[]` via included[],
   * in document order. Empty when none resolvable. F-024 (manual picker)
   * renders the full list; F-007 (fuzzy) only consults `primaryArtist`.
   */
  artists: string[];
  /** `attributes.title` of the first album resolved via included[] (default ""). */
  albumTitle: string;
  /** Parsed from `attributes.duration` (ISO-8601), null if missing/unparseable. */
  durationMs: number | null;
  /** `attributes.isrc` from the Tidal track resource, null when absent. */
  isrc: string | null;
}

export interface ScoreBreakdown {
  total: number;
  titleScore: number;
  artistScore: number;
  durationScore: number;
  albumScore: number;
  /** F-028 D5: 0.05 when the ISRC-prefix tiebreaker fired, else 0.0. */
  isrcPrefixBoost: number;
}

/** Compute the weighted score for a single resolved Tidal candidate. */
export function scoreCandidate(
  sp: SpotifyTrackInput,
  td: ResolvedTidalCandidate,
): ScoreBreakdown {
  // F-028 D1+D2: titleScore uses tokenSetRatio to absorb qualifier
  // asymmetry; artistScore keeps tokenSortRatio but with normaliseText
  // applied so smart-quote variants don't break tokenisation parity.
  const titleScore = tokenSetRatio(
    normaliseTitle(sp.title),
    normaliseTitle(td.title),
  );
  const artistScore = tokenSortRatio(
    normaliseText(sp.artist),
    normaliseText(td.primaryArtist),
  );

  const spDuration = sp.duration_ms ?? 0;
  const tdDuration = td.durationMs ?? 0;
  const durationDelta = Math.abs(tdDuration - spDuration);
  const durationScore = 1 - Math.min(durationDelta, DURATION_CAP_MS) / DURATION_CAP_MS;

  const spAlbum = normaliseAlbum(sp.album ?? "");
  const tdAlbum = normaliseAlbum(td.albumTitle);
  const albumScore = tokenSortRatio(spAlbum, tdAlbum) >= ALBUM_THRESHOLD ? 1.0 : 0.0;

  const weightedTotal =
    WEIGHTS.title * titleScore +
    WEIGHTS.artist * artistScore +
    WEIGHTS.duration * durationScore +
    WEIGHTS.album * albumScore;

  // F-028 D5: ISRC-prefix tiebreaker. Both sides must carry a non-null
  // ISRC and share the first 7 characters. The boost stacks; the result
  // is allowed to exceed 1.0 because the threshold gate clamps below.
  const isrcPrefixBoost =
    sp.isrc &&
    td.isrc &&
    sp.isrc.length >= ISRC_PREFIX_LEN &&
    td.isrc.length >= ISRC_PREFIX_LEN &&
    sp.isrc.slice(0, ISRC_PREFIX_LEN) === td.isrc.slice(0, ISRC_PREFIX_LEN)
      ? ISRC_PREFIX_BOOST
      : 0.0;

  return {
    total: weightedTotal + isrcPrefixBoost,
    titleScore,
    artistScore,
    durationScore,
    albumScore,
    isrcPrefixBoost,
  };
}
