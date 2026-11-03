import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  SETTINGS_GROUPS,
  SETTINGS_PAGES,
  SETTINGS_PATHS_BEFORE_1185,
  canConnectAi,
  canOpenAdminSettings,
  canOpenSettingsPage,
  isSettingsLinkActive,
  settingsFlags,
  settingsHomeHref,
  settingsNavGroups,
  settingsPageHref,
} from './settings-nav';

const WS = 'ws';
const cloud = { billing: true, referrals: true };
const selfManaged = { billing: false, referrals: false };

const groups = (role: string | undefined, env = cloud) => settingsNavGroups(WS, role, settingsFlags(role, env.billing, env.referrals));
const shape = (role: string | undefined, env = cloud) => groups(role, env).map((g) => [g.title, g.links.map((l) => l.label)] as const);
const labels = (role: string | undefined, env = cloud) => groups(role, env).flatMap((g) => g.links.map((l) => l.label));

describe('the five groups, per role (ticket #1185)', () => {
  it('an ADMIN on cloud gets all five groups, in the order of the design', () => {
    expect(shape('admin')).toEqual([
      ['You', ['Profile', 'Preferences', 'Notifications', 'Referrals']],
      ['Workspace', ['General', 'Members', 'Plan & billing', 'Packs']],
      ['AI', ['Connect your AI', 'Runners', 'Agent rules']],
      ['Connections', ['Integrations', 'API tokens', 'Webhooks']],
      ['Data & security', ['Export', 'Trash', 'Audit log']],
    ]);
  });

  it('a MEMBER gets You, AI (no Agent rules) and Connections (API tokens only): no Workspace group and no Data & security group', () => {
    expect(shape('member')).toEqual([
      ['You', ['Profile', 'Preferences', 'Notifications', 'Referrals']],
      ['AI', ['Connect your AI', 'Runners']],
      ['Connections', ['API tokens']],
    ]);
  });

  it('a GUEST gets only You', () => {
    expect(shape('guest')).toEqual([['You', ['Profile', 'Preferences', 'Notifications', 'Referrals']]]);
  });

  it('General is hidden from members and guests (Ievgen, #974 AC5a), and shown to admins', () => {
    expect(labels('admin')).toContain('General');
    expect(labels('member')).not.toContain('General');
    expect(labels('guest')).not.toContain('General');
  });

  it('a role never sees an empty group heading', () => {
    for (const role of ['admin', 'member', 'guest', undefined]) {
      for (const g of groups(role)) expect(g.links.length, `${role}/${g.title}`).toBeGreaterThan(0);
    }
  });

  it('an unknown role (not loaded yet) is offered only the pages everyone has, so a guest never sees the AI group flash up', () => {
    expect(shape(undefined)).toEqual([['You', ['Profile', 'Preferences', 'Notifications', 'Referrals']]]);
  });

  it('every nav entry is in the group the design puts it in, and the groups are the five declared', () => {
    expect(SETTINGS_GROUPS.map((g) => g.title)).toEqual(['You', 'Workspace', 'AI', 'Connections', 'Data & security']);
    const declared = new Set(SETTINGS_GROUPS.map((g) => g.id));
    for (const p of SETTINGS_PAGES) expect(declared.has(p.group), p.id).toBe(true);
  });
});

describe('self-managed deployments: cloud-only entries are hidden, not dead (ticket #1185 AC6)', () => {
  it('an admin on a self-managed deployment has no Plan & billing and no Referrals, and every other entry', () => {
    const l = labels('admin', selfManaged);
    expect(l).not.toContain('Plan & billing');
    expect(l).not.toContain('Referrals');
    expect(l).toEqual(['Profile', 'Preferences', 'Notifications', 'General', 'Members', 'Packs', 'Connect your AI', 'Runners', 'Agent rules', 'Integrations', 'API tokens', 'Webhooks', 'Export', 'Trash', 'Audit log']);
  });
  it('Referrals follows its own cloud signal, billing follows its own: neither depends on the other', () => {
    expect(labels('admin', { billing: true, referrals: false })).toContain('Plan & billing');
    expect(labels('admin', { billing: true, referrals: false })).not.toContain('Referrals');
    expect(labels('admin', { billing: false, referrals: true })).toContain('Referrals');
    expect(labels('admin', { billing: false, referrals: true })).not.toContain('Plan & billing');
  });
  it('a member on cloud keeps Referrals (it belongs to a person) and never gets Plan & billing', () => {
    expect(labels('member')).toContain('Referrals');
    expect(labels('member')).not.toContain('Plan & billing');
  });
});

