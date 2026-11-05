import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AdminsOnlyNotice } from '@/components/settings/admins-only';
import { AdvancedSection } from '@/components/settings/settings-chrome';
import { EMPTY_AUDIT_FILTERS, auditFilterSummary, resolveAuditFilters } from '@/lib/audit-filters';
import { confirmRevokeSession } from '@/lib/settings-confirmations';
import { SETTINGS_PAGES, canOpenAdminSettings, settingsFlags, settingsNavGroups } from '@/lib/settings-nav';

/**
 * Ticket #1189 — Settings 5: Data & security (Export, Trash, Audit log) and You (Profile, Preferences, Notifications, Referrals),
 * power controls under a labelled Advanced, no explanation that lives only in a tooltip.
 *
 * Most guards here READ THE PAGE SOURCE: the pages are client components on queries, and this repo has no DOM test setup, so the
 * guard states a rule over the file and fails when the file stops obeying it. Each was mutated once to prove it can fail (see the PR).
 */
const SRC = fileURLToPath(new URL('..', import.meta.url));
const SETTINGS = join(SRC, 'app/w/[ws]/settings');
const read = (p: string) => readFileSync(p, 'utf8');
const page = (dir: string) => read(join(SETTINGS, dir, 'page.tsx'));
const layout = (dir: string) => read(join(SETTINGS, dir, 'layout.tsx'));

/** The text between `<AdvancedSection` and its closing tag: what a person only sees after opening it. */
function advancedBlock(source: string): string {
  const open = source.indexOf('<AdvancedSection');
  const close = source.indexOf('</AdvancedSection>');
  expect(open, 'page has no <AdvancedSection>').toBeGreaterThan(-1);
  expect(close).toBeGreaterThan(open);
  return source.slice(open, close);
}

describe('control inventory: every control these pages had on main is still here (parity table, ticket #974)', () => {
  // Read off main at a80bb4dd, page by page, before the rebuild. A dropped control fails by name.
  it('Profile: photo, name, email, password, sessions, delete account', () => {
    const src = page('account');
    for (const needle of [
      "accept=\"image/png,image/jpeg,image/webp\"", // the hidden file input
      "'Change' : 'Upload'", // Change / Upload (Photo)
      'Remove', // Remove (Photo)
      'id="display-name"', // Display name
      'Save', // Save (Name)
      'id="cur-pw"', // Current password
      'id="new-pw"', // New password
      'Change password', // Change password
      'Sign out', // per non-current session (was "Revoke")
      'Delete my account…', // Delete my account…
      'id="delete-account-confirm"', // Type your email to confirm
      'Cancel', // Cancel
      'Delete my account permanently', // the confirmed delete
      'Verified', // email state
    ]) {
      expect(src, `Profile lost: ${needle}`).toContain(needle);
    }
  });

  it('Preferences: theme, date format, time format, first day of week, with every option they offered', () => {
    const src = page('preferences');
    for (const needle of [
      'label="Theme"', 'label="Date format"', 'label="Time format"', 'label="Week starts on"',
      "'system'", "'light'", "'dark'", "'MDY'", "'DMY'", "'YMD'", "'12h'", "'24h'", "'sunday'", "'monday'", "'saturday'",
    ]) {
      expect(src, `Preferences lost: ${needle}`).toContain(needle);
    }
  });

  it('Notifications: all five events', () => {
    const src = page('notifications');
    for (const key of ['assigned', 'mentioned', 'commented', 'state_changed', 'record_changed']) {
      expect(src, `Notifications lost: ${key}`).toContain(`key: '${key}'`);
    }
  });

  it('Referrals: the link, Copy, the rewards and the terms, and the self-hosted state', () => {
    const src = page('referrals');
    for (const needle of ['aria-label="Your referral link"', 'Copy', 'Sign-ups', 'Paying conversions', 'Earned rewards', 'Terms', "isn’t available on this self-hosted instance"]) {
      expect(src, `Referrals lost: ${needle}`).toContain(needle);
    }
  });

  it('Export: the download link to the workspace zip', () => {
    const src = page('export');
    expect(src).toContain('/export/workspace.zip');
    expect(src).toContain('Export workspace');
  });

  it('Trash: Restore for a deleted space and for a deleted database, through the endpoints the page always used', () => {
    const src = page('trash');
    expect(src).toContain('/api/v1/workspaces/{ws}/spaces/{space}/restore');
    expect(src).toContain('/api/v1/workspaces/{ws}/databases/{db}/restore');
    expect(src).toContain('title="Spaces"');
    expect(src).toContain('title="Databases"');
    expect(read(join(SRC, 'components/entity/trash-list.tsx'))).toContain('Restore');
  });

  it('Audit log: Actor, Type, Record or object ID, From, To and Load more', () => {
    const src = page('audit-log');
    for (const needle of ['label="Actor"', 'label="Type"', 'Record or object ID', '>\n                From', '>\n                To', 'Load more']) {
      expect(src, `Audit log lost: ${needle}`).toContain(needle);
    }
  });
});

