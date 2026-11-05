import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SETTINGS_PAGES } from './settings-nav';
import { PROVIDER_PAGES } from './provider-pages';

/**
 * Reachability guard (ticket #1185, after review): every settings route must be one a person can GET TO from Settings itself.
 *
 * Why it exists: the old gear menu held a one-click "Connections" entry. The new nav has no row for it, and for a while nothing in
 * Settings linked to it either; it was reachable only from inside two provider pages and a few dialogs, i.e. effectively lost. No
 * compile error, no failing test: the same shape as the other "a list drifted from reality" defects in CLAUDE.md.
 *
 * "Reachable" here is deliberately strict: a row in the nav table (`SETTINGS_PAGES`), or a link from a HUB, a screen every viewer
 * of that area lands on. A link from a dialog or from another leaf page does NOT count: that is how Connections got lost.
 */
const SRC = fileURLToPath(new URL('..', import.meta.url));
const SETTINGS_DIR = join(SRC, 'app/w/[ws]/settings');
const read = (p: string) => readFileSync(p, 'utf8');

/** The hubs: the Settings home and the Integrations index. (The nav table is checked separately.) */
const HOME_HUB = join(SETTINGS_DIR, 'page.tsx');
const INTEGRATIONS_HUB = join(SETTINGS_DIR, 'integrations/page.tsx');
const HUBS = [HOME_HUB, INTEGRATIONS_HUB];

/** Routes that are deliberately linked from nowhere, each with its reason. */
const EXEMPT: Record<string, string> = {
  '/integrations/mcp': 'a redirect kept so an old link still resolves (to /connect-ai); it must not be linked',
  '/connections': 'a redirect since ticket #1188 (every credential is on its provider page); kept for the OAuth callback, the editors and old links, and it must not be linked from a hub',
};

function settingsRoutes(dir = SETTINGS_DIR, prefix = ''): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (!statSync(full).isDirectory()) continue;
    const route = `${prefix}/${name}`;
    if (readdirSync(full).includes('page.tsx')) out.push(route);
    out.push(...settingsRoutes(full, route));
  }
  return out.sort();
}

/** Whether `source` contains a link whose path is exactly `/settings{route}` (not a longer path that merely starts with it). */
export function linksTo(source: string, route: string): boolean {
  const escaped = route.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  return new RegExp(`/settings${escaped}(?![A-Za-z0-9_/-])`).test(source);
}

const navRoutes = new Set(SETTINGS_PAGES.filter((p) => p.path).map((p) => p.path!));
const hubSource = HUBS.map(read).join('\n');

function reachable(route: string): { ok: boolean; how: string } {
  if (navRoutes.has(route)) return { ok: true, how: 'nav row' };
  if (linksTo(hubSource, route)) return { ok: true, how: 'hub link' };
  // Provider pages are reached from the Integrations hub, which lists EVERY entry of the provider registry (`PROVIDER_PAGES`) and links
  // each through `providerPageHref`. So a provider page is reachable when the registry names it, and the hub is drawn from the registry.
  const hub = read(INTEGRATIONS_HUB);
  const drawnFromRegistry = hub.includes('PROVIDER_PAGES.map') && hub.includes('providerPageHref(ws, s.def.id)');
  const provider = /^\/integrations\/([a-z-]+)$/.exec(route)?.[1];
  if (provider && drawnFromRegistry && PROVIDER_PAGES.some((p) => p.id === provider)) {
    return { ok: true, how: 'integrations hub, via the provider registry' };
  }
  // The generic route serves every registered provider that has no folder of its own, so it is reachable when any of them is.
  if (route === '/integrations/[provider]' && drawnFromRegistry) {
    const own = new Set(routes0().filter((r) => /^\/integrations\/[a-z-]+$/.test(r)).map((r) => r.slice('/integrations/'.length)));
    if (PROVIDER_PAGES.some((p) => !own.has(p.id))) return { ok: true, how: 'integrations hub, via the provider registry (generic route)' };
  }
  return { ok: false, how: 'nothing in Settings links to it' };
}

/** The route list, computed lazily so `reachable` can use it. */
function routes0(): string[] {
  return settingsRoutes();
}

describe('every settings route is reachable from Settings (ticket #1185)', () => {
  const routes = settingsRoutes();

  it('finds the routes it is meant to guard', () => {
    expect(routes).toContain('/connections');
    expect(routes).toContain('/integrations/github');
    expect(routes.length).toBeGreaterThanOrEqual(25);
  });

  it('each route has a nav row or a link from a hub, unless it is exempt for a stated reason', () => {
    const lost = routes.filter((r) => !EXEMPT[r] && !reachable(r).ok);
    expect(lost, `unreachable settings routes: ${lost.join(', ')}`).toEqual([]);
  });

  it('Connections specifically: merged into the provider pages (ticket #1188), so it is no nav row and no hub link, only a redirect', () => {
    expect(navRoutes.has('/connections')).toBe(false);
    expect(linksTo(read(INTEGRATIONS_HUB), '/connections')).toBe(false);
    expect(read(join(SETTINGS_DIR, 'connections/page.tsx'))).toContain('redirect(');
  });

  it('every provider in the registry is drawn by the hub (its own list or the other), so none can have a page nobody can reach', () => {
    const hub = read(INTEGRATIONS_HUB);
    expect(hub).toContain('PROVIDER_PAGES.map');
    expect(hub).toContain('const connected = snapshots.filter');
    expect(hub).toContain('const available = snapshots.filter');
  });

  it('an exemption is not a way to hide a gap: an exempt route really is linked from nowhere in the hubs', () => {
    for (const r of Object.keys(EXEMPT)) expect(reachable(r).how, r).not.toBe('hub link');
  });

  it('linksTo matches a path, not a prefix of a longer one', () => {
    expect(linksTo('`/w/${ws}/settings/connections`', '/connections')).toBe(true);
    expect(linksTo('`/w/${ws}/settings/connections?add=http`', '/connections')).toBe(true);
    expect(linksTo('`/w/${ws}/settings/connections-old`', '/connections')).toBe(false);
    expect(linksTo('`/w/${ws}/settings/integrations/github`', '/integrations')).toBe(false);
  });
});
