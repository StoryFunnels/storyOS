import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { connectionsRedirectTarget, pageForProvider } from './connections-redirect';
import { coveredConnectionProviders, PROVIDER_PAGES } from './provider-pages';
import { SETTINGS_PATHS_BEFORE_1185 } from './settings-nav';

/** Ticket #1188 AC2 — /connections redirects, keeps its query, and every old URL still resolves. */
const WS = 'ws1';
const page = (rel: string) => fileURLToPath(new URL(`../app/w/[ws]/settings${rel}`, import.meta.url));

describe('/connections redirects, carrying what the OAuth callback and the deep links send', () => {
  it('with nothing, it goes to the Integrations hub', () => {
    expect(connectionsRedirectTarget(WS, {})).toBe('/w/ws1/settings/integrations');
  });

  it('?connected=<provider> lands on that provider’s page, where the "connected" toast is shown', () => {
    expect(connectionsRedirectTarget(WS, { connected: 'google' })).toBe('/w/ws1/settings/integrations/youtube?connected=google');
    expect(connectionsRedirectTarget(WS, { connected: 'google-calendar' })).toBe('/w/ws1/settings/integrations/google-calendar?connected=google-calendar');
    expect(connectionsRedirectTarget(WS, { connected: 'linkedin' })).toBe('/w/ws1/settings/integrations/linkedin?connected=linkedin');
  });

  it('?error= has no provider, so it lands on the hub with the error kept', () => {
    expect(connectionsRedirectTarget(WS, { error: 'access_denied' })).toBe('/w/ws1/settings/integrations?error=access_denied');
  });

  it('?add=<provider>&name= opens the connect form on the provider’s page, pre-named (the old deep links from Shopify and the social pages)', () => {
    expect(connectionsRedirectTarget(WS, { add: 'shopify', name: 'Shopify' })).toBe('/w/ws1/settings/integrations/shopify?add=shopify&name=Shopify');
    expect(connectionsRedirectTarget(WS, { add: 'http', name: 'Meta comments' })).toBe('/w/ws1/settings/integrations/custom-api?add=http&name=Meta+comments');
  });

  it('an unknown provider is not dropped: the hub still gets its toast', () => {
    expect(connectionsRedirectTarget(WS, { connected: 'brandnew' })).toBe('/w/ws1/settings/integrations?connected=brandnew');
    expect(connectionsRedirectTarget(WS, { add: 'brandnew' })).toBe('/w/ws1/settings/integrations');
  });

  it('an array-valued param (a repeated key) uses its first value', () => {
    expect(connectionsRedirectTarget(WS, { connected: ['google', 'x'] })).toBe('/w/ws1/settings/integrations/youtube?connected=google');
  });

  it('every provider in the API credential registry has a page to be sent to', () => {
    for (const id of coveredConnectionProviders()) {
      const target = pageForProvider(id);
      expect(target, id).not.toBeNull();
      expect(PROVIDER_PAGES.some((p) => p.id === target)).toBe(true);
    }
  });

  it('HTTP belongs to Custom API, not to a preset page', () => {
    expect(pageForProvider('http')).toBe('custom-api');
    expect(pageForProvider('smtp')).toBe('email');
    expect(pageForProvider('resend')).toBe('email');
  });
});

describe('the /connections page itself', () => {
  it('is a server redirect (no client component, no list of credentials left behind)', () => {
    const src = readFileSync(page('/connections/page.tsx'), 'utf8');
    expect(src).toContain('redirect(connectionsRedirectTarget(');
    expect(src).not.toContain("'use client'");
    expect(src).not.toMatch(/api\.(GET|POST|DELETE)/);
  });
});

describe('every settings URL that existed before still resolves', () => {
  it('each old URL has a page file: its own screen, a provider page, the generic provider route, or a redirect', () => {
    const unresolved = SETTINGS_PATHS_BEFORE_1185.filter((p) => {
      if (existsSync(page(`${p}/page.tsx`))) return false;
      // `/integrations/<id>` with no folder of its own is served by the generic [provider] route, for a registered id.
      const id = /^\/integrations\/([a-z-]+)$/.exec(p)?.[1];
      return !(id && PROVIDER_PAGES.some((pp) => pp.id === id) && existsSync(page('/integrations/[provider]/page.tsx')));
    });
    expect(unresolved).toEqual([]);
  });

  it('the old provider URLs are still provider pages: the preset URLs (/meta, /x, /linkedin) and Delegate to agent included', () => {
    for (const id of ['github', 'linear', 'slack', 'youtube', 'google-calendar', 'shopify', 'meta', 'x', 'linkedin', 'delegate-agent']) {
      expect(SETTINGS_PATHS_BEFORE_1185, id).toContain(`/integrations/${id}`);
      expect(PROVIDER_PAGES.some((p) => p.id === id), id).toBe(true);
    }
  });
});
