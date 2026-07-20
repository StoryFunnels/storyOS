/**
 * Side-effect helper: caps AUTH_SIGNIN_RATE_LIMIT_MAX before the app module is
 * ever imported, following the exact pattern of helpers/throttle-limit.ts —
 * env() reads and caches AUTH_SIGNIN_RATE_LIMIT_MAX when AppModule is
 * evaluated, so the value must be in process.env BEFORE that import, which is
 * why this must be the very first import in any file that uses it. The
 * default test limit is effectively unlimited (1_000_000), so without this a
 * sign-in throttle test could never trip it.
 *
 * process.env is shared across files in a worker, so restoreSignInRateLimit()
 * must run in afterAll to avoid throttling unrelated test files (auth.test.ts
 * signs in more than once) at a limit as low as 3.
 */
const originalMax = process.env.AUTH_SIGNIN_RATE_LIMIT_MAX;
const originalWindow = process.env.AUTH_SIGNIN_RATE_LIMIT_WINDOW_MS;

export const TEST_SIGNIN_RATE_LIMIT = 3;
process.env.AUTH_SIGNIN_RATE_LIMIT_MAX = String(TEST_SIGNIN_RATE_LIMIT);
process.env.AUTH_SIGNIN_RATE_LIMIT_WINDOW_MS = '60000';

export function restoreSignInRateLimit(): void {
  if (originalMax === undefined) delete process.env.AUTH_SIGNIN_RATE_LIMIT_MAX;
  else process.env.AUTH_SIGNIN_RATE_LIMIT_MAX = originalMax;

  if (originalWindow === undefined) delete process.env.AUTH_SIGNIN_RATE_LIMIT_WINDOW_MS;
  else process.env.AUTH_SIGNIN_RATE_LIMIT_WINDOW_MS = originalWindow;
}