describe('Advanced: closed by default, never a hover, and holds the power controls', () => {
  it('the shared disclosure renders closed: a <details> with no `open` attribute', () => {
    const html = renderToStaticMarkup(createElement(AdvancedSection, { title: 'Filter', summary: 'actor, type', children: 'inside' }));
    expect(html).toContain('<details');
    expect(html).not.toMatch(/<details[^>]*\sopen/);
    expect(html).toContain('Filter');
    expect(html).toContain('actor, type');
  });

  it('Profile: sessions and delete-account are inside Advanced; photo, name and password are not', () => {
    const inside = advancedBlock(page('account'));
    expect(inside).toContain('<SessionsRows');
    expect(inside).toContain('<DeleteAccountRow');
    expect(inside).toContain('title="Sessions and account"');
    expect(inside).not.toContain('<ProfileBox');
    expect(inside).not.toContain('<PasswordBox');
  });

  it('Audit log: every filter is inside Advanced; the log and Load more are not', () => {
    const src = page('audit-log');
    const inside = advancedBlock(src);
    for (const needle of ['label="Actor"', 'label="Type"', 'audit-entity', 'audit-from', 'audit-to']) expect(inside, needle).toContain(needle);
    expect(inside).not.toContain('audit-row');
    expect(inside).not.toContain('Load more');
    expect(src.indexOf('Load more')).toBeLessThan(src.indexOf('<AdvancedSection'));
  });

  it('a filter that is on stays visible while Advanced is closed: the summary counts it, and an empty log names the filters', () => {
    expect(auditFilterSummary(0)).toBe('actor, type, record, dates');
    expect(auditFilterSummary(2)).toBe('actor, type, record, dates · 2 applied');
    expect(page('audit-log')).toContain('Nothing matches these filters');
  });

  it('the pages for everyone are NOT hidden behind Advanced: the Referrals link, the Export button and the Trash lists', () => {
    expect(page('referrals')).not.toContain('<AdvancedSection');
    expect(page('export')).not.toContain('<AdvancedSection');
    expect(page('trash')).not.toContain('<AdvancedSection');
    expect(page('preferences')).not.toContain('<AdvancedSection');
    expect(page('notifications')).not.toContain('<AdvancedSection');
  });

  it('no page here opens anything on hover', () => {
    for (const dir of ['account', 'preferences', 'notifications', 'referrals', 'export', 'trash', 'audit-log']) {
      expect(page(dir), dir).not.toMatch(/onMouseEnter|onPointerEnter|group-hover:(block|flex|visible|opacity-100)/);
    }
  });
});