describe('role gates are unchanged, per group (ticket #1185 AC4; #939/#940 class)', () => {
  const adminPages = SETTINGS_PAGES.filter((p) => p.access === 'admins');

  it('WORKSPACE and DATA & SECURITY are admin-only: a member and a guest can open none of them', () => {
    for (const group of ['workspace', 'data'] as const) {
      for (const p of SETTINGS_PAGES.filter((x) => x.group === group)) {
        expect(canOpenSettingsPage(p, 'admin'), `admin ${p.id}`).toBe(true);
        expect(canOpenSettingsPage(p, 'member'), `member ${p.id}`).toBe(false);
        expect(canOpenSettingsPage(p, 'guest'), `guest ${p.id}`).toBe(false);
      }
    }
  });
  it('AI: a member opens Connect your AI and Runners but not Agent rules; a guest opens none', () => {
    const ai = SETTINGS_PAGES.filter((p) => p.group === 'ai');
    for (const p of ai) {
      expect(canOpenSettingsPage(p, 'guest'), `guest ${p.id}`).toBe(false);
      expect(canOpenSettingsPage(p, 'member'), `member ${p.id}`).toBe(p.id !== 'agent-rules');
      expect(canOpenSettingsPage(p, 'admin'), `admin ${p.id}`).toBe(true);
    }
  });
  it('CONNECTIONS: a member opens API tokens only, never Integrations or Webhooks; a guest opens none', () => {
    const byId = (id: string) => SETTINGS_PAGES.find((p) => p.id === id)!;
    expect(canOpenSettingsPage(byId('api-tokens'), 'member')).toBe(true);
    expect(canOpenSettingsPage(byId('api-tokens'), 'guest')).toBe(false);
    for (const id of ['integrations', 'webhooks']) {
      expect(canOpenSettingsPage(byId(id), 'member'), id).toBe(false);
      expect(canOpenSettingsPage(byId(id), 'guest'), id).toBe(false);
    }
  });
  it('YOU is open to every role, guest included', () => {
    for (const p of SETTINGS_PAGES.filter((x) => x.group === 'you')) {
      for (const role of ['admin', 'member', 'guest']) expect(canOpenSettingsPage(p, role), `${role} ${p.id}`).toBe(true);
    }
  });
  it('the nav and the page agree: a link is offered exactly when the role may open the page', () => {
    for (const role of ['admin', 'member', 'guest']) {
      const offered = new Set(groups(role).flatMap((g) => g.links.map((l) => l.id)));
      for (const p of SETTINGS_PAGES) {
        if (offered.has(p.id)) expect(canOpenSettingsPage(p, role), `${role} sees ${p.id} but cannot open it`).toBe(true);
      }
    }
  });
  it('the rules are the named predicates: admins-only is canOpenAdminSettings, editors is canConnectAi', () => {
    for (const role of ['admin', 'member', 'guest', 'editor', 'viewer']) {
      expect(canOpenSettingsPage({ access: 'admins' }, role), role).toBe(canOpenAdminSettings(role));
      expect(canOpenSettingsPage({ access: 'editors' }, role), role).toBe(canConnectAi(role));
    }
    expect(canOpenAdminSettings('member')).toBe(false);
    expect(canOpenAdminSettings('guest')).toBe(false);
    expect(canConnectAi('guest')).toBe(false);
  });

  // The nav hiding a link is not a gate (#875, #1092). Every admins-only page sits under a layout that renders AdminsOnly, so a
  // member or guest who types the URL gets the shared refusal and the page's own requests are never made.
  const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
  it('every admins-only page under settings has a layout that renders the shared AdminsOnly refusal', () => {
    for (const p of adminPages.filter((x) => x.path)) {
      const dir = `../app/w/[ws]/settings${p.path}`;
      const layout = `${dir}/layout.tsx`;
      expect(existsSync(fileURLToPath(new URL(layout, import.meta.url))), `${p.id} has no layout.tsx`).toBe(true);
      expect(read(layout), p.id).toContain('<AdminsOnly');
    }
  });
  it('the Connections page (reached from Integrations) and every Integrations subpage are covered the same way', () => {
    expect(read('../app/w/[ws]/settings/connections/layout.tsx')).toContain('<AdminsOnly');
    expect(read('../app/w/[ws]/settings/integrations/layout.tsx')).toContain('<AdminsOnly');
  });
  it('the AI pages a member may open refuse a guest through the shared rule, not an inline role check', () => {
    expect(read('../app/w/[ws]/settings/connect-ai/page.tsx')).toContain('canConnectAi(workspace.data.role)');
  });
});

