import type { FastifyRequest } from 'fastify';
import { ThrottlerStorage } from '@nestjs/throttler';
import { env } from '../config/env';

/**
 * Rate limiting for better-auth's sign-in routes (MN-257).
 *
 * better-auth is mounted directly on the raw Fastify instance (see
 * mountAuthHandler in app.setup.ts) specifically so it can hand requests to
 * better-auth's own WHATWG handler outside Nest's pipeline. That also means it
 * bypasses ApiThrottlerGuard (MN-248) — the app's only rate limiter, and a
 * Nest guard, so it never runs for routes that never enter Nest's router.
 * Repeated failed sign-in attempts were therefore completely unthrottled: a
 * distinct gap from MN-248, not fixed by it.
 *
 * Keying: IP + email, not IP alone. A pure-IP bucket would let one failed
 * sign-in from a shared address (office NAT, campus wifi, a VPN exit node)
 * throttle every *other* account behind that same IP — a stranger's bad
 * password becomes your login outage. Keying on (ip, email) keeps each
 * account's lockout independent of its neighbors on the same network. The
 * accepted trade-off: an attacker who varies the *email* per attempt (user
 * enumeration, low-and-slow credential stuffing across many accounts from one
 * IP) is not slowed by this bucket alone — that's a different, broader attack
 * shape than the "repeated attempts against one account" this ticket scopes.
 * Requests with no identifiable email (malformed body, non-email sign-in
 * methods) fall back to an IP-only bucket so they are not unthrottled either.
 *
 * IP resolution reuses `request.ip` — Fastify's trustProxy-aware client
 * address (trustProxy pinned to the single Caddy hop in main.ts) — the exact
 * mechanism ApiThrottlerGuard already uses (see throttler.guard.ts). Reading
 * a raw header here instead (e.g. X-Forwarded-For directly) would reopen the
 * MN-248 bug class: a value the caller fully controls, and can rotate per
 * request to mint a fresh bucket every time.
 *
 * Storage: the same ThrottlerStorage instance @nestjs/throttler already
 * provides for ApiThrottlerGuard (an in-memory Map by default), under a
 * distinct key/throttler-name prefix so it can't collide with that guard's
 * buckets. No new dependency, no new table, no migration.
 */
const SIGN_IN_PATH_PREFIX = '/api/v1/auth/sign-in';
const THROTTLER_NAME = 'auth-sign-in';

/** Whether `path` (no query string) is one of better-auth's sign-in routes. */
export function isSignInPath(path: string): boolean {
  return path === SIGN_IN_PATH_PREFIX || path.startsWith(`${SIGN_IN_PATH_PREFIX}/`);
}

function extractEmail(body: unknown): string | undefined {
  if (body && typeof body === 'object' && 'email' in body) {
    const email = (body as { email?: unknown }).email;
    if (typeof email === 'string' && email.trim().length > 0) return email.trim().toLowerCase();
  }
  return undefined;
}

/** The bucket key for a sign-in request: `ip:email` when an email is present, else just `ip`. */
export function signInRateLimitKey(request: FastifyRequest): string {
  const ip = request.ip || 'anonymous';
  const email = extractEmail(request.body);
  return email ? `${ip}:${email}` : ip;
}

export interface SignInRateLimitResult {
  allowed: boolean;
  /** Seconds until the caller may retry. 0 when `allowed` is true. */
  retryAfterSeconds: number;
}

/**
 * Checks and consumes one hit against the sign-in rate limit for `request`.
 * Called for every request to a sign-in route regardless of outcome
 * (success or failure both count) — matching better-auth's own built-in
 * special-cased sign-in rule, which treats the route itself as sensitive.
 */
export async function checkSignInRateLimit(
  storage: ThrottlerStorage,
  request: FastifyRequest,
): Promise<SignInRateLimitResult> {
  const key = `${THROTTLER_NAME}:${signInRateLimitKey(request)}`;
  const { AUTH_SIGNIN_RATE_LIMIT_MAX: limit, AUTH_SIGNIN_RATE_LIMIT_WINDOW_MS: ttl } = env();
  const record = await storage.increment(key, ttl, limit, ttl, THROTTLER_NAME);
  return {
    allowed: !record.isBlocked,
    retryAfterSeconds: record.isBlocked ? Math.max(1, record.timeToBlockExpire) : 0,
  };
}