describe('no explanation lives only in a tooltip (ticket #900)', () => {
  const FILES = [
    ...['account', 'preferences', 'notifications', 'referrals', 'export', 'trash', 'audit-log'].map((d) => join(SETTINGS, d, 'page.tsx')),
    join(SRC, 'components/entity/trash-list.tsx'),
    join(SRC, 'components/settings/settings-chrome.tsx'),
  ];
  // A native element carrying `title=` is a hover tooltip. (A component's own `title` prop, like <SettingsBox title="…">, is visible text.)
  const NATIVE_TITLE = /<(a|button|span|div|p|b|i|li|label|input|img|svg|summary|code)\b[^>]*\btitle=/;

  it('no native element on these pages or their shared chrome uses title= (an explanation worth having is written on the page)', () => {
    for (const f of FILES) expect(read(f), f).not.toMatch(NATIVE_TITLE);
  });

  it('the guard can fail: it catches a title= on a link', () => {
    expect('<a href="x" title="Download the whole workspace as a .zip">').toMatch(NATIVE_TITLE);
    expect('<SettingsBox title="Spaces">').not.toMatch(NATIVE_TITLE);
  });

  it('the two converted tooltips are now visible text: the export detail and the audit record id', () => {
    expect(page('export')).toContain('Large workspaces stream, so the download may take a moment to start.');
    const audit = page('audit-log');
    expect(audit).toContain('data-testid="audit-record-id"');
    expect(audit).toContain('record {e.record_id}');
  });
});

