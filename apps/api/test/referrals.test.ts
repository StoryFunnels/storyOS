import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';
import { StripeService } from '../src/billing/stripe.service';

let app: NestFastifyApplication;

async function as(token: string, method: string, url: string, payload?: unknown) {
  return app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(token), payload: payload as never });
}

beforeAll(async () => {
  app = await createTestApp();
});

afterAll(async () => {
  await app.close();
});

describe('GET /referrals/me — #33 cloud-only gate', () => {
  it('reports referrals as disabled (no STRIPE_SECRET_KEY in test env) — self-host shape', async () => {
    const user = await signUpUser(app, 'ReferralsSelfHost');
    const res = await as(user.token, 'GET', '/referrals/me');
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(body).toEqual({
      enabled: false,
      code: null,
      link: null,
      signups: 0,
      paidConversions: 0,
      rewardCents: 0,
      terms: expect.any(String),
    });
  });

  it('rejects an unauthenticated request', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/referrals/me' });
    expect(res.statusCode).toBe(401);
  });
});

describe('POST /referrals/attribute + GET /referrals/me — on a cloud instance', () => {
  beforeAll(() => {
    // Simulate a cloud instance (Stripe configured) without touching the
    // real Stripe API — every referrals code path this test exercises only
    // ever checks `stripe.enabled`, never `stripe.client`.
    vi.spyOn(app.get(StripeService), 'enabled', 'get').mockReturnValue(true);
  });

  it('gives a user their own stable code and link once cloud is enabled', async () => {
    const referrer = await signUpUser(app, 'ReferralsReferrer');
    const first = (await as(referrer.token, 'GET', '/referrals/me')).json();
    expect(first.enabled).toBe(true);
    expect(first.code).toMatch(/^[A-Z2-9]{8}$/);
    expect(first.link).toBe(`http://localhost:3000/signup?ref=${first.code}`);

    const second = (await as(referrer.token, 'GET', '/referrals/me')).json();
    expect(second.code).toBe(first.code); // stable, not regenerated
  });

  it('attributes a referred sign-up and reflects it in the referrer’s summary', async () => {
    const referrer = await signUpUser(app, 'ReferralsReferrer2');
    const referee = await signUpUser(app, 'ReferralsReferee');
    const { code } = (await as(referrer.token, 'GET', '/referrals/me')).json();

    const attribution = await as(referee.token, 'POST', '/referrals/attribute', { code });
    expect(attribution.statusCode, attribution.body).toBe(201);
    expect(attribution.json()).toEqual({ attributed: true });

    const summary = (await as(referrer.token, 'GET', '/referrals/me')).json();
    expect(summary.signups).toBe(1);
    expect(summary.paidConversions).toBe(0);
    expect(summary.rewardCents).toBe(0);
  });

  it('is idempotent — attributing the same referee twice only counts once', async () => {
    const referrer = await signUpUser(app, 'ReferralsReferrer3');
    const referee = await signUpUser(app, 'ReferralsReferee2');
    const { code } = (await as(referrer.token, 'GET', '/referrals/me')).json();

    await as(referee.token, 'POST', '/referrals/attribute', { code });
    const second = await as(referee.token, 'POST', '/referrals/attribute', { code });
    expect(second.json()).toEqual({ attributed: false });

    const summary = (await as(referrer.token, 'GET', '/referrals/me')).json();
    expect(summary.signups).toBe(1);
  });

  it('refuses a self-referral', async () => {
    const user = await signUpUser(app, 'ReferralsSelf');
    const { code } = (await as(user.token, 'GET', '/referrals/me')).json();

    const res = await as(user.token, 'POST', '/referrals/attribute', { code });
    expect(res.json()).toEqual({ attributed: false });
  });

  it('no-ops on an unknown code', async () => {
    const user = await signUpUser(app, 'ReferralsUnknownCode');
    const res = await as(user.token, 'POST', '/referrals/attribute', { code: 'NOSUCH01' });
    expect(res.json()).toEqual({ attributed: false });
  });
});
