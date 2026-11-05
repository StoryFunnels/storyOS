import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { canOpenSettingsPage, settingsFlags, settingsNavGroups, SETTINGS_PAGES } from './settings-nav';
import { githubFacts, linearFacts, slackFacts } from './integration-facts';

/** Ticket #1188 AC3 — Webhooks and API tokens are in the nav for the right roles, member and guest included. */
const WS = 'ws';
const links = (role: string) =>
  settingsNavGroups(WS, role, settingsFlags(role, false, false)).flatMap((g) => g.links.map((l) => ({ group: g.id, id: l.id, href: l.href })));
const ids = (role: string) => links(role).map((l) => l.id);

describe('the Connections group, per role', () => {
  it('an admin sees Integrations, API tokens and Webhooks, under Connections, in that order', () => {
    expect(links('admin').filter((l) => l.group === 'connections').map((l) => l.id)).toEqual(['integrations', 'api-tokens', 'webhooks']);
  });

  it('a MEMBER sees API tokens (tokens are per person) and does not see Webhooks or Integrations', () => {
    expect(ids('member')).toContain('api-tokens');
    expect(ids('member')).not.toContain('webhooks');
    expect(ids('member')).not.toContain('integrations');
    expect(links('member').filter((l) => l.group === 'connections').map((l) => l.id)).toEqual(['api-tokens']);
  });

  it('a GUEST sees neither: API tokens is refused to guests (ticket #1091), Webhooks to everyone but admins', () => {
    expect(ids('guest')).not.toContain('api-tokens');
    expect(ids('guest')).not.toContain('webhooks');
    expect(ids('guest')).not.toContain('integrations');
    expect(links('guest').some((l) => l.group === 'connections')).toBe(false);
  });

  it('before the role has loaded, neither is offered (a guest never sees a link flash up and vanish)', () => {
    expect(canOpenSettingsPage(SETTINGS_PAGES.find((p) => p.id === 'webhooks')!, undefined)).toBe(false);
    expect(canOpenSettingsPage(SETTINGS_PAGES.find((p) => p.id === 'api-tokens')!, undefined)).toBe(false);
  });

  it('API tokens lives at /settings/api and Webhooks at /settings/webhooks', () => {
    expect(links('admin').find((l) => l.id === 'api-tokens')!.href).toBe('/w/ws/settings/api');
    expect(links('admin').find((l) => l.id === 'webhooks')!.href).toBe('/w/ws/settings/webhooks');
  });

  it('the page itself refuses by URL: Webhooks is admins-only in-page, API tokens refuses a guest through the shared predicate', () => {
    const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
    expect(read('../app/w/[ws]/settings/webhooks/layout.tsx')).toContain('<AdminsOnly');
    expect(read('../app/w/[ws]/settings/integrations/layout.tsx')).toContain('<AdminsOnly');
    // API tokens: a member opens it, a guest is refused in-page through the same predicate the nav uses (not an inline role check).
    const api = read('../app/w/[ws]/settings/api/page.tsx');
    expect(api).toContain('canConnectAi(workspace.data.role)');
    expect(api.indexOf('canConnectAi(workspace.data.role)')).toBeLessThan(api.indexOf('<ApiTokensContent />'));
  });

  it('the old gear-menu-only reach is gone: no row exists for /connections, which redirects', () => {
    expect(SETTINGS_PAGES.some((p) => p.path === '/connections')).toBe(false);
  });
});

describe('the health the card reports comes from the server’s own verdicts', () => {
  const NOW = new Date('2026-11-05T12:00:00Z');
  const sync = (over: Record<string, unknown>) => ({
    last_success_at: '2026-11-05T11:00:00Z', last_attempt_at: null, last_error: null, last_error_at: null, consecutive_failures: 0, stale: false,
    next_due_at: null, last_run: null, running: false, ...over,
  });

  it('GitHub: repositories that are not tracked but still send events are the problem, counted from the API’s own list', () => {
    const f = githubFacts({ connected: true, has_token: false, repos: ['a/b'], ignored_deliveries: { repos: [{ repo: 'x/y', count: 3 }, { repo: 'x/z', count: 1 }], other_count: 9 } });
    expect(f.connected).toBe(true);
    expect(f.problem).toBe('11 repositories you don’t track are still sending events.');
    expect(f.detail).toBe('1 repository tracked');
    expect(githubFacts({ connected: true, has_token: false, repos: ['a/b'], ignored_deliveries: { repos: [{ repo: 'x/y', count: 1 }], other_count: 0 } }).problem).toBe('1 repository you don’t track is still sending events.');
  });

  it('GitHub: nothing ignored is no problem; a token alone counts as connected; nothing at all is not connected', () => {
    expect(githubFacts({ connected: false, has_token: true, repos: [] }).connected).toBe(true);
    expect(githubFacts({ connected: true, has_token: false, repos: [], ignored_deliveries: { repos: [], other_count: 0 } }).problem).toBeNull();
    expect(githubFacts({ connected: false, has_token: false, repos: [], ignored_deliveries: { repos: [{ repo: 'a/b', count: 1 }], other_count: 0 } })).toMatchObject({ connected: false, problem: null });
  });

  it('Linear: stale and failing are the server’s verdict, reported with when it last synced; a healthy mirror just says so', () => {
    expect(linearFacts({ has_key: false, auto_sync: { enabled: true }, sync: sync({}) as never }, NOW)).toEqual({ connected: false });
    const ok = linearFacts({ has_key: true, auto_sync: { enabled: true }, sync: sync({}) as never }, NOW);
    expect(ok).toEqual({ connected: true, problem: null, detail: 'Last synced 1 h ago' });
    const stale = linearFacts({ has_key: true, auto_sync: { enabled: true }, sync: sync({ stale: true }) as never }, NOW);
    expect(stale.problem).toBe('The mirror is not updating. Last synced 1 h ago.');
    const failing = linearFacts({ has_key: true, auto_sync: { enabled: true }, sync: sync({ consecutive_failures: 2 }) as never }, NOW);
    expect(failing.problem).toBe('The last sync failed. Last synced 1 h ago.');
  });

  it('Linear: with the schedule off nothing is expected to refresh, so an old sync is not a problem', () => {
    expect(linearFacts({ has_key: true, auto_sync: { enabled: false }, sync: sync({ stale: true }) as never }, NOW).problem).toBeNull();
  });

  it('Slack: connected by a bot token or a webhook, and where it posts', () => {
    expect(slackFacts({ has_token: false, has_webhook: false })).toEqual({ connected: false, detail: null });
    expect(slackFacts({ has_token: true, has_webhook: false, default_channel: '#general' }).detail).toBe('Posts to #general');
    expect(slackFacts({ has_token: false, has_webhook: true }).detail).toBe('Webhook saved');
  });
});