describe('Settings has no native select or date input (Dara, ticket #1191)', () => {
  it('Preferences and the Audit log use the shared MenuSelect, not <select>, ui/select or type="date"', () => {
    for (const dir of ['preferences', 'audit-log']) {
      const src = page(dir);
      expect(src, dir).toContain("from '@/components/ui/menu-select'");
      expect(src, dir).not.toMatch(/<select\b|<Select\b|components\/ui\/select'|type="date"/);
    }
  });
});

describe('sign out a session confirms (ticket #1093) and still signs it out', () => {
  const src = page('account');

  it('the only revokeSession call is reached through a confirm that is awaited first', () => {
    expect(src.match(/revoke\.mutate\(/g)).toHaveLength(1);
    expect(src).toMatch(/if \(await confirm\(confirmRevokeSession\(device, ip\)\)\) revoke\.mutate\(s\.token\)/);
    expect(src).toContain('authClient.revokeSession({ token })');
  });

  it('the dialog names the device and its address, says what happens, and is the danger style', () => {
    const c = confirmRevokeSession('Safari on iOS', '203.0.113.7');
    expect(c.title).toBe('Sign out Safari on iOS?');
    expect(c.message).toContain('203.0.113.7');
    expect(c.message).toContain('This device stays signed in');
    expect(c.danger).toBe(true);
  });

  it('this device has no sign-out button, and the button is labelled Sign out', () => {
    expect(src).toContain('{!isCurrent && (');
    expect(src).toMatch(/>\s*Sign out\s*</);
  });
});

describe('Export, Trash and Audit log refuse a member and a guest (the #939 / #940 class)', () => {
  const PAGES = [
    { dir: 'export', title: 'Export' },
    { dir: 'trash', title: 'Trash' },
    { dir: 'audit-log', title: 'Audit log' },
  ];

  it('each is admin-only in the nav declaration, in the data group', () => {
    for (const { dir } of PAGES) {
      const entry = SETTINGS_PAGES.find((p) => p.path === `/${dir}`);
      expect(entry, dir).toBeDefined();
      expect(entry!.access).toBe('admins');
      expect(entry!.group).toBe('data');
    }
  });

  it('each route is wrapped from its layout in AdminsOnly with its own title', () => {
    for (const { dir, title } of PAGES) expect(layout(dir), dir).toContain(`<AdminsOnly title="${title}">{children}</AdminsOnly>`);
  });

  it('the refusal a member and a guest see names the page and who may open it', () => {
    for (const { title } of PAGES) {
      expect(renderToStaticMarkup(createElement(AdminsOnlyNotice, { title, role: 'member' }))).toContain(`${title} is for workspace admins. You are a member here`);
      expect(renderToStaticMarkup(createElement(AdminsOnlyNotice, { title, role: 'guest' }))).toContain(`${title} is for workspace admins. You are a guest here`);
    }
  });

  it('only an admin passes, and the pages use that named predicate rather than an inline role check', () => {
    expect(canOpenAdminSettings('admin')).toBe(true);
    for (const role of ['member', 'guest', undefined]) expect(canOpenAdminSettings(role)).toBe(false);
    for (const { dir } of PAGES) expect(page(dir), dir).not.toMatch(/role === 'admin'/);
    for (const { dir } of PAGES) expect(page(dir), dir).toContain('canOpenAdminSettings');
  });

  it('the nav offers the three to an admin together, in order, and to nobody else', () => {
    const data = (role: string) => settingsNavGroups('w', role, settingsFlags(role, true, true)).find((g) => g.id === 'data');
    expect(data('admin')!.links.map((l) => l.label)).toEqual(['Export', 'Trash', 'Audit log']);
    expect(data('member')).toBeUndefined();
    expect(data('guest')).toBeUndefined();
  });
});

describe('You: everyone has Profile, Preferences and Notifications; Referrals is cloud only', () => {
  const links = (role: string, referrals: boolean) =>
    settingsNavGroups('w', role, settingsFlags(role, true, referrals)).find((g) => g.id === 'you')!.links.map((l) => l.label);

  it('a guest, a member and an admin all get the three personal pages', () => {
    for (const role of ['guest', 'member', 'admin']) expect(links(role, false)).toEqual(['Profile', 'Preferences', 'Notifications']);
  });

  it('Referrals appears only when the cloud signal is on, for every role', () => {
    for (const role of ['guest', 'member', 'admin']) {
      expect(links(role, true)).toEqual(['Profile', 'Preferences', 'Notifications', 'Referrals']);
      expect(links(role, false)).not.toContain('Referrals');
    }
    expect(settingsFlags('admin', true, undefined).referralsEnabled).toBe(false);
  });

  it('typing the Referrals URL on self-managed still says why, in the page, rather than a dead link', () => {
    expect(page('referrals')).toContain('if (!r.enabled)');
    expect(page('referrals')).toContain('cloud feature');
  });

  it('the personal pages are not behind AdminsOnly', () => {
    for (const dir of ['account', 'preferences', 'notifications', 'referrals']) expect(() => layout(dir)).toThrow();
  });
});

describe('Notifications points an admin to the workspace-wide GitHub setting', () => {
  it('the pointer is offered to an admin only, and links the GitHub integration page', () => {
    const src = page('notifications');
    expect(src).toMatch(/isAdmin && \(/);
    expect(src).toContain('/settings/integrations/github');
    expect(src).toContain('Integrations › GitHub');
  });
});

describe('Audit filters: what is sent, and what a half-typed date does', () => {
  it('nothing set sends nothing and counts nothing', () => {
    const r = resolveAuditFilters(EMPTY_AUDIT_FILTERS);
    expect(r.query).toEqual({});
    expect(r.applied).toBe(0);
    expect(r.invalid).toEqual([]);
  });

  it('actor, type and record id are sent as typed (the record id trimmed)', () => {
    const r = resolveAuditFilters({ ...EMPTY_AUDIT_FILTERS, actor: 'u1', type: 'deleted', entity: '  abc  ' });
    expect(r.query).toEqual({ actor: 'u1', type: 'deleted', entity: 'abc' });
    expect(r.applied).toBe(3);
  });

  it('a typed date is parsed by the shared parser and sent as an ISO instant', () => {
    const r = resolveAuditFilters({ ...EMPTY_AUDIT_FILTERS, from: '2026-10-27', to: '27.10.2026' });
    expect(r.query.from).toBe(new Date('2026-10-27').toISOString());
    expect(r.query.to).toBe(new Date('2026-10-27').toISOString());
    expect(r.applied).toBe(2);
  });

  it('a date that does not parse yet is NOT sent and is reported, so the log is not silently filtered to nothing', () => {
    const r = resolveAuditFilters({ ...EMPTY_AUDIT_FILTERS, from: 'jul', to: '2026-10-27' });
    expect(r.query.from).toBeUndefined();
    expect(r.invalid).toEqual(['from']);
    expect(r.applied).toBe(1);
  });

  it('what a filter must KEEP: clearing a box removes the filter again', () => {
    const on = resolveAuditFilters({ ...EMPTY_AUDIT_FILTERS, actor: 'u1' });
    const off = resolveAuditFilters({ ...on.query, ...EMPTY_AUDIT_FILTERS } as typeof EMPTY_AUDIT_FILTERS);
    expect(off.applied).toBe(0);
  });
});
