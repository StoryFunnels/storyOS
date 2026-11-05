import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { settingsCountClass, settingsMenu, sidebarBody } from './settings-menu';
import { settingsNavCounts } from './settings-home';
import { SETTINGS_PAGES, settingsFlags, settingsNavGroups, type SettingsPageId } from './settings-nav';

const WS = 'ws';
const menuFor = (role: string | undefined, pathname: string, cloud = true, signals = {}) => {
  const groups = settingsNavGroups(WS, role, settingsFlags(role, cloud, cloud));
  return settingsMenu(WS, pathname, groups, settingsNavCounts(role, signals as never));
};
const titles = (role: string | undefined, cloud = true) => menuFor(role, '/w/ws/settings', cloud).tiers.map((t) => [t.title, t.rows.map((r) => r.label)]);

describe('which body the app sidebar shows (ticket #1216)', () => {
  it('is the settings menu on the Settings home and every page beneath it', () => {
    for (const p of ['/w/ws/settings', '/w/ws/settings/members', '/w/ws/settings/integrations/github', '/w/ws/settings/connections']) {
      expect(sidebarBody(p), p).toBe('settings');
    }
  });

  it('is the space tree everywhere else, including paths that merely look like settings', () => {
    for (const p of ['/w/ws', '/w/ws/d/db1', '/w/ws/d/db1/r/rec', '/w/ws/packs', '/w/ws/me', '/w/ws/settingsfoo', '/w/ws/d/settings', '/settings', '/login', '', null, undefined]) {
      expect(sidebarBody(p), String(p)).toBe('tree');
    }
  });
});

describe('the menu per role, cloud and self-managed (reads the same declaration as the nav it replaces)', () => {
  it('an admin on cloud sees all five tiers in the design order', () => {
    expect(titles('admin')).toEqual([
      ['You', ['Profile', 'Preferences', 'Notifications', 'Referrals']],
      ['Workspace', ['General', 'Members', 'Plan & billing', 'Packs']],
      ['AI', ['Connect your AI', 'Runners', 'Agent rules']],
      ['Connections', ['Integrations', 'API tokens', 'Webhooks']],
      ['Data & security', ['Export', 'Trash', 'Audit log']],
    ]);
  });

  it('an admin on a self-managed deployment has no Plan & billing and no Referrals', () => {
    const flat = titles('admin', false).flatMap(([, rows]) => rows as string[]);
    expect(flat).not.toContain('Plan & billing');
    expect(flat).not.toContain('Referrals');
    expect(flat).toContain('Members');
  });

  it('a member sees only the tiers they can open', () => {
    expect(titles('member')).toEqual([
      ['You', ['Profile', 'Preferences', 'Notifications', 'Referrals']],
      ['AI', ['Connect your AI', 'Runners']],
      ['Connections', ['API tokens']],
    ]);
  });

  it('a guest sees only You', () => {
    expect(titles('guest')).toEqual([['You', ['Profile', 'Preferences', 'Notifications', 'Referrals']]]);
  });

  it('before the role has loaded, only what everyone has (no AI tier flashing up and vanishing)', () => {
    expect(menuFor(undefined, '/w/ws/settings').tiers.map((t) => t.title)).toEqual(['You']);
  });
});

describe('the current row', () => {
  const current = (pathname: string, role = 'admin') =>
    menuFor(role, pathname).tiers.flatMap((t) => t.rows.filter((r) => r.active).map((r) => r.label));

  it('is exactly one row for each page URL of the nav', () => {
    for (const p of SETTINGS_PAGES.filter((p) => p.path)) {
      expect(current(`/w/ws/settings${p.path}`), p.id).toEqual([p.label]);
    }
  });

  it('is Settings itself (and no page row) on the home', () => {
    expect(menuFor('admin', '/w/ws/settings').home.active).toBe(true);
    expect(current('/w/ws/settings')).toEqual([]);
  });

  it('is the page, not the home, once on a page', () => {
    expect(menuFor('admin', '/w/ws/settings/members').home.active).toBe(false);
  });

  it('keeps Integrations current on a provider page; /connections is a redirect now (ticket #1188), so no row claims it', () => {
    expect(current('/w/ws/settings/integrations/github')).toEqual(['Integrations']);
    expect(current('/w/ws/settings/integrations/custom-api')).toEqual(['Integrations']);
    expect(current('/w/ws/settings/connections')).toEqual([]);
  });
});

