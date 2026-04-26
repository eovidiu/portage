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
