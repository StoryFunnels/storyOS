import { describe, expect, it, vi } from 'vitest';
import { Reflector } from '@nestjs/core';
import { ApiThrottlerGuard } from '../src/common/throttler.guard';
import type { TokensService } from '../src/tokens/tokens.service';

/**
 * Drives the guard's keying (getTracker) directly — deterministic and without a
 * live proxy. The end-to-end throttling behaviour is proven separately in
 * throttler.guard.e2e.test.ts; here we pin down exactly what each request keys
 * on, which is the heart of the MN-248 fix.
 */

function makeGuard(identify: (t: string) => Promise<string | null>) {
  const tokens = { identify: vi.fn(identify) } as unknown as TokensService & {
    identify: ReturnType<typeof vi.fn>;
  };
  // The base ThrottlerGuard constructor only assigns these onto `this`; stubs
  // are enough because getTracker touches none of them.
  const options = { throttlers: [{ ttl: 60_000, limit: 5 }] } as never;
  const storage = {} as never;
  const guard = new ApiThrottlerGuard(options, storage, new Reflector(), tokens);
  return { guard, identify: tokens.identify };
}

function getTracker(guard: ApiThrottlerGuard, req: unknown): Promise<string> {
  return (guard as unknown as { getTracker(r: unknown): Promise<string> }).getTracker(req);
}

const reqWith = (headers: Record<string, string>, ip = '1.2.3.4') => ({ headers, ip });

describe('ApiThrottlerGuard.getTracker (MN-248)', () => {
  it('keys a resolved PAT on its sha256 identity, not the raw header', async () => {
    const { guard, identify } = makeGuard(async () => 'HASH_A');
    const key = await getTracker(guard, reqWith({ authorization: 'Bearer mn_pat_realtoken' }));
    expect(key).toBe('pat:HASH_A');
    expect(identify).toHaveBeenCalledWith('mn_pat_realtoken');
  });

  it('gives two different valid PATs two different buckets (not collapsed)', async () => {
    const { guard } = makeGuard(async (t) => (t === 'mn_pat_a' ? 'HASH_A' : 'HASH_B'));
    const a = await getTracker(guard, reqWith({ authorization: 'Bearer mn_pat_a' }));
    const b = await getTracker(guard, reqWith({ authorization: 'Bearer mn_pat_b' }));
    expect(a).toBe('pat:HASH_A');
    expect(b).toBe('pat:HASH_B');
    expect(a).not.toBe(b);
  });

  it('an unresolvable/invalid PAT falls back to the IP bucket — never its own', async () => {
    const { guard } = makeGuard(async () => null);
    // Two DIFFERENT invalid tokens from the same IP must land in the SAME bucket.
    const one = await getTracker(guard, reqWith({ authorization: 'Bearer mn_pat_bogus1' }, '9.9.9.9'));
    const two = await getTracker(guard, reqWith({ authorization: 'Bearer mn_pat_bogus2' }, '9.9.9.9'));
    expect(one).toBe('ip:9.9.9.9');
    expect(two).toBe('ip:9.9.9.9');
  });

  it('an anonymous request keys on client IP without a token lookup', async () => {
    const { guard, identify } = makeGuard(async () => 'unused');
    const key = await getTracker(guard, reqWith({}, '5.6.7.8'));
    expect(key).toBe('ip:5.6.7.8');
    expect(identify).not.toHaveBeenCalled();
  });

  it('a session/login-surface request (non-PAT bearer or cookie) keys on IP, not the credential', async () => {
    const { guard, identify } = makeGuard(async () => 'unused');
    // A better-auth session bearer is varyable per request just like a random
    // token, so it must NOT mint its own bucket either.
    const session = await getTracker(guard, reqWith({ authorization: 'Bearer sess_abc' }, '5.6.7.8'));
    const cookie = await getTracker(guard, reqWith({ cookie: 'better-auth.session=xyz' }, '5.6.7.8'));
    expect(session).toBe('ip:5.6.7.8');
    expect(cookie).toBe('ip:5.6.7.8');
    // Not a mn_pat_ bearer → no DB lookup attempted.
    expect(identify).not.toHaveBeenCalled();
  });
});
