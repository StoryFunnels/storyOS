import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  PROVIDER_PAGES,
  coveredConnectionProviders,
  providerPageSnapshot,
  type ConnectionRow,
  type ProviderInfo,
  type ProviderPageDef,
  type SnapshotInput,
} from './provider-pages';
import { confirmDisconnectProvider } from './settings-confirmations';
import { connectionCardModel } from './connection-card';

/**
 * Ticket #1188 — the provider registry the Integrations hub, every provider page and the connection card all read.
 *
 * "Disconnect on EVERY provider" is asserted by iterating the registry (and, for the providers the API really has, the API's own
 * registry files), not a hand-written list: a provider added tomorrow without a disconnect, a confirm or a card fails here.
 */
const SRC = fileURLToPath(new URL('..', import.meta.url));
const SETTINGS = join(SRC, 'app/w/[ws]/settings');
const API = join(SRC, '../../api/src');
const read = (p: string) => readFileSync(p, 'utf8');

const fmt = (iso: string) => iso;
const NONE: SnapshotInput = { connections: [], providers: [], integrations: {}, formatDateTime: fmt };

function row(over: Partial<ConnectionRow>): ConnectionRow {
  return { id: 'c1', provider: 'http', name: 'Thing', status: 'active', scopes: [], last_ok_at: null, created_at: '2026-11-01T00:00:00Z', error_count_24h: 0, breaker_open_until: null, ...over };
}

/** A catalog entry as `GET /connections/providers` returns it. */
function info(over: Partial<ProviderInfo> & { id: string }): ProviderInfo {
  return { label: over.id, auth_kind: 'api_key', tier: 'api_key', availability: 'connectable', ...over };
}

const credentialPages = PROVIDER_PAGES.filter((p) => p.backing.kind !== 'builtin');

describe('the registry is a complete, honest description of the provider pages', () => {
  it('every id is unique, and the registry is not empty', () => {
    expect(PROVIDER_PAGES.length).toBeGreaterThanOrEqual(10);
    expect(new Set(PROVIDER_PAGES.map((p) => p.id)).size).toBe(PROVIDER_PAGES.length);
  });

  it('the only provider with nothing to disconnect is Delegate to agent, which holds no credential', () => {
    expect(PROVIDER_PAGES.filter((p) => p.disconnectEffect === null).map((p) => p.id)).toEqual(['delegate-agent']);
    expect(PROVIDER_PAGES.filter((p) => p.backing.kind === 'builtin').map((p) => p.id)).toEqual(['delegate-agent']);
  });

  it('covers every provider in the API credential registry (found by reading the descriptor files, not a hand list)', () => {
    const dir = join(API, 'connections/providers');
    const ids = new Set<string>();
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.ts') || f.includes('.test.') || ['index.ts', 'types.ts', 'availability.ts'].includes(f)) continue;
      const src = read(join(dir, f));
      if (!/export const \w+Provider: ProviderDescriptor/.test(src)) continue;
      const id = /export const \w+Provider: ProviderDescriptor[^=]*= \{\s*id: '([a-z-]+)'/.exec(src)?.[1];
      expect(id, `${f} declares a ProviderDescriptor with an id`).toBeTruthy();
      ids.add(id!);
    }
    expect([...ids].sort()).toEqual(['apify', 'google', 'google-calendar', 'http', 'linkedin', 'openai', 'resend', 'shopify', 'smtp', 'x']);
    const covered = coveredConnectionProviders();
    const lost = [...ids].filter((id) => !covered.has(id));
    expect(lost, `API providers with no provider page: ${lost.join(', ')}`).toEqual([]);
  });

  it('covers every available integration in the API directory, each exempt id with its reason', () => {
    const src = read(join(API, 'integrations/integration-registry.ts'));
    const block = src.slice(src.indexOf('INTEGRATION_REGISTRY'));
    const entries = [...block.matchAll(/id: '([a-z-]+)',[\s\S]*?status: '(available|soon)'/g)].map((m) => ({ id: m[1]!, status: m[2]! }));
    expect(entries.length).toBeGreaterThanOrEqual(10);
    const EXEMPT: Record<string, string> = {
      mcp: 'Connect your AI is its own settings page; /integrations/mcp redirects there',
      storyfunnels: 'status: soon, a roadmap placeholder with no service behind it',
      storypages: 'status: soon, a roadmap placeholder with no service behind it',
    };
    const ids = new Set(PROVIDER_PAGES.map((p) => p.id as string));
    const missing = entries.filter((e) => !ids.has(e.id) && !EXEMPT[e.id]).map((e) => e.id);
    expect(missing, `integrations with no provider page: ${missing.join(', ')}`).toEqual([]);
    for (const id of Object.keys(EXEMPT)) expect(ids.has(id), `${id} is exempt, so it must not also have a page`).toBe(false);
  });
});

