// F-024 R3: map a ResolvedTidalCandidate to the flat response shape the UI
// consumes. The mapper is intentionally separate from search-validation and
// from the route module so the contract can be unit-tested in isolation —
// any change here is a contract change and needs the cross-repo diff to re-run.
//
// Note the deliberate absence of a `confidence` field. Confidence is fuzzy-only
// (F-007 scores against the source Spotify track); manual search has no source
// to score against, so emitting `confidence: null` would mislead the UI.
import type { ResolvedTidalCandidate } from "../match/score";

export interface SearchResponseCandidate {
  tidal_id: string;
  title: string;
  artists: string[];
  album: string | null;
  duration_ms: number;
  isrc: string | null;
}

export function mapCandidateToResponseShape(
  c: ResolvedTidalCandidate,
): SearchResponseCandidate {
  return {
    tidal_id: c.id,
    title: c.title,
    artists: c.artists,
    album: c.albumTitle === "" ? null : c.albumTitle,
    duration_ms: c.durationMs ?? 0,
    isrc: c.isrc,
  };
}
