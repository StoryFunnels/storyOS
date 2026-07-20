// MUST be first: caps AUTH_SIGNIN_RATE_LIMIT_MAX before AppModule is imported.
import { TEST_SIGNIN_RATE_LIMIT, restoreSignInRateLimit } from './helpers/auth-rate-limit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';

/**
 * MN-257 — better-auth's sign-in routes (`/api/v1/auth/sign-in/*`) are mounted
 * directly on the raw Fastify instance (app.setup.ts → mountAuthHandler) and
 * bypass Nest's entire guard chain, including ApiThrottlerGuard (MN-248). That
 * guard's fix does NOT cover this surface — these tests exercise the real,
 * wired-up route end-to-end (via app.inject, the full Fastify dispatch path)
 * to prove the gap is closed, not a mocked unit test of a helper in isolation.
 */

let app: NestFastifyApplication;
const PASSWORD = 'correct-horse-battery-staple';

async function signUp(app: NestFastifyApplication, email: string) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/sign-up/email',
    payload: { email, password: PASSWORD, name: 'Rate Limit Test' },
  });
  expect(res.statusCode, `signup for ${email} failed: ${res.body}`).toBe(200);
}

function signIn(app: NestFastifyApplication, email: string, password: string, extraHeaders?: Record<string, string>) {
  return app.inject({
    method: 'POST',
    url: '/api/v1/auth/sign-in/email',
    headers: extraHeaders,
    payload: { email, password },
  });
}

beforeAll(async () => {
  app = await createTestApp();
});

afterAll(async () => {
  await app.close();
  restoreSignInRateLimit();
});

describe('better-auth sign-in rate limiting (MN-257)', () => {
  it('throttles repeated failed sign-in attempts from one source (429)', async () => {
    const email = `mn257-a-${Date.now()}@test.storyos.dev`;
    await signUp(app, email);

    for (let i = 0; i < TEST_SIGNIN_RATE_LIMIT; i++) {
      const res = await signIn(app, email, 'wrong-password');
      expect(res.statusCode, `attempt ${i} should fail auth but not yet be throttled`).toBe(401);
    }

    // One more attempt past the limit: refused before it ever reaches better-auth.
    const blocked = await signIn(app, email, 'wrong-password');
    expect(blocked.statusCode, 'must be throttled after repeated failures').toBe(429);
    expect(blocked.headers['retry-after']).toBeTruthy();

    // Even the *correct* password no longer gets through once the bucket is
    // blocked — the limiter guards the endpoint, not just failed attempts.
    const correctButBlocked = await signIn(app, email, PASSWORD);
    expect(correctButBlocked.statusCode, 'the correct password does not bypass an active block').toBe(429);
  });

  it('cannot be bypassed by varying X-Forwarded-For per request', async () => {
    const email = `mn257-b-${Date.now()}@test.storyos.dev`;
    await signUp(app, email);

    // Same bug class as MN-248: if the key were read from a client-supplied
    // header instead of the trustProxy-resolved request.ip, a different value
    // per request would mint a fresh bucket every time and throttling would
    // never engage. request.ip is constant here (the test app has no
    // configured proxy hop, exactly like an untrusted direct connection), so
    // if the code under test read the header directly these requests would
    // each land in their own bucket and never trip the limit below.
    for (let i = 0; i < TEST_SIGNIN_RATE_LIMIT; i++) {
      const res = await signIn(app, email, 'wrong-password', { 'x-forwarded-for': `10.0.0.${i}` });
      expect(res.statusCode, `attempt ${i} should fail auth but not yet be throttled`).toBe(401);
    }

    const overflow = await signIn(app, email, 'wrong-password', { 'x-forwarded-for': '203.0.113.99' });
    expect(overflow.statusCode, 'a spoofed X-Forwarded-For must not open a new bucket').toBe(429);
  });

  it('gives each email its own bucket on a shared IP — a neighbor is not collaterally locked out', async () => {
    // The two tests above have already exhausted their respective (ip, email)
    // buckets on this shared (loopback) IP. A different account behind the
    // very same IP must still be able to sign in — proving the key includes
    // the email, not just the IP, exactly the shared-IP trade-off this
    // ticket's design deliberately accepts (see auth-rate-limit.ts comment).
    const neighbor = `mn257-neighbor-${Date.now()}@test.storyos.dev`;
    await signUp(app, neighbor);

    const res = await signIn(app, neighbor, PASSWORD);
    expect(res.statusCode, "a different account behind the same IP isn't locked out by someone else's failures").toBe(200);
  });
});
