import { describe, expect, it } from 'vitest';
import { availabilityFor } from './availability';
import { metaProvider, META_SCOPES, pagesFromGraph } from './meta';
import { PROVIDER_REGISTRY } from './index';
import type { ConnectionFetcher } from './types';

/**
 * Ticket #51 — the Meta connection provider. Every call here goes through a fake fetcher and every credential is a
 * made-up string: nothing reaches Meta and no app exists.
 */
type Answer = { status: number; json?: unknown };
function script(answers: Array<[(url: string, init: Parameters<ConnectionFetcher>[1]) => boolean, Answer]>) {
  const calls: Array<{ url: string; init: Parameters<ConnectionFetcher>[1] }> = [];
  const fetcher: ConnectionFetcher = async (url, init) => {
    calls.push({ url, init });
    const hit = answers.find(([match]) => match(url, init));
    if (!hit) return { status: 500, json: async () => ({}), text: async () => '' };
    return { status: hit[1].status, json: async () => hit[1].json ?? {}, text: async () => '' };
  };
  return { fetcher, calls };
}

const CTX = { clientId: 'app-id-not-real', clientSecret: 'app-secret-not-real' };
const LONG = { access_token: 'long-user-token-not-real', expires_in: 5_184_000 };
const ACCOUNTS = {
  data: [
    { id: '1001', name: 'Foxglove Florist', access_token: 'page-token-1-not-real', instagram_business_account: { id: '17841400000000001', username: 'foxglove' } },
    { id: '1002', name: 'Hollow Oak Books', access_token: 'page-token-2-not-real' },
    { id: 'not-numeric', name: 'Bad', access_token: 'x' },
    { id: '1003', name: 'No token page' },
  ],
};

describe('the descriptor declares what it is (CLAUDE.md "Adding an integration")', () => {
  it('is registered, Tier B oauth_managed, with its operator env names and least-privilege scopes', () => {
    expect(PROVIDER_REGISTRY.get('meta')).toBe(metaProvider);
    expect(metaProvider.tier).toBe('oauth_managed');
    expect(metaProvider.authKind).toBe('oauth2');
    expect(metaProvider.oauth).toMatchObject({ clientIdEnv: 'META_APP_ID', clientSecretEnv: 'META_APP_SECRET', scopeSeparator: ',' });
    expect(META_SCOPES).toEqual(['pages_show_list', 'pages_read_engagement', 'pages_manage_posts', 'instagram_basic', 'instagram_content_publish']);
    // nothing broader than posting to Pages and Instagram
    for (const wider of ['business_management', 'pages_messaging', 'ads_management', 'pages_manage_ads', 'instagram_manage_messages']) {
      expect(META_SCOPES).not.toContain(wider);
    }
  });
});

describe('availability across both deployment modes and the operator env (Tier B truth table)', () => {
  const PRESENT = { META_APP_ID: 'id', META_APP_SECRET: 'secret' };
  const HALF = { META_APP_ID: 'id' };
  it('env present: connectable in both modes', () => {
    for (const isHosted of [true, false]) expect(availabilityFor(metaProvider, { isHosted, env: PRESENT })).toBe('connectable');
  });
  it('env absent: self-managed is operator_config (never a dead Connect button, never the cloud_only upsell); hosted stays connectable', () => {
    expect(availabilityFor(metaProvider, { isHosted: false, env: {} })).toBe('operator_config');
    expect(availabilityFor(metaProvider, { isHosted: true, env: {} })).toBe('connectable');
  });
  it('half-configured (id without secret) is NOT configured on self-managed', () => {
    expect(availabilityFor(metaProvider, { isHosted: false, env: HALF })).toBe('operator_config');
  });
});

