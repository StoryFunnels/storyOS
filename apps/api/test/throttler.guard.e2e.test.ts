// MUST be first: caps RATE_LIMIT_PER_MINUTE before AppModule is imported.
import { TEST_RATE_LIMIT, restoreRateLimit } from './helpers/throttle-limit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';

/**
 * MN-248 — rate-limiter bypass. The guard used to key on the raw Authorization
 * header, so a different random bearer per request minted a fresh bucket and
 * throttling never engaged. These tests exercise the real app end-to-end.
 *
 * NOTE: better-auth's own login routes (`/api/v1/auth/*`) are mounted as raw
 * Fastify routes and bypass this Nest guard entirely, so the "login surface"
 * this guard actually governs is the unauthenticated Nest surface — represented
 * here by the anonymous public-forms endpoint and the guard's IP keying of any
 * non-PAT (session/cookie/bearer) request (see throttler.guard.unit.test.ts).
 */

let app: NestFastifyApplication;
let ownerToken: string;
let wsA: string;
const FORM_TOKEN = 'tok-throttle';

/** A fresh, never-issued PAT-shaped bearer — resolves to nobody. */
const bogusPat = () => `mn_pat_${randomBytes(18).toString('base64url')}`;

function inject(method: string, url: string, opts: { token?: string; bearer?: string; payload?: unknown } = {}) {
  const headers = opts.token
    ? authed(opts.token)
    : opts.bearer
      ? { authorization: `Bearer ${opts.bearer}` }
      : {};
  return app.inject({ method: method as never, url: `/api/v1${url}`, headers, payload: opts.payload as never });
}

beforeAll(async () => {
  app = await createTestApp();
  const owner = await signUpUser(app, 'ThrottleOwner');
  ownerToken = owner.token;
  wsA = (await inject('POST', '/workspaces', { token: ownerToken, payload: { name: 'Throttle WS' } })).json().id;
  const spaceId = (await inject('GET', `/workspaces/${wsA}/spaces`, { token: ownerToken })).json()[0].id;
  const dbId = (
    await inject('POST', `/workspaces/${wsA}/databases`, { token: ownerToken, payload: { space_id: spaceId, name: 'Leads' } })
  ).json().id;
  const dbFields = (await inject('GET', `/workspaces/${wsA}/databases/${dbId}`, { token: ownerToken })).json()
    .fields as Array<{ id: string; type: string; api_name: string }>;
  const nameFieldId = dbFields.find((f) => f.type === 'title' || f.api_name === 'name')!.id;

  const form = await inject('POST', `/workspaces/${wsA}/databases/${dbId}/views`, {
    token: ownerToken,
    payload: {
      name: 'Public form',
      type: 'form',
      config: {
        sorts: [],
        hidden_field_ids: [],
        card_field_ids: [],
        column_widths: {},
        form: {
          title: 'Contact us',
          access: 'public',
          public_token: FORM_TOKEN,
          fields: [{ field_id: nameFieldId, required: true, label: 'Your name' }],
        },
      },
    },
  });
  expect(form.statusCode, form.body).toBe(201);
});

afterAll(async () => {
  await app.close();
  restoreRateLimit();
});

describe('anonymous surface: POST /public/forms/:token (per-IP)', () => {
  // This route carries its own @Throttle override: limit 10 / 60s.
  it('still throttles N+1 requests that each carry a DIFFERENT random bearer', async () => {
    // 10 requests, each with a unique never-issued bearer. With the bug every
    // bearer keyed its own bucket, so none ever counted together. With the fix
    // each resolves to nobody and shares the IP bucket.
    for (let i = 0; i < 10; i++) {
      const res = await inject('POST', `/public/forms/${FORM_TOKEN}`, {
        bearer: bogusPat(),
        payload: { values: { name: `caller-${i}` } },
      });
      expect(res.statusCode, `request ${i} (bearer #${i}) unexpectedly throttled`).not.toBe(429);
    }

    // The 11th request — anonymous, no bearer at all — is refused. The only way
    // it can be over the limit is if the 10 bogus-bearer requests were counted
    // into this very same per-IP bucket. This is the core regression proof.
    const overflow = await inject('POST', `/public/forms/${FORM_TOKEN}`, {
      payload: { values: { name: 'over-the-limit' } },
    });
    expect(overflow.statusCode, 'N+1 request must be throttled (429)').toBe(429);
  });

  it('counts two different invalid tokens from one IP together', async () => {
    // The bucket is already at/over its limit from the test above (same IP, same
    // route, same 60s window), so any further invalid-token request is refused —
    // demonstrating invalid tokens never got private buckets.
    const a = await inject('POST', `/public/forms/${FORM_TOKEN}`, { bearer: bogusPat(), payload: { values: { name: 'a' } } });
    const b = await inject('POST', `/public/forms/${FORM_TOKEN}`, { bearer: bogusPat(), payload: { values: { name: 'b' } } });
    expect(a.statusCode).toBe(429);
    expect(b.statusCode).toBe(429);
  });
});

describe('authenticated surface: per-PAT buckets', () => {
  it('gives each valid PAT its own bucket — one user is not throttled by another', async () => {
    // Two DIFFERENT users, each with their own valid PAT.
    const ua = await signUpUser(app, 'PatUserA');
    const wsUa = (await inject('POST', '/workspaces', { token: ua.token, payload: { name: 'UA WS' } })).json().id;
    const patA = (await inject('POST', '/me/tokens', { token: ua.token, payload: { name: 'A', workspace_id: wsUa } })).json().token;

    const ub = await signUpUser(app, 'PatUserB');
    const wsUb = (await inject('POST', '/workspaces', { token: ub.token, payload: { name: 'UB WS' } })).json().id;
    const patB = (await inject('POST', '/me/tokens', { token: ub.token, payload: { name: 'B', workspace_id: wsUb } })).json().token;

    expect(patA).toMatch(/^mn_pat_/);
    expect(patB).toMatch(/^mn_pat_/);

    // Exhaust PAT-A's private bucket on GET /me (global limit = TEST_RATE_LIMIT).
    for (let i = 0; i < TEST_RATE_LIMIT; i++) {
      const ok = await inject('GET', '/me', { token: patA });
      expect(ok.statusCode, `PAT-A request ${i} should be allowed`).toBe(200);
    }
    const blockedA = await inject('GET', '/me', { token: patA });
    expect(blockedA.statusCode, 'PAT-A is over its own limit').toBe(429);

    // PAT-B is a different principal → different bucket → still fine. A caller
    // cannot be throttled by another caller's traffic.
    const okB = await inject('GET', '/me', { token: patB });
    expect(okB.statusCode, "PAT-B must NOT share PAT-A's exhausted bucket").toBe(200);
  });
});
