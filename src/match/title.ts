// F-028: shared Unicode normalisation (smart quotes + en/em dashes → ASCII)
// runs ahead of pattern stripping for both title and artist paths. Spotify
// metadata frequently uses U+2019 ("'") while Tidal returns U+0027 ("'") for
// the same recording, which made `It's Never Over` mis-match its own twin
// before the shared normaliser landed. See openspec design.md D4 for the
// full character map.
const SMART_QUOTE_MAP: Array<[RegExp, string]> = [
  [/[‘’]/g, "'"], // smart single quotes → ASCII apostrophe
  [/[“”]/g, '"'], // smart double quotes → ASCII quote
  [/[–—]/g, "-"], // en + em dash → ASCII hyphen
];

/**
 * Apply lossless Unicode normalisation that two sides of a match should
 * agree on regardless of which catalog they came from. Pure function;
 * preserves diacritics and all letter-class characters.
 */
export function normaliseText(input: string): string {
  let s = input;
  for (const [pattern, replacement] of SMART_QUOTE_MAP) {
    s = s.replace(pattern, replacement);
  }
  return s;
}

// F-028: widened to cover the qualifier-suffix classes observed in the
// 2026-05-22 production sample of `fuzzy_below_threshold` rows
// (`- Single Edit`, `- Original`, `- Live`, `- 2014 Remastered`, etc.). See
// openspec design.md D3 + spec.md "Strip-pattern set" for the full table.
const STRIP_PATTERNS = [
  // pre-existing parenthetical patterns
  /\(\s*\d{4}\s*remaster(?:ed)?\s*\)/gi,
  /\(\s*remaster(?:ed)?\s*\d*\s*\)/gi,
  /\(\s*feat(?:uring)?\.?\s+[^)]*\)/gi,
  /\(\s*ft\.?\s+[^)]*\)/gi,
  /\(\s*\d{4}\s*\)/g,
  // pre-existing trailing-suffix patterns
  /\s+-\s+single\s+version\s*$/gi,
  /\s+-\s+radio\s+edit\s*$/gi,
  /\s+-\s+remaster(?:ed)?\s*$/gi,
  /\s+-\s+mono\s*$/gi,
  /\s+-\s+stereo\s*$/gi,
  // F-028 additions — year-remaster combinations
  /\s+-\s+\d{4}\s+remaster(?:ed)?(?:\s+version)?\s*$/gi,
  /\s+-\s+remaster(?:ed)?\s+\d{4}\s*$/gi,
  // F-028 additions — edit + version qualifiers
  /\s+-\s+single\s+edit\s*$/gi,
  /\s+-\s+original\s*$/gi,
  /\s+-\s+bonus\s+track\s*$/gi,
  /\s+-\s+(?:mono|stereo)\s+mix\s*$/gi,
  // F-028 additions — live + recorded-at suffixes
  /\s+-\s+live(?:\s+at\s+.*)?\s*$/gi,
  /\s+-\s+recorded\s+at\s+.*$/gi,
  /\(\s*live(?:\s+at\s+[^)]*)?\s*\)/gi,
];

/**
 * Strips remaster/year/feat./variant suffixes from a track title.
 * Applies Unicode normalisation first so smart-quote variants compare
 * identically. If stripping produces an empty string, falls back to the
 * trimmed (Unicode-normalised) original — never returns "".
 */
export function normaliseTitle(title: string): string {
  let s = normaliseText(title);
  for (const pattern of STRIP_PATTERNS) {
    s = s.replace(pattern, "");
  }
  s = s.trim();
  return s.length > 0 ? s : normaliseText(title).trim();
}

/** Same normalisation applied to album names for album score. */
export function normaliseAlbum(album: string): string {
  return normaliseTitle(album);
}
