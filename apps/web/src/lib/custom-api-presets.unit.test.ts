import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CUSTOM_API_PRESETS, customApiPreset, presetForConnection } from './custom-api-presets';
import { httpBaseUrlProblem } from './http-base-url';
import { SOCIAL_INGEST } from './social-ingest';
import { PROVIDER_PAGES, providerPageSnapshot, type ConnectionRow } from './provider-pages';

/** Ticket #1188 AC4 — Meta, X and LinkedIn are presets of Custom API, and what was already saved keeps working. */
const API_SRC = (rel: string) => readFileSync(fileURLToPath(new URL(`../../../api/src/${rel}`, import.meta.url)), 'utf8');

describe('the preset list', () => {
  it('is exactly Meta, X and LinkedIn, in that order', () => {
    expect(CUSTOM_API_PRESETS.map((p) => p.id)).toEqual(['meta', 'x', 'linkedin']);
  });

  it('each preset pre-fills a base URL the API accepts (the same rule the server applies), over bearer auth, with a docs link', () => {
    for (const p of CUSTOM_API_PRESETS) {
      expect(httpBaseUrlProblem(p.baseUrl), p.id).toBeNull();
      expect(p.baseUrl.startsWith('https://'), p.id).toBe(true);
      expect(p.authStyle).toBe('bearer');
      expect(new URL(p.docsUrl).protocol, p.id).toBe('https:');
      expect(p.tokenHint.length).toBeGreaterThan(10);
    }
  });

  it('each base URL is the root the platform’s own source adapter calls, so the credential may go exactly where the sync sends it', () => {
    const roots: Record<string, string> = {
      meta: /API_BASE = '([^']+)'/.exec(API_SRC('sources/providers/meta_engagement.ts'))![1]!,
      x: /API_BASE = '([^']+)'/.exec(API_SRC('sources/providers/x_engagement.ts'))![1]!,
      linkedin: /API_BASE = '([^']+)'/.exec(API_SRC('sources/providers/linkedin_engagement.ts'))![1]!,
    };
    for (const p of CUSTOM_API_PRESETS) expect(p.baseUrl, p.id).toBe(roots[p.id]);
  });

  it('each preset’s name is the one the server recognises: the seeded name matches its own connectionMatch, and the server’s mirror agrees', () => {
    const server = API_SRC('integrations/integration-registry.ts');
    for (const p of CUSTOM_API_PRESETS) {
      expect(SOCIAL_INGEST[p.id].connectionMatch.test(p.defaultName), p.id).toBe(true);
      expect(p.defaultName).toBe(SOCIAL_INGEST[p.id].defaultConnectionName);
      expect(server, p.id).toContain(`defaultConnectionName: '${p.defaultName}'`);
      expect(server, p.id).toContain(`sourceProvider: '${p.sourceProvider}'`);
    }
  });

  it('customApiPreset finds one by id and says null for anything else', () => {
    expect(customApiPreset('x')?.label).toBe('X (Twitter)');
    expect(customApiPreset('blank')).toBeNull();
    expect(customApiPreset(undefined)).toBeNull();
  });
});

describe('existing stored connections map onto presets without changing what is stored', () => {
  it('a generic HTTP connection named for a platform IS that preset, by the rule that has always identified it', () => {
    expect(presetForConnection({ provider: 'http', name: 'Meta comments' })?.id).toBe('meta');
    expect(presetForConnection({ provider: 'http', name: 'meta' })?.id).toBe('meta');
    expect(presetForConnection({ provider: 'http', name: 'X mentions' })?.id).toBe('x');
    expect(presetForConnection({ provider: 'http', name: 'LinkedIn comments' })?.id).toBe('linkedin');
  });

  it('anything else is plain Custom API: other names, a name that merely contains the platform, and every other provider', () => {
    expect(presetForConnection({ provider: 'http', name: 'My API' })).toBeNull();
    expect(presetForConnection({ provider: 'http', name: 'Xylophone shop' })).toBeNull();
    expect(presetForConnection({ provider: 'http', name: 'Our Meta thing' })).toBeNull();
    expect(presetForConnection({ provider: 'resend', name: 'Meta' })).toBeNull();
    expect(presetForConnection({ provider: 'x', name: 'X mentions' })).toBeNull();
  });

  const row = (over: Partial<ConnectionRow>): ConnectionRow => ({ id: 'i', provider: 'http', name: 'n', status: 'active', scopes: [], last_ok_at: null, created_at: '', error_count_24h: 0, breaker_open_until: null, ...over });
  const input = (connections: ConnectionRow[]) => ({ connections, providers: [], integrations: {}, formatDateTime: (s: string) => s });
  const page = (id: string) => PROVIDER_PAGES.find((p) => p.id === id)!;

  it('a connection saved before this ticket still shows, once, on the page of its preset, with its row untouched', () => {
    const saved = row({ id: 'old', name: 'Meta comments' });
    expect(providerPageSnapshot(page('meta'), input([saved])).rows.map((r) => r.connectionId)).toEqual(['old']);
    expect(providerPageSnapshot(page('x'), input([saved])).rows).toEqual([]);
    expect(providerPageSnapshot(page('custom-api'), input([saved])).rows).toEqual([]);
    expect(providerPageSnapshot(page('meta'), input([saved])).rows[0]!.preset?.id).toBe('meta');
  });

  it('plain Custom API shows the connections that are not presets, so no connection appears on two pages', () => {
    const rows = [row({ id: 'a', name: 'My API' }), row({ id: 'b', name: 'X mentions' }), row({ id: 'c', name: 'LinkedIn comments' })];
    const seen = ['custom-api', 'meta', 'x', 'linkedin'].flatMap((id) => providerPageSnapshot(page(id), input(rows)).rows.map((r) => r.connectionId));
    expect(seen.sort()).toEqual(['a', 'b', 'c']);
  });

  it('the dedicated X and LinkedIn providers (made through the API) keep a home: their rows show on those pages, and Disconnect works', () => {
    const rows = [row({ id: 'dx', provider: 'x', name: 'Company X' }), row({ id: 'dl', provider: 'linkedin', name: 'Company LinkedIn' })];
    expect(providerPageSnapshot(page('x'), input(rows)).rows.map((r) => r.connectionId)).toEqual(['dx']);
    expect(providerPageSnapshot(page('linkedin'), input(rows)).rows.map((r) => r.connectionId)).toEqual(['dl']);
    expect(providerPageSnapshot(page('x'), input(rows)).rows[0]!.model.actions).toContain('disconnect');
  });

  it('no stored provider value changed: presets only pre-fill the HTTP connect form, so there is nothing to migrate', () => {
    const dialogs = readFileSync(fileURLToPath(new URL('../components/connections/connect-dialogs.tsx', import.meta.url)), 'utf8');
    // Every preset connection is created as provider 'http'.
    expect(dialogs).toContain("body: { provider: 'http', name, auth }");
    for (const preset of CUSTOM_API_PRESETS) expect(dialogs).not.toContain(`provider: '${preset.id}'`);
  });
});