describe('finishOAuth: short-lived -> long-lived token, then the granted pages', () => {
  it('seals the long-lived user token and every page with its OWN token; drops malformed pages; scopes carry no tokens', async () => {
    const { fetcher, calls } = script([
      [(u) => u.endsWith('/oauth/access_token'), { status: 200, json: LONG }],
      [(u) => u.includes('/me/accounts'), { status: 200, json: ACCOUNTS }],
    ]);
    const out = await metaProvider.finishOAuth!({ access_token: 'short-token-not-real' }, CTX, fetcher);
    const auth = out.auth as { user_token: string; user_token_expires_at?: number; pages: Array<Record<string, string>>; expires_at?: unknown; refresh_token?: unknown };
    expect(auth.user_token).toBe('long-user-token-not-real');
    expect(auth.pages).toEqual([
      { page_id: '1001', name: 'Foxglove Florist', page_token: 'page-token-1-not-real', ig_user_id: '17841400000000001', ig_username: 'foxglove' },
      { page_id: '1002', name: 'Hollow Oak Books', page_token: 'page-token-2-not-real' },
    ]);
    // no top-level expires_at / refresh_token: the generic refresh sweep must never flag a Meta connection expired for lacking a refresh grant
    expect(auth.expires_at).toBeUndefined();
    expect(auth.refresh_token).toBeUndefined();
    expect(auth.user_token_expires_at).toBeGreaterThan(Date.now());
    expect(out.scopes).toEqual(META_SCOPES);
    expect(JSON.stringify(out.scopes)).not.toContain('token');

    // the app secret and the user token travel in the POST body / Authorization header, never in a URL
    const exchange = calls[0]!;
    expect(exchange.init.method).toBe('POST');
    expect(exchange.init.body).toContain('grant_type=fb_exchange_token');
    expect(exchange.init.body).toContain('fb_exchange_token=short-token-not-real');
    for (const c of calls) {
      expect(c.url).not.toContain('secret');
      expect(c.url).not.toContain('token-not-real');
    }
    expect(calls[1]!.init.headers?.authorization).toBe('Bearer long-user-token-not-real');
  });

  it('a refused extension, a missing token or a connection with no pages is a safe 422 that carries no provider text', async () => {
    const refused = script([[(u) => u.endsWith('/oauth/access_token'), { status: 400, json: { error: { message: 'secret detail long-user-token-not-real' } } }]]);
    await expect(metaProvider.finishOAuth!({ access_token: 's' }, CTX, refused.fetcher)).rejects.toThrow(/did not extend the connection \(HTTP 400\)/);
    await expect(metaProvider.finishOAuth!({ access_token: 's' }, CTX, refused.fetcher)).rejects.not.toThrow(/long-user-token/);

    const noToken = script([[(u) => u.endsWith('/oauth/access_token'), { status: 200, json: {} }]]);
    await expect(metaProvider.finishOAuth!({ access_token: 's' }, CTX, noToken.fetcher)).rejects.toThrow(/did not extend/);

    const noPages = script([
      [(u) => u.endsWith('/oauth/access_token'), { status: 200, json: LONG }],
      [(u) => u.includes('/me/accounts'), { status: 200, json: { data: [] } }],
    ]);
    await expect(metaProvider.finishOAuth!({ access_token: 's' }, CTX, noPages.fetcher)).rejects.toThrow(/No Facebook Pages were granted/);

    const listRefused = script([
      [(u) => u.endsWith('/oauth/access_token'), { status: 200, json: LONG }],
      [(u) => u.includes('/me/accounts'), { status: 403 }],
    ]);
    await expect(metaProvider.finishOAuth!({ access_token: 's' }, CTX, listRefused.fetcher)).rejects.toThrow(/did not list the pages for this connection \(HTTP 403\)/);
  });
});

describe('healthCheck', () => {
  it('passes on a 200, fails with the HTTP status only on a refusal, and needs a token', async () => {
    const ok = script([[(u) => u.includes('/me?fields=id'), { status: 200, json: { id: '1' } }]]);
    await expect(metaProvider.healthCheck({ user_token: 'long-user-token-not-real', pages: [] }, ok.fetcher)).resolves.toBeUndefined();
    expect(ok.calls[0]!.init.headers?.authorization).toBe('Bearer long-user-token-not-real');
    expect(ok.calls[0]!.url).not.toContain('long-user-token');

    const bad = script([[() => true, { status: 400, json: { error: { code: 190, message: 'raw provider text' } } }]]);
    await expect(metaProvider.healthCheck({ user_token: 't' }, bad.fetcher)).rejects.toThrow('Meta token check failed (HTTP 400)');
    await expect(metaProvider.healthCheck({}, ok.fetcher)).rejects.toThrow(/missing its access token/);
  });
});

describe('pagesFromGraph', () => {
  it('keeps only numeric ids with a token, once each', () => {
    const pages = pagesFromGraph({ data: [...ACCOUNTS.data, { id: '1001', name: 'dup', access_token: 'dup' }] });
    expect(pages.map((p) => p.page_id)).toEqual(['1001', '1002']);
  });
});
