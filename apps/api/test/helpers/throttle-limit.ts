/**
 * Side-effect helper: caps the global per-minute rate limit for a test file that
 * needs to actually reach the throttle. `env()` reads and caches
 * RATE_LIMIT_PER_MINUTE when AppModule is evaluated, so the value has to be in
 * process.env BEFORE the app module is imported — which is why this must be the
 * very first import in any file that uses it. The default test limit is
 * effectively unlimited (1_000_000), so without this a throttle test could never
 * trip.
 *
 * process.env is shared across files in a worker, so restoreRateLimit() must run
 * in afterAll to avoid throttling unrelated test files at limit 5. (This file's
 * own app has already cached the low value, so restoring is safe for it.)
 */
const original = process.env.RATE_LIMIT_PER_MINUTE;

export const TEST_RATE_LIMIT = 5;
process.env.RATE_LIMIT_PER_MINUTE = String(TEST_RATE_LIMIT);

export function restoreRateLimit(): void {
  if (original === undefined) delete process.env.RATE_LIMIT_PER_MINUTE;
  else process.env.RATE_LIMIT_PER_MINUTE = original;
}