describe('counts', () => {
  const signals = { invitesExpired: 4, connections: 4, connectionsNeedFix: 0, packs: 1, packUpdates: 0, aiNeedReconnect: 3, tokens: 12 };
  const countOf = (id: SettingsPageId, role = 'admin') =>
    menuFor(role, '/w/ws/settings', true, signals).tiers.flatMap((t) => t.rows).find((r) => r.id === id)?.count;

  it('an attention count is warning text; a plain count is muted', () => {
    expect(countOf('members')).toEqual({ text: '4 expired', warn: true });
    expect(countOf('connect-ai')).toEqual({ text: '3 to fix', warn: true });
    expect(countOf('api-tokens')).toEqual({ text: '12' });
    expect(settingsCountClass(countOf('members')!)).toBe('text-warning-text');
    expect(settingsCountClass(countOf('api-tokens')!)).toBe('text-muted');
    expect(settingsCountClass(countOf('integrations')!)).toBe('text-muted');
  });

  it('a page with no real figure has no count (nothing guessed)', () => {
    expect(countOf('webhooks')).toBeUndefined();
    expect(menuFor('admin', '/w/ws/settings').tiers.flatMap((t) => t.rows).every((r) => r.count === undefined)).toBe(true);
  });

  it('a member is never shown an admin count', () => {
    expect(countOf('members', 'member')).toBeUndefined();
    expect(countOf('connect-ai', 'member')?.warn).toBe(true);
  });
});

describe('the wiring (ticket #1216)', () => {
  const SRC = fileURLToPath(new URL('..', import.meta.url));
  const read = (p: string) => readFileSync(`${SRC}${p}`, 'utf8');

  it('the app sidebar picks its body with sidebarBody and the rail gear with isSettingsPath, never an inline startsWith', () => {
    const sidebar = read('components/sidebar.tsx');
    expect(sidebar).toContain("sidebarBody(usePathname()) === 'settings'");
    expect(sidebar).toContain('<SettingsSidebarMenu');
    expect(sidebar).toContain('isSettingsPath(pathname)');
    expect(sidebar).not.toMatch(/\/settings\/`\)/);
  });

  it('the shell offers the floating "+" through showQuickAddFab, and remembers pages for Back', () => {
    const layout = read('app/w/[ws]/layout.tsx');
    expect(layout).toContain('showQuickAddFab(pathname) && <QuickAddFab />');
    expect(layout).toContain('useRememberOutsideSettings(ws, pathname)');
  });

  it('the middle column and its layout are gone: nothing draws a settings nav inside the page area', () => {
    expect(existsSync(`${SRC}components/settings/settings-nav.tsx`)).toBe(false);
    // Ticket #1186 re-adds a settings/layout.tsx, but only as the page COLUMN (left-aligned, 720px, 28px gutter). The point of this
    // test is that the layout draws no menu, so the assertion is on that and not on the file's absence.
    const layoutFile = `${SRC}app/w/[ws]/settings/layout.tsx`;
    if (existsSync(layoutFile)) {
      const layout = readFileSync(layoutFile, 'utf8');
      expect(layout).not.toMatch(/SettingsNav|settingsNavGroups|<nav\b|SettingsSidebarMenu/);
    }
  });
});

describe('the sidebar menu component', () => {
  const src = readFileSync(fileURLToPath(new URL('../components/settings/settings-sidebar-menu.tsx', import.meta.url)), 'utf8');

  it('carries an icon for every settings page, and draws rows and labels through the sidebar components', async () => {
    const { SETTINGS_PAGE_ICONS } = await import('../components/settings/settings-page-icons');
    for (const p of SETTINGS_PAGES) expect(SETTINGS_PAGE_ICONS[p.id], p.id).toBeTruthy();
    expect(src).toContain('<SidebarRow');
    expect(src).toContain('<SidebarTierLabel');
    expect(src).toContain("aria-current={active ? 'page' : undefined}");
  });

  it('puts Back before every other row', () => {
    expect(src.indexOf('Back to')).toBeGreaterThan(-1);
    expect(src.indexOf('Back to')).toBeLessThan(src.indexOf('<MenuRow href={menu.home.href}'));
  });
});
