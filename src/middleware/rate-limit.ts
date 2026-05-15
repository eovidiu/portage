// F-024 R4: token-bucket rate limit, 10 req / 60 s per CF Access principal.
//
// State lives in a module-scope Map for the warm isolate lifetime. Across
// isolates the limit is effectively per-isolate — acceptable for v1, single
// tenant. Upgrade path is KV / Durable Objects (non-breaking).

const CAPACITY = 10;
const REFILL_PER_MS = CAPACITY / 60_000;

type Bucket = { tokens: number; lastRefillMs: number };

const buckets = new Map<string, Bucket>();

function refill(bucket: Bucket, nowMs: number): void {
  const elapsed = nowMs - bucket.lastRefillMs;
  if (elapsed <= 0) return;
  bucket.tokens = Math.min(CAPACITY, bucket.tokens + elapsed * REFILL_PER_MS);
  bucket.lastRefillMs = nowMs;
}

export type TakeResult =
  | { allowed: true }
  | { allowed: false; retryAfterSec: number };

export function takeToken(principal: string): TakeResult {
  const now = Date.now();
  let bucket = buckets.get(principal);
  if (!bucket) {
    bucket = { tokens: CAPACITY, lastRefillMs: now };
    buckets.set(principal, bucket);
  } else {
    refill(bucket, now);
  }

  if (bucket.tokens >= 1) {
    bucket.tokens -= 1;
    return { allowed: true };
  }

  // The bucket needs `1 - bucket.tokens` more tokens before another take
  // succeeds. Convert to seconds and round up so callers get a Retry-After
  // value that, once elapsed, actually guarantees a successful take.
  const msUntilNextToken = (1 - bucket.tokens) / REFILL_PER_MS;
  const retryAfterSec = Math.max(1, Math.ceil(msUntilNextToken / 1000));
  return { allowed: false, retryAfterSec };
}

/** Test helper. Production code SHALL NOT call this. */
export function _resetBuckets(): void {
  buckets.clear();
}
