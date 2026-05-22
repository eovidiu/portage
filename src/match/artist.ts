/** Levenshtein distance via standard DP, O(m*n) time and space. */
function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1]
          : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

/** Levenshtein similarity ratio in [0,1]. */
function ratio(a: string, b: string): number {
  if (a.length === 0 && b.length === 0) return 1;
  const maxLen = Math.max(a.length, b.length);
  return (maxLen - levenshtein(a, b)) / maxLen;
}

/**
 * Token-sort ratio: split on whitespace, sort tokens, rejoin, then compute
 * Levenshtein-based similarity ratio. Standard rapidfuzz definition.
 */
export function tokenSortRatio(a: string, b: string): number {
  const sort = (s: string) =>
    s
      .split(/\s+/)
      .filter(Boolean)
      .sort()
      .join(" ");
  return ratio(sort(a), sort(b));
}

/**
 * F-028: token-set ratio per rapidfuzz/fuzzywuzzy definition. Tokenises
 * both inputs, splits into intersection vs symmetric difference, and
 * returns the max of three Levenshtein similarity ratios:
 *
 *   r1 = similarity(intersection, intersection + diff_a)
 *   r2 = similarity(intersection, intersection + diff_b)
 *   r3 = similarity(intersection + diff_a, intersection + diff_b)
 *
 * Robust to one side carrying an extra qualifier the other does not
 * — e.g. "Swallowed - 2014 Remastered" vs "Swallowed" returns ~1.0,
 * whereas tokenSortRatio returns ~0.55.
 *
 * See openspec/changes/flexible-fuzzy-matching/design.md D1 for why this
 * is the right primitive for the title-component miss class.
 */
export function tokenSetRatio(a: string, b: string): number {
  const toSet = (s: string) =>
    new Set(s.split(/\s+/).filter(Boolean));
  const setA = toSet(a);
  const setB = toSet(b);

  const intersection: string[] = [];
  const diffA: string[] = [];
  const diffB: string[] = [];
  for (const t of setA) {
    if (setB.has(t)) intersection.push(t);
    else diffA.push(t);
  }
  for (const t of setB) {
    if (!setA.has(t)) diffB.push(t);
  }
  intersection.sort();
  diffA.sort();
  diffB.sort();

  const join = (parts: string[]) => parts.join(" ");
  const inter = join(intersection);
  const interPlusA = [inter, join(diffA)].filter(Boolean).join(" ");
  const interPlusB = [inter, join(diffB)].filter(Boolean).join(" ");

  // Empty-intersection pathology: ratio(inter, X) and ratio(inter, X')
  // both reduce to ratio("", X) and ratio("", X'). The max picks up
  // ratio("","") = 1 whenever either diff is empty (e.g. one side is
  // entirely the empty string), producing a spurious perfect match.
  // Standard rapidfuzz mitigation: when no tokens overlap, fall back to
  // direct similarity of the two diff-string remainders. ratio("", "X")
  // is 0, so an empty input correctly scores 0 against a non-empty one.
  if (intersection.length === 0) {
    return ratio(join(diffA), join(diffB));
  }

  return Math.max(
    ratio(inter, interPlusA),
    ratio(inter, interPlusB),
    ratio(interPlusA, interPlusB),
  );
}

function normalise(s: string): string {
  return s
    .toLowerCase()
    .replace(/\bfeat(uring|\.?)\b.*$/i, "")
    .replace(/\bft\.?\b.*$/i, "")
    .replace(/\([^)]*\)/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .trim();
}

const ARTIST_THRESHOLD = 0.85;

/** Returns true when spotifyArtist and tidalArtist refer to the same artist. */
export function artistAgrees(spotifyArtist: string, tidalArtist: string): boolean {
  const a = normalise(spotifyArtist);
  const b = normalise(tidalArtist);
  return tokenSortRatio(a, b) >= ARTIST_THRESHOLD;
}
