import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { installedPackRow, installedPacksSummary, packSourceFor, type InstalledPackLike } from './installed-packs';
import { confirmUninstallPack } from './settings-confirmations';
import { SETTINGS_PAGES, canOpenSettingsPage, settingsNavGroups, settingsPageHref, settingsFlags } from './settings-nav';

const here = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));
const date = (iso: string) => new Date(iso).toISOString().slice(0, 10);

const board: InstalledPackLike = {
  id: 'i1', slug: 'team-board', name: 'Team Board', version: '1.0.0', installed_at: '2026-07-26T10:00:00Z', installed_by: 'u1',
  latest_version: '1.0.0', update_available: false,
};
const wiki: InstalledPackLike = { ...board, id: 'i2', slug: 'team-wiki', name: 'Team Wiki', version: '1.0.0', latest_version: '1.1.0', update_available: true };

describe('an installed pack row (#1186 AC5)', () => {
  it('says its version, who installed it and when, and that it is up to date', () => {
    expect(installedPackRow(board, date, 'Ievgen Krasovytskyi')).toEqual({
      id: 'i1',
      name: 'Team Board',
      version: '1.0.0',
      detail: 'Installed 2026-07-26 by Ievgen Krasovytskyi',
      status: { tone: 'ok', label: 'Up to date' },
      updateLabel: null,
      uninstallAriaLabel: 'Uninstall Team Board',
    });
  });

  it('leaves the person out when no member matches the id: never a guess', () => {
    expect(installedPackRow(board, date, null).detail).toBe('Installed 2026-07-26');
  });

  it('an update waiting shows a warning pill and an Update button naming the new version', () => {
    const row = installedPackRow(wiki, date, null);
    expect(row.status).toEqual({ tone: 'warn', label: 'Update available' });
    expect(row.updateLabel).toBe('Update to v1.1.0');
  });

  it('update_available with no latest_version offers no Update (nothing to update to)', () => {
    expect(installedPackRow({ ...wiki, latest_version: null }, date, null).updateLabel).toBeNull();
  });

  it('summarises the list, counting every installed pack', () => {
    expect(installedPacksSummary([])).toBe('No packs installed');
    expect(installedPacksSummary([board])).toBe('1 pack installed');
    expect(installedPacksSummary([board, wiki])).toBe('2 packs installed · 1 update available');
    expect(installedPacksSummary([wiki, wiki])).toBe('2 packs installed · 2 updates available');
  });

  it('a pack updates through whichever of the registry or the marketplace lists it', () => {
    expect(packSourceFor('team-board', new Set(['team-board']))).toBe('registry');
    expect(packSourceFor('community-thing', new Set(['team-board']))).toBe('marketplace');
  });
});

describe('Uninstall confirms, naming what goes and what stays (#1186 AC5)', () => {
  const c = confirmUninstallPack('Team Board');

  it('names the pack and is a danger confirm', () => {
    expect(c.title).toBe('Uninstall Team Board?');
    expect(c.confirmLabel).toBe('Uninstall');
    expect(c.danger).toBe(true);
  });

  it('states the blast radius the API has: views, automations, agents and skills go unless changed; databases, fields and records stay', () => {
    expect(c.message).toContain('views, automations, agents and skills Team Board added');
    expect(c.message).toContain('except any you changed since');
    expect(c.message).toContain('databases, fields and records are never removed');
  });

  it('does NOT claim views stay: the prototype draft said so, and PacksService.uninstall removes unchanged views', () => {
    expect(c.message).not.toMatch(/databases, records and views stay/i);
    expect(c.message).toContain('removes the views');
  });

  it('both pages ask through the shared confirm, and neither calls window.confirm', () => {
    for (const rel of ['../app/w/[ws]/settings/packs/page.tsx', '../app/w/[ws]/packs/page.tsx']) {
      const src = readFileSync(here(rel), 'utf8');
      expect(src, rel).toContain('confirmUninstallPack(pack.name)');
      expect(src, rel).toContain('await confirm(');
      expect(src, rel).not.toContain('window.confirm');
    }
  });

  it('the page runs the uninstall only after a yes (the mutation sits inside the if)', () => {
    const src = readFileSync(here('../app/w/[ws]/settings/packs/page.tsx'), 'utf8');
    expect(src).toMatch(/if \(await confirm\(confirmUninstallPack\(pack\.name\)\)\) uninstall\.mutate\(pack\.id\)/);
  });
});

describe('the Packs page: who can open it and how it is reached (#1186)', () => {
  const packs = SETTINGS_PAGES.find((p) => p.id === 'packs')!;

  it('lives under settings, in the Workspace group, and the page file exists', () => {
    expect(packs).toMatchObject({ group: 'workspace', path: '/packs', access: 'admins' });
    expect(existsSync(here('../app/w/[ws]/settings/packs/page.tsx'))).toBe(true);
    expect(settingsPageHref('w1', 'packs')).toBe('/w/w1/settings/packs');
  });

  it('a member and a guest cannot open it, and their nav has no Packs row', () => {
    expect(canOpenSettingsPage(packs, 'admin')).toBe(true);
    expect(canOpenSettingsPage(packs, 'member')).toBe(false);
    expect(canOpenSettingsPage(packs, 'guest')).toBe(false);
    for (const role of ['member', 'guest']) {
      const ids = settingsNavGroups('w1', role, settingsFlags(role, false)).flatMap((g) => g.links.map((l) => l.id));
      expect(ids).not.toContain('packs');
    }
  });

  it('the route refuses a member or guest who types the URL (the layout wraps the shared admins-only gate)', () => {
    expect(readFileSync(here('../app/w/[ws]/settings/packs/layout.tsx'), 'utf8')).toMatch(/<AdminsOnly title="Packs">\{children\}<\/AdminsOnly>/);
  });

  it('the marketplace route stays, and Browse packs goes to it', () => {
    expect(existsSync(here('../app/w/[ws]/packs/page.tsx'))).toBe(true);
    expect(readFileSync(here('../app/w/[ws]/settings/packs/page.tsx'), 'utf8')).toContain('href={`/w/${ws}/packs`}');
  });

  it('Update opens the shared install dialog on the pack it names', () => {
    const src = readFileSync(here('../app/w/[ws]/settings/packs/page.tsx'), 'utf8');
    expect(src).toContain('<InstallDialog');
    expect(src).toContain('installed={updating.pack}');
  });
});