describe('Disconnect is on every provider, and it confirms', () => {
  const connectedFixture = (def: ProviderPageDef) => {
    const b = def.backing;
    if (b.kind === 'integration') return providerPageSnapshot(def, { ...NONE, integrations: { [b.endpoint]: { connected: true } } });
    if (b.kind !== 'connections') throw new Error('not a credential page');
    const provider = b.providers[0]!;
    // A row this page claims: for a preset page the name must be the platform's, as it has always been.
    const name = def.id === 'meta' ? 'Meta comments' : def.id === 'x' ? 'X mentions' : def.id === 'linkedin' ? 'LinkedIn comments' : 'Mine';
    return providerPageSnapshot(def, { ...NONE, connections: [row({ provider, name })], providers: b.providers.map((id) => info({ id })) });
  };

  for (const def of credentialPages) {
    it(`${def.id}: a connected card offers Disconnect and Test, and Disconnect has a named blast radius`, () => {
      const snap = connectedFixture(def);
      expect(snap.rows, `${def.id} fixture produced a row`).toHaveLength(1);
      expect(snap.rows[0]!.model.actions).toContain('disconnect');
      expect(snap.rows[0]!.model.actions).toContain('test');
      expect(def.disconnectEffect, def.id).toBeTruthy();
      const c = confirmDisconnectProvider(snap.rows[0]!.name, def.disconnectEffect!);
      expect(c.danger).toBe(true);
      expect(c.title).toBe(`Disconnect ${snap.rows[0]!.name}?`);
      expect(c.message).toContain(def.disconnectEffect!);
      expect(c.confirmLabel).toBe('Disconnect');
    });
  }

  it('every effect says what STOPS (a verb of stopping or failing), never a bare "cannot be undone"', () => {
    for (const def of credentialPages) expect(def.disconnectEffect, def.id).toMatch(/stop|fail|clear|fall back/i);
  });

  it('the card asks through the shared confirm BEFORE it calls the disconnect, and no page uses window.confirm', () => {
    const card = read(join(SRC, 'components/settings/provider-card.tsx'));
    const ask = card.slice(card.indexOf('async function askAndDisconnect'));
    expect(ask.indexOf('await confirm(confirmDisconnectProvider')).toBeGreaterThan(-1);
    expect(ask.indexOf('await confirm(confirmDisconnectProvider')).toBeLessThan(ask.indexOf('disconnect.mutate(row)'));
    expect(card).not.toMatch(/window\.confirm|[^.]\bconfirm\(\s*`/);
    for (const rel of ['integrations/page.tsx', 'integrations/[provider]/page.tsx']) expect(read(join(SETTINGS, rel))).not.toContain('window.confirm');
  });

  it('the disconnect calls exist: integrations post to their own /disconnect, connections DELETE the row', () => {
    const card = read(join(SRC, 'components/settings/provider-card.tsx'));
    for (const e of ['github', 'linear', 'slack']) expect(card).toContain(`/integrations/${e}/disconnect`);
    expect(card).toContain("api.DELETE('/api/v1/workspaces/{ws}/connections/{id}'");
  });
});

describe('every provider page draws the one shared card', () => {
  /** The files that can draw a provider's page: its own folder, a component it renders, or the generic [provider] route. */
  function sourcesFor(id: string): string {
    const own = join(SETTINGS, 'integrations', id, 'page.tsx');
    const generic = join(SETTINGS, 'integrations/[provider]/page.tsx');
    let src = existsSync(own) ? read(own) : read(generic);
    if (src.includes('<SocialIngestSetup')) src += read(join(SRC, 'components/social-ingest-setup.tsx'));
    return src;
  }
  for (const def of credentialPages) {
    it(`${def.id} renders <ProviderConnectionCard id="${def.id}"> (or a component that does, with its own id)`, () => {
      const src = sourcesFor(def.id);
      expect(src).toContain('<ProviderConnectionCard');
      if (!src.includes('SocialIngestSetup')) expect(src).toMatch(new RegExp(`<ProviderConnectionCard ws=\\{ws\\} id=("${def.id}"|\\{def\\.id\\})`));
      else expect(src).toContain('id={platform}');
    });
  }

  it('the generic route serves exactly the providers that have no folder of their own, and only those need it', () => {
    const own = new Set(readdirSync(join(SETTINGS, 'integrations')).filter((n) => existsSync(join(SETTINGS, 'integrations', n, 'page.tsx'))));
    const generic = PROVIDER_PAGES.filter((p) => !own.has(p.id)).map((p) => p.id).sort();
    expect(generic).toEqual(['apify', 'custom-api', 'email', 'openai']);
  });
});

describe('self-managed: the availability states render, with no dead Connect button', () => {
  const youtube = PROVIDER_PAGES.find((p) => p.id === 'youtube')!;
  const shopify = PROVIDER_PAGES.find((p) => p.id === 'shopify')!;
  const linkedin = PROVIDER_PAGES.find((p) => p.id === 'linkedin')!;

  it('Tier B, env absent (operator_config): the page says it is set up by the admin, and offers no connect control', () => {
    const snap = providerPageSnapshot(youtube, {
      ...NONE,
      providers: [info({ id: 'google', auth_kind: 'oauth2', tier: 'oauth_managed', availability: 'operator_config', oauth: { scopes: [], configured: false } })],
    });
    expect(snap.overall.state).toBe('operator_config');
    expect(snap.overall.actions).toEqual([]);
    expect(snap.connect.every((c) => c.control === 'none')).toBe(true);
    expect(snap.connect[0]!.availability).toBe('operator_config');
  });

  it('Tier B with the env present (connectable): the OAuth Connect is offered', () => {
    const snap = providerPageSnapshot(youtube, {
      ...NONE,
      providers: [info({ id: 'google', auth_kind: 'oauth2', tier: 'oauth_managed', availability: 'connectable', oauth: { scopes: [], configured: true } })],
    });
    expect(snap.overall.state).toBe('not_connected');
    expect(snap.connect[0]!.control).toBe('oauth');
  });

  it('Tier C (cloud_only): an upsell state and no connect control, with the server note kept', () => {
    const snap = providerPageSnapshot(shopify, { ...NONE, providers: [info({ id: 'shopify', tier: 'hosted_only', availability: 'cloud_only', availability_note: 'Shopify is a Cloud feature.' })] });
    expect(snap.overall.state).toBe('cloud_only');
    expect(snap.overall.summary).toBe('Shopify is a Cloud feature.');
    expect(snap.connect[0]!.control).toBe('none');
    expect(snap.overall.actions).toEqual([]);
  });

  it('Tier A (api_key): connectable on a self-managed server with no env at all', () => {
    const snap = providerPageSnapshot(shopify, { ...NONE, providers: [info({ id: 'shopify', availability: 'connectable' })] });
    expect(snap.overall.state).toBe('not_connected');
    expect(snap.connect[0]!.control).toBe('api-key');
  });

  it('a credential that already exists still shows its card, Test and Disconnect, when the env has since gone', () => {
    const snap = providerPageSnapshot(youtube, {
      ...NONE,
      connections: [row({ provider: 'google', name: 'Google' })],
      providers: [info({ id: 'google', auth_kind: 'oauth2', tier: 'oauth_managed', availability: 'operator_config' })],
    });
    expect(snap.rows[0]!.name).toBe('YouTube');
    expect(snap.rows[0]!.model.actions).toEqual(['test', 'disconnect']);
  });

  it('LinkedIn has two doors: the token preset is connectable while the OAuth one says it is the admin’s to set up', () => {
    const snap = providerPageSnapshot(linkedin, {
      ...NONE,
      providers: [
        info({ id: 'http' }),
        info({ id: 'linkedin', auth_kind: 'oauth2', tier: 'oauth_managed', availability: 'operator_config', oauth: { scopes: [], configured: false } }),
      ],
    });
    expect(snap.connect.map((c) => [c.label, c.control, c.availability])).toEqual([
      ['Connect with a token', 'http', 'connectable'],
      ['Connect LinkedIn', 'none', 'operator_config'],
    ]);
    expect(snap.overall.state).toBe('not_connected');
  });

  it('the page is one verdict from the worst row: any row needing attention makes the page need attention', () => {
    const http = PROVIDER_PAGES.find((p) => p.id === 'custom-api')!;
    const snap = providerPageSnapshot(http, {
      ...NONE,
      providers: [info({ id: 'http' })],
      connections: [row({ id: 'a', name: 'Good' }), row({ id: 'b', name: 'Bad', status: 'error' })],
    });
    expect(snap.rows).toHaveLength(2);
    expect(snap.overall.state).toBe('needs_attention');
  });

  it('the page verdict equals connectionCardModel for a single row (the card and the hub cannot disagree)', () => {
    const snap = providerPageSnapshot(shopify, { ...NONE, providers: [info({ id: 'shopify' })], connections: [row({ provider: 'shopify', status: 'expired' })] });
    expect(snap.overall).toEqual(connectionCardModel({ availability: 'connectable', connection: { status: 'expired', errorCount24h: 0, breakerOpenUntil: null, needsBaseUrl: false } }));
  });
});

describe('integrations (GitHub, Linear, Slack): connected state comes from their own config', () => {
  const github = PROVIDER_PAGES.find((p) => p.id === 'github')!;
  const linear = PROVIDER_PAGES.find((p) => p.id === 'linear')!;

  it('not connected: no row, Connect', () => {
    const s = providerPageSnapshot(github, { ...NONE, integrations: { github: { connected: false } } });
    expect(s.rows).toEqual([]);
    expect(s.overall.actions).toEqual(['connect']);
  });

  it('GitHub with untracked repositories still sending events: needs a look, with the sentence, and Disconnect on this page', () => {
    const s = providerPageSnapshot(github, { ...NONE, integrations: { github: { connected: true, problem: '11 repositories you don’t track are still sending events.', detail: '10 repositories tracked' } } });
    expect(s.overall.state).toBe('needs_attention');
    expect(s.rows[0]!.model.actions).toContain('disconnect');
    expect(s.rows[0]!.model.summary).toContain('11 repositories');
  });

  it('Linear connected with a healthy mirror shows when it last synced', () => {
    const s = providerPageSnapshot(linear, { ...NONE, integrations: { linear: { connected: true, detail: 'Last synced 12 min ago' } } });
    expect(s.overall.state).toBe('connected');
    expect(s.rows[0]!.subtitle).toBe('Last synced 12 min ago');
  });

  it('Linear is the one integration whose Test is a status refresh, recorded as a gap (no read-only live check exists)', () => {
    const statusOnly = PROVIDER_PAGES.filter((p) => p.backing.kind === 'integration' && p.backing.test === 'status').map((p) => p.id);
    expect(statusOnly).toEqual(['linear']);
  });
});
