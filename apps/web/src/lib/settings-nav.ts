/**
 * Workspace settings navigation, as a pure function of the viewer's role (tickets #875, #1185), so the gating can be tested per
 * role, guest included.
 *
 * ONE declaration, `SETTINGS_PAGES`, says for every settings page: which of the five groups it sits in, where it lives, and who may
 * open it. The nav, the home page and the guard tests all read it, so a page cannot be shown to a role it refuses (or hidden from one
 * it admits) because two lists drifted. To add a settings page, add a row here; the other #974 tickets extend the shell this way.
 *
 * Three access rules, each a named predicate, never an inline role check:
 *  - `everyone`: a person's own settings (Profile, Preferences, Notifications, Referrals).
 *  - `editors` (`canConnectAi`, role !== 'guest'): what a MEMBER may do with their own credential: Connect your AI, Runners, API tokens.
 *  - `admins` (`canOpenAdminSettings`): workspace-level and credential surfaces. The same rule the API applies with `@MinRole('admin')`
 *    and the in-page refusal applies (`AdminsOnly`, #1092).
 */
export interface SettingsNavFlags {
  isAdmin: boolean;
  canEdit: boolean;
  /** Cloud only: false on a self-managed deployment (no STRIPE_SECRET_KEY), so Plan & billing is not offered. */
  billingEnabled: boolean;
  /** Cloud only: the referral programme is off on a self-managed deployment, so Referrals is not offered. */
  referralsEnabled: boolean;
}

export function settingsFlags(
  role: string | undefined,
  billingEnabled: boolean | undefined,
  referralsEnabled?: boolean | undefined,
): SettingsNavFlags {
  return {
    isAdmin: canOpenAdminSettings(role),
    canEdit: canConnectAi(role),
    billingEnabled: Boolean(billingEnabled),
    referralsEnabled: Boolean(referralsEnabled),
  };
}

/**
 * Whether a role may open a workspace-level admin settings page (Billing, Webhooks, Connections, Integrations...): admins only, the
 * same rule the nav applies with `isAdmin` and the API applies with `@MinRole('admin')`. One predicate for the in-page refusal
 * (`AdminsOnly`, #1092), so the nav, the page and the guard test cannot drift.
 */
export function canOpenAdminSettings(role: string | undefined): boolean {
  return role === 'admin';
}

/** Whether a role may use the Connect-your-AI screen: the same rule as minting an API token. */
export function canConnectAi(role: string | undefined): boolean {
  return role !== 'guest';
}

export type SettingsGroupId = 'you' | 'workspace' | 'ai' | 'connections' | 'data';
export type SettingsAccess = 'everyone' | 'editors' | 'admins';
export type SettingsCloudGate = 'billing' | 'referrals';

export type SettingsPageId =
  | 'profile' | 'preferences' | 'notifications' | 'referrals'
  | 'general' | 'members' | 'billing' | 'packs'
  | 'connect-ai' | 'runners' | 'agent-rules'
  | 'integrations' | 'api-tokens' | 'webhooks'
  | 'export' | 'trash' | 'audit-log';

export interface SettingsPage {
  id: SettingsPageId;
  group: SettingsGroupId;
  label: string;
  access: SettingsAccess;
  /** Path under `/w/{ws}/settings`; omit when the page lives outside it (see `outside`). */
  path?: string;
  /** Path under `/w/{ws}` for a page that is not (yet) under settings. Packs is the only one: ticket #1186 moves it. */
  outside?: string;
  /** Other path prefixes under settings that count as being on this page (e.g. Integrations also owns /connections). */
  alsoActiveFor?: string[];
  /** Offered only where this cloud capability is on; hidden, not greyed, on a self-managed deployment. */
  cloud?: SettingsCloudGate;
}

export const SETTINGS_GROUPS: ReadonlyArray<{ id: SettingsGroupId; title: string }> = [
  { id: 'you', title: 'You' },
  { id: 'workspace', title: 'Workspace' },
  { id: 'ai', title: 'AI' },
  { id: 'connections', title: 'Connections' },
  { id: 'data', title: 'Data & security' },
];

/**
 * Every settings page, in nav order. Routes keep their file names: `account` is Profile, `governance` is Agent rules, `api` is API
 * tokens, so every URL that existed before ticket #1185 still resolves (the old-URL test enumerates them).
 */
