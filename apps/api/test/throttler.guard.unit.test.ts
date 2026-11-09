import { describe, expect, it, vi } from 'vitest';
import { Reflector } from '@nestjs/core';
import { ApiThrottlerGuard } from '../src/common/throttler.guard';
import type { TokensService } from '../src/tokens/tokens.service';
import type { RunnersService } from '../src/runners/runners.service';
import type { Db } from '../src/db/client';
import { oauthAccessToken, session } from '../src/db/schema';

/**
 * #1043: a stand-in for the two indexed lookups the guard makes. `sessions` / `oauth` map a token to its user; anything else
 * (an unknown or expired token) is "no row". `lookups` counts the queries made.
 */
function fakeDb(sessions: Record<string, string> = {}, oauth: Record<string, string> = {}) {
  const lookups: string[] = [];
  const db = {
    select: () => ({
      from: (table: unknown) => ({
        where: (cond: unknown) => ({
          limit: async () => {
            const kind = table === session ? 'session' : table === oauthAccessToken ? 'oauth' : 'other';
            lookups.push(kind);
            const wanted = JSON.stringify(cond, (_k, v) => (typeof v === 'object' && v !== null && 'table' in v ? undefined : v));
            const map = kind === 'session' ? sessions : kind === 'oauth' ? oauth : {};
            for (const [token, userId] of Object.entries(map)) if (wanted.includes(`"${token}"`)) return [{ userId }];
            return [];
          },
        }),
      }),
    }),
  } as unknown as Db;
  return { db, lookups };
}

/**
 * Drives the guard's keying (getTracker) directly — deterministic and without a
 * live proxy. The end-to-end throttling behaviour is proven separately in
 * throttler.guard.e2e.test.ts; here we pin down exactly what each request keys
 * on, which is the heart of the MN-248 fix.
 */

function makeGuard(identify: (t: string) => Promise<string | null>, db: Db = fakeDb().db) {
  const tokens = { identify: vi.fn(identify) } as unknown as TokensService & {
    identify: ReturnType<typeof vi.fn>;
  };
  const runners = { identify: vi.fn(async () => null) } as unknown as RunnersService;
  // The base ThrottlerGuard constructor only assigns these onto `this`; stubs
  // are enough because getTracker touches none of them.
  const options = { throttlers: [{ ttl: 60_000, limit: 5 }] } as never;
  const storage = {} as never;
  const guard = new ApiThrottlerGuard(options, storage, new Reflector(), tokens, runners, db);
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

  it('a session bearer or cookie that does not resolve keys on IP, never on the credential', async () => {
    const { db } = fakeDb(); // no live sessions
    const { guard, identify } = makeGuard(async () => 'unused', db);
    // A better-auth session value is varyable per request just like a random token, so an unknown one must NOT mint its own bucket.
    const bearer = await getTracker(guard, reqWith({ authorization: 'Bearer sess_abcdefghijklmnopqrstuvwx' }, '5.6.7.8'));
    const cookie = await getTracker(guard, reqWith({ cookie: 'better-auth.session_token=abcdefghijklmnopqrstuvwx.sig' }, '5.6.7.8'));
    expect(bearer).toBe('ip:5.6.7.8');
    expect(cookie).toBe('ip:5.6.7.8');
    // Not a mn_pat_ bearer → no PAT lookup attempted.
    expect(identify).not.toHaveBeenCalled();
  });
});

describe('ApiThrottlerGuard.getTracker: a person, not an address (#1043)', () => {
  const live = { sessA1234567890abcdefgh: 'user-a', sessB1234567890abcdefgh: 'user-b' };
  const oauth = { 'oauth-token-of-user-c-0123456789': 'user-c', 'oauth-token-of-user-d-0123456789': 'user-d' };

  it('a live session cookie (signed, URL-encoded, with or without __Secure-) keys on its user', async () => {
    const { guard } = makeGuard(async () => null, fakeDb(live).db);
    expect(await getTracker(guard, reqWith({ cookie: 'theme=dark; better-auth.session_token=sessA1234567890abcdefgh.c2lnbmF0dXJl%3D' }))).toBe('user:user-a');
    expect(await getTracker(guard, reqWith({ cookie: '__Secure-better-auth.session_token=sessB1234567890abcdefgh.sig' }))).toBe('user:user-b');
  });

  it('a live session as a bearer keys on its user', async () => {
    const { guard } = makeGuard(async () => null, fakeDb(live).db);
    expect(await getTracker(guard, reqWith({ authorization: 'Bearer sessA1234567890abcdefgh' }))).toBe('user:user-a');
  });

  it('hosted-MCP OAuth users arriving from the SAME address (the MCP container) get one bucket EACH', async () => {
    const { guard } = makeGuard(async () => null, fakeDb({}, oauth).db);
    const c = await getTracker(guard, reqWith({ authorization: 'Bearer oauth-token-of-user-c-0123456789' }, '172.18.0.5'));
    const d = await getTracker(guard, reqWith({ authorization: 'Bearer oauth-token-of-user-d-0123456789' }, '172.18.0.5'));
    expect(c).toBe('user:user-c');
    expect(d).toBe('user:user-d');
  });

  it('an unknown or expired OAuth bearer falls to the IP bucket; a PAT is never looked up as a session', async () => {
    const { db, lookups } = fakeDb(live, oauth);
    const { guard } = makeGuard(async () => null, db);
    expect(await getTracker(guard, reqWith({ authorization: 'Bearer oauth-token-nobody-has-0123456789' }, '9.9.9.9'))).toBe('ip:9.9.9.9');
    lookups.length = 0;
    expect(await getTracker(guard, reqWith({ authorization: 'Bearer mn_pat_bogus' }, '9.9.9.9'))).toBe('ip:9.9.9.9');
    expect(lookups).toEqual([]);
  });
});