describe('every settings URL that existed before ticket #1185 still resolves (AC3)', () => {
  const pageFile = (path: string) => fileURLToPath(new URL(`../app/w/[ws]/settings${path}/page.tsx`, import.meta.url));

  it('each one has a page file: its own screen, or a redirect', () => {
    const missing = SETTINGS_PATHS_BEFORE_1185.filter((p) => !existsSync(pageFile(p)));
    expect(missing).toEqual([]);
  });
  it('the list is the route tree as it was: nothing under settings is absent from it that has a page (a new route must be named)', () => {
    // Pages added by this ticket or later are not "before"; this guards the list from silently losing an entry instead.
    expect(SETTINGS_PATHS_BEFORE_1185.length).toBe(new Set(SETTINGS_PATHS_BEFORE_1185).size);
    expect(SETTINGS_PATHS_BEFORE_1185).toContain('/integrations/mcp');
    expect(SETTINGS_PATHS_BEFORE_1185).toContain('/connections');
  });
  it('/integrations/mcp is the one redirect, to /connect-ai (it was already one before this ticket)', () => {
    expect(readFileSync(pageFile('/integrations/mcp'), 'utf8')).toMatch(/redirect\(`\/w\/\$\{ws\}\/settings\/connect-ai`\)/);
  });
  it('the old /integrations/mcp link is also redirected in next.config, BEFORE the admins-only layout, so a member still lands on Connect your AI', async () => {
    const { default: config } = (await import('../../next.config.mjs')) as { default: { redirects: () => Promise<Array<{ source: string; destination: string }>> } };
    const rules = await config.redirects();
    expect(rules).toContainEqual(expect.objectContaining({ source: '/w/:ws/settings/integrations/mcp', destination: '/w/:ws/settings/connect-ai' }));
  });
  it('every nav entry resolves to a real page: no dead link (Packs is the existing Business packs page until ticket #1186)', () => {
    for (const p of SETTINGS_PAGES) {
      const file = p.outside
        ? fileURLToPath(new URL(`../app/w/[ws]${p.outside}/page.tsx`, import.meta.url))
        : pageFile(p.path!);
      expect(existsSync(file), `${p.id} -> ${p.path ?? p.outside}`).toBe(true);
    }
  });
  it('the old pages that were renamed keep their route: Profile is /account, Agent rules is /governance, API tokens is /api', () => {
    expect(settingsPageHref(WS, 'profile')).toBe('/w/ws/settings/account');
    expect(settingsPageHref(WS, 'agent-rules')).toBe('/w/ws/settings/governance');
    expect(settingsPageHref(WS, 'api-tokens')).toBe('/w/ws/settings/api');
  });
  it('/settings itself is now a page (it was a 404)', () => {
    expect(existsSync(fileURLToPath(new URL('../app/w/[ws]/settings/page.tsx', import.meta.url)))).toBe(true);
  });
});

describe('active state', () => {
  const link = (id: string) => groups('admin').flatMap((g) => g.links).find((l) => l.id === id)!;
  it('a page is current on its own URL and anything under it', () => {
    expect(isSettingsLinkActive('/w/ws/settings/integrations', link('integrations'))).toBe(true);
    expect(isSettingsLinkActive('/w/ws/settings/integrations/github', link('integrations'))).toBe(true);
  });
  it('Integrations also owns /connections, which has no nav entry of its own until ticket #1188 merges it', () => {
    expect(isSettingsLinkActive('/w/ws/settings/connections', link('integrations'))).toBe(true);
  });
  it('a prefix of the same letters is not the page: /api is not /api-keys', () => {
    expect(isSettingsLinkActive('/w/ws/settings/api-keys', link('api-tokens'))).toBe(false);
    expect(isSettingsLinkActive('/w/ws/settings', link('api-tokens'))).toBe(false);
  });
  it('the home href', () => {
    expect(settingsHomeHref('abc')).toBe('/w/abc/settings');
  });
});

describe('the gear opens Settings in one click (AC1)', () => {
  const sidebar = readFileSync(fileURLToPath(new URL('../components/sidebar.tsx', import.meta.url)), 'utf8');
  it('the rail gear is a link to /settings, not a menu trigger', () => {
    expect(sidebar).toMatch(/<RailLink href=\{`\/w\/\$\{ws\}\/settings`\} title="Settings"/);
    expect(sidebar).not.toContain('Settings & account');
  });
  it('Keyboard shortcuts and Sign out, which the gear menu held, are still reachable from the account menu', () => {
    const menu = readFileSync(fileURLToPath(new URL('../components/account-menu.tsx', import.meta.url)), 'utf8');
    expect(menu).toContain('Keyboard shortcuts');
    expect(menu).toContain('Sign out');
  });
});
