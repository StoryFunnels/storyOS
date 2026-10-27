import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { describe, expect, it } from 'vitest';
import { canOpenAdminSettings, workspaceSettingsLinks } from '@/lib/settings-nav';
import { AdminsOnlyNotice } from './admins-only';

const SETTINGS = fileURLToPath(new URL('../../app/w/[ws]/settings', import.meta.url));
const dirs = readdirSync(SETTINGS).filter((n) => statSync(join(SETTINGS, n)).isDirectory());
const read = (p: string) => readFileSync(p, 'utf8');

describe('admin-only settings pages refuse a member in-page (#1092)', () => {
  it('only an admin may open an admin settings page: a member, a guest and a missing role may not', () => {
    expect(canOpenAdminSettings('admin')).toBe(true);
    for (const role of ['member', 'guest', undefined, '']) expect(canOpenAdminSettings(role as string | undefined)).toBe(false);
  });

  it('the refusal says which page, who it is for, and why the person sees it', () => {
    const member = renderToStaticMarkup(createElement(AdminsOnlyNotice, { title: 'Billing', role: 'member' }));
    expect(member).toContain('Billing is for workspace admins');
    expect(member).toContain('You are a member here');
    expect(renderToStaticMarkup(createElement(AdminsOnlyNotice, { title: 'Webhooks', role: 'guest' }))).toContain('You are a guest here');
  });

  it('every route the settings nav shows ONLY to an admin refuses a non-admin in-page: a layout wrapping AdminsOnly, or its own isAdmin check', () => {
    // The nav says which pages are admin-only; derive the set from it (an admin sees every link, a member only their own), so a new
    // admin-only nav entry fails here until its page refuses, rather than relying on this list being remembered.
    const base = '/w/x/settings';
    const asAdmin = new Set(workspaceSettingsLinks(base, { isAdmin: true, canEdit: true, billingEnabled: true }).map((l) => l.href));
    const asMember = new Set(workspaceSettingsLinks(base, { isAdmin: false, canEdit: true, billingEnabled: true }).map((l) => l.href));
    const adminOnly = [...asAdmin].filter((h) => !asMember.has(h)).map((h) => h.replace(`${base}/`, ''));
    expect(adminOnly.length).toBeGreaterThanOrEqual(6);
    for (const d of adminOnly) {
      const layout = join(SETTINGS, d, 'layout.tsx');
      const page = join(SETTINGS, d, 'page.tsx');
      let layoutSrc = '';
      try { layoutSrc = read(layout); } catch { /* no layout */ }
      const wrapped = /<AdminsOnly\b/.test(layoutSrc);
      // Its own refusal, in the page's words ("Only workspace admins can ..."): export, trash, audit-log and governance already had one.
      const ownCheck = /Only (workspace )?admins? can/.test(read(page));
      expect(wrapped || ownCheck, `/settings/${d} is admin-only in the nav but a member who types the URL gets the page`).toBe(true);
    }
  });

  it('the pages the ticket names are wrapped from a layout, so every page under them (and any added later) is covered', () => {
    for (const d of ['billing', 'webhooks', 'connections', 'integrations', 'members']) {
      expect(dirs).toContain(d);
      expect(read(join(SETTINGS, d, 'layout.tsx')), `${d}/layout.tsx`).toMatch(/<AdminsOnly title="[A-Za-z]+">\{children\}<\/AdminsOnly>/);
    }
  });

  it('personal pages and the pages a member may use are NOT wrapped (the gate must not over-refuse)', () => {
    for (const d of ['account', 'preferences', 'notifications', 'referrals', 'api', 'connect-ai', 'general']) {
      let src = '';
      try { src = read(join(SETTINGS, d, 'layout.tsx')); } catch { /* none */ }
      expect(src).not.toContain('AdminsOnly');
    }
  });
});