export const SETTINGS_PAGES: ReadonlyArray<SettingsPage> = [
  { id: 'profile', group: 'you', label: 'Profile', access: 'everyone', path: '/account' },
  { id: 'preferences', group: 'you', label: 'Preferences', access: 'everyone', path: '/preferences' },
  { id: 'notifications', group: 'you', label: 'Notifications', access: 'everyone', path: '/notifications' },
  { id: 'referrals', group: 'you', label: 'Referrals', access: 'everyone', path: '/referrals', cloud: 'referrals' },

  { id: 'general', group: 'workspace', label: 'General', access: 'admins', path: '/general' },
  { id: 'members', group: 'workspace', label: 'Members', access: 'admins', path: '/members' },
  { id: 'billing', group: 'workspace', label: 'Plan & billing', access: 'admins', path: '/billing', cloud: 'billing' },
  // Ticket #1186 builds the real Packs page under settings; until it lands this is the existing Business packs page.
  { id: 'packs', group: 'workspace', label: 'Packs', access: 'admins', outside: '/packs' },

  { id: 'connect-ai', group: 'ai', label: 'Connect your AI', access: 'editors', path: '/connect-ai' },
  { id: 'runners', group: 'ai', label: 'Runners', access: 'editors', path: '/runners' },
  { id: 'agent-rules', group: 'ai', label: 'Agent rules', access: 'admins', path: '/governance' },

  { id: 'integrations', group: 'connections', label: 'Integrations', access: 'admins', path: '/integrations', alsoActiveFor: ['/connections'] },
  { id: 'api-tokens', group: 'connections', label: 'API tokens', access: 'editors', path: '/api' },
  { id: 'webhooks', group: 'connections', label: 'Webhooks', access: 'admins', path: '/webhooks' },

  { id: 'export', group: 'data', label: 'Export', access: 'admins', path: '/export' },
  { id: 'trash', group: 'data', label: 'Trash', access: 'admins', path: '/trash' },
  { id: 'audit-log', group: 'data', label: 'Audit log', access: 'admins', path: '/audit-log' },
];

/** Whether a role may open a page: the one answer the nav, the home page and the guard test all use. */
export function canOpenSettingsPage(page: Pick<SettingsPage, 'access'>, role: string | undefined): boolean {
  // The role has not loaded: offer only what everyone has, so a guest never sees the AI group flash up and vanish.
  if (role === undefined) return page.access === 'everyone';
  if (page.access === 'admins') return canOpenAdminSettings(role);
  if (page.access === 'editors') return canConnectAi(role);
  return true;
}

function cloudAllows(page: Pick<SettingsPage, 'cloud'>, flags: SettingsNavFlags): boolean {
  if (page.cloud === 'billing') return flags.billingEnabled;
  if (page.cloud === 'referrals') return flags.referralsEnabled;
  return true;
}

export interface SettingsNavLink {
  id: SettingsPageId;
  href: string;
  label: string;
  /** Hrefs (beyond `href` and its subpages) on which this link shows as current. */
  alsoActiveFor: string[];
}

export interface SettingsNavGroup {
  id: SettingsGroupId;
  title: string;
  links: SettingsNavLink[];
}

export function settingsHomeHref(ws: string): string {
  return `/w/${ws}/settings`;
}

function pageHref(ws: string, page: SettingsPage): string {
  return page.outside ? `/w/${ws}${page.outside}` : `${settingsHomeHref(ws)}${page.path}`;
}

/** Where a page lives, by id: the one place a card or a link looks it up, so none can hold a copy of the URL. */
export function settingsPageHref(ws: string, id: SettingsPageId): string {
  const page = SETTINGS_PAGES.find((p) => p.id === id);
  if (!page) throw new Error(`Unknown settings page: ${id}`);
  return pageHref(ws, page);
}

/** The nav: the groups this viewer can open anything in, each holding only the pages they can open. */
export function settingsNavGroups(ws: string, role: string | undefined, flags: SettingsNavFlags): SettingsNavGroup[] {
  return SETTINGS_GROUPS.map((g) => ({
    id: g.id,
    title: g.title,
    links: SETTINGS_PAGES.filter((p) => p.group === g.id && canOpenSettingsPage(p, role) && cloudAllows(p, flags)).map((p) => ({
      id: p.id,
      href: pageHref(ws, p),
      label: p.label,
      alsoActiveFor: (p.alsoActiveFor ?? []).map((s) => `${settingsHomeHref(ws)}${s}`),
    })),
  })).filter((g) => g.links.length > 0);
}

/** Whether `pathname` is on this link's page: its own URL, anything beneath it, or one of its `alsoActiveFor` paths. */
export function isSettingsLinkActive(pathname: string, link: Pick<SettingsNavLink, 'href' | 'alsoActiveFor'>): boolean {
  return [link.href, ...link.alsoActiveFor].some((h) => pathname === h || pathname.startsWith(`${h}/`));
}

/**
 * Every settings URL that existed on main before ticket #1185 (enumerated from the route tree and the old nav), relative to
 * `/w/{ws}/settings`. A test asserts each still has a page file; `/integrations/mcp` is the one that redirects (to `/connect-ai`).
 */
export const SETTINGS_PATHS_BEFORE_1185: ReadonlyArray<string> = [
  '/account', '/api', '/audit-log', '/billing', '/connect-ai', '/connections', '/export', '/general', '/governance',
  '/integrations', '/integrations/delegate-agent', '/integrations/github', '/integrations/google-calendar', '/integrations/linear',
  '/integrations/linkedin', '/integrations/mcp', '/integrations/meta', '/integrations/shopify', '/integrations/slack', '/integrations/x',
  '/integrations/youtube', '/members', '/notifications', '/preferences', '/referrals', '/runners', '/trash', '/webhooks',
];
