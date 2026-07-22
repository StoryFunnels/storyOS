/**
 * MN-253 — a pure, continuously-refilling token bucket for per-connection
 * rate limits. Pure functions (not a class holding state) so JobRunnerService
 * can persist `TokenBucketState` straight into `connections.connection_rate_state`
 * (jsonb) between calls — the bucket has no memory of its own across a
 * restart, the column does.
 */
export interface TokenBucketState {
  tokens: number;
  /** ISO timestamp of the instant `tokens` was last accurate. */
  lastRefillAt: string;
}

export interface TokenBucketConfig {
  /** Bucket size — also the burst allowance. */
  capacity: number;
  /** Milliseconds to refill the bucket from empty to `capacity`. */
  refillMs: number;
}

/** A full bucket — what a connection starts with the first time it's rate-limited. */
export function freshBucket(config: TokenBucketConfig, now = Date.now()): TokenBucketState {
  return { tokens: config.capacity, lastRefillAt: new Date(now).toISOString() };
}

/**
 * Attempt to take one token. Refills continuously based on elapsed time since
 * `state.lastRefillAt` (or treats a missing/corrupt state as a fresh bucket)
 * so a burst after a long idle period isn't penalized. Always returns a new
 * state to persist, whether or not the take succeeded — the refill still
 * happened.
 */
export function takeToken(
  state: TokenBucketState | null | undefined,
  config: TokenBucketConfig,
  now = Date.now(),
): { allowed: boolean; state: TokenBucketState } {
  const prior = state && Number.isFinite(state.tokens) ? state : freshBucket(config, now);
  const elapsedMs = Math.max(0, now - new Date(prior.lastRefillAt).getTime());
  const refillRatePerMs = config.capacity / config.refillMs;
  const refilled = Math.min(config.capacity, prior.tokens + elapsedMs * refillRatePerMs);
  const allowed = refilled >= 1;
  return {
    allowed,
    state: {
      tokens: allowed ? refilled - 1 : refilled,
      lastRefillAt: new Date(now).toISOString(),
    },
  };
}
