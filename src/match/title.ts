const STRIP_PATTERNS = [
  /\(\s*\d{4}\s*remaster(?:ed)?\s*\)/gi,
  /\(\s*remaster(?:ed)?\s*\d*\s*\)/gi,
  /\(\s*feat(?:uring)?\.?\s+[^)]*\)/gi,
  /\(\s*ft\.?\s+[^)]*\)/gi,
  /\(\s*\d{4}\s*\)/g,
  /\s+-\s+single\s+version/gi,
  /\s+-\s+radio\s+edit/gi,
  /\s+-\s+remaster(?:ed)?/gi,
  /\s+-\s+mono/gi,
  /\s+-\s+stereo/gi,
];

/**
 * Strips remaster/year/feat./variant suffixes from a track title.
 * If stripping produces an empty string, falls back to the original title.
 */
export function normaliseTitle(title: string): string {
  let s = title;
  for (const pattern of STRIP_PATTERNS) {
    s = s.replace(pattern, "");
  }
  s = s.trim();
  return s.length > 0 ? s : title.trim();
}

/** Same normalisation applied to album names for album score. */
export function normaliseAlbum(album: string): string {
  return normaliseTitle(album);
}
