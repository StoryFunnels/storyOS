import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ALL_PACKS,
  ANY_TEAM,
  FEATURED_SPACE_PACKS,
  canAddToSpace,
  canInstallPacks,
  isSpaceEmpty,
  spacePackFilters,
  visibleSpacePacks,
} from './space-start';

const KINDS = [
  { value: 'all', label: 'All' },
  { value: 'agency', label: 'Agency' },
  { value: 'marketing', label: 'Marketing' },
  { value: 'engineering', label: 'Engineering' },
  { value: 'other', label: 'Other' },
];
const vertical = (slug: string) =>
  ({ 'agency-os': 'agency', 'content-engine': 'marketing', 'dev-tracker': 'engineering', 'team-board': 'other', 'team-wiki': 'other' })[slug] ?? 'other';
const pk = (slug: string) => ({ slug, name: slug });

describe('isSpaceEmpty (#1094)', () => {
  it('is empty only when there is no database, no document and no view', () => {
    expect(isSpaceEmpty({ databases: 0, documents: 0, views: 0 })).toBe(true);
  });
  // The rejections: each of these is a space with something in it, and calling it empty would offer "pick a ready-made setup"
  // over somebody's writing. A version that counted databases alone passed every test that only had databases.
  it('is NOT empty with only a document, only a view, or only a database', () => {
    expect(isSpaceEmpty({ databases: 0, documents: 1, views: 0 })).toBe(false);
    expect(isSpaceEmpty({ databases: 0, documents: 0, views: 1 })).toBe(false);
    expect(isSpaceEmpty({ databases: 1, documents: 0, views: 0 })).toBe(false);
  });
});

describe('canAddToSpace (#1094)', () => {
  it('offers the creators to admins and members, mirroring the sidebar', () => {
    expect(canAddToSpace('admin')).toBe(true);
    expect(canAddToSpace('member')).toBe(true);
  });
  it('withholds them from a guest, and while the role has not loaded', () => {
    expect(canAddToSpace('guest')).toBe(false);
    expect(canAddToSpace(undefined)).toBe(false);
  });
});

describe('canInstallPacks (#1094)', () => {
  // Measured live: a member's pack preview answers "Requires admin role", so offering them the cards opens a dialog on an error.
  it('is admin only', () => {
    expect(canInstallPacks('admin')).toBe(true);
    expect(canInstallPacks('member')).toBe(false);
    expect(canInstallPacks('guest')).toBe(false);
    expect(canInstallPacks(undefined)).toBe(false);
  });
});

describe('visibleSpacePacks (#1094)', () => {
  const registry = ['agency-os', 'content-engine', 'team-wiki', 'dev-tracker', 'team-board'].map(pk);

  it('leads with the featured packs in their own order, then the rest in registry order', () => {
    expect(visibleSpacePacks(registry, ALL_PACKS, vertical).map((p) => p.slug)).toEqual([
      'team-board',
      'dev-tracker',
      'team-wiki',
      'agency-os',
      'content-engine',
    ]);
  });
  it('"All" KEEPS every pack: nothing is dropped, only reordered', () => {
    expect(visibleSpacePacks(registry, ALL_PACKS, vertical)).toHaveLength(registry.length);
  });
  it('"Any team" is exactly the featured packs', () => {
    expect(visibleSpacePacks(registry, ANY_TEAM, vertical).map((p) => p.slug)).toEqual(['team-board', 'dev-tracker', 'team-wiki']);
  });
  it('a kind of work shows only its packs', () => {
    expect(visibleSpacePacks(registry, 'marketing', vertical).map((p) => p.slug)).toEqual(['content-engine']);
  });
  it('does not invent a featured pack the registry does not have', () => {
    const slugs = visibleSpacePacks([pk('agency-os')], ALL_PACKS, vertical).map((p) => p.slug);
    expect(slugs).toEqual(['agency-os']);
    expect(FEATURED_SPACE_PACKS.some((s) => slugs.includes(s))).toBe(false);
  });
});

describe('spacePackFilters (#1094)', () => {
  it('draws a chip only for a kind of work that has a pack, and "Any team" only when a featured pack exists', () => {
    const today = spacePackFilters(['agency-os', 'content-engine'].map(pk), vertical, KINDS).map((f) => f.value);
    expect(today).toEqual(['all', 'agency', 'marketing']);
    const later = spacePackFilters(['agency-os', 'team-board'].map(pk), vertical, KINDS).map((f) => f.value);
    expect(later).toEqual(['all', 'team', 'agency', 'other']);
  });
  it('always offers All, even with no packs', () => {
    expect(spacePackFilters([], vertical, KINDS).map((f) => f.value)).toEqual(['all']);
  });
});

// Source guards: the rules that live in how the page is WIRED, which no pure function sees.
describe('the space page wiring (#1094)', () => {
  const read = (p: string) => readFileSync(join(__dirname, p), 'utf8');
  const page = read('../app/w/[ws]/s/[space]/page.tsx');
  const dialog = read('../components/pack-install-dialog.tsx');
  const sidebar = read('../components/sidebar.tsx');

  it('sends the target space on BOTH preview and install, so the review cannot disagree with the install', () => {
    expect(dialog.match(/target_space_id: target\.id/g)?.length).toBe(2);
  });
  it('shows the server refusal text verbatim, not a generic error (the 409 names the database and the space)', () => {
    expect(dialog).toContain("apiErrorMessage(preview.error, 'This pack cannot be installed into this space.')");
    expect(dialog).toContain('target ? apiErrorMessage(e,');
  });
  it('installs the pack INTO the space the page is showing', () => {
    expect(page).toMatch(/<InstallDialog[\s\S]*target=\{\{ id: space\.id, name: space\.name \}\}/);
  });
  it('keeps the access door: visibleSpaceIds via the spaces list, never assertSpace', () => {
    expect(page).toContain('useSpaces(ws)');
    expect(page).not.toMatch(/assertSpace\(/);
  });
  it('never calls a space empty before every list answered, and never to someone who cannot add', () => {
    expect(page).toMatch(/const empty =\s*canAdd &&\s*known &&/);
  });
  it('offers the pack cards and the "From a pack…" item only where installing is allowed', () => {
    expect(page).toMatch(/\{packsOk && \(\s*<section>[\s\S]*<SpacePackGrid onPick=\{setInstallSlug\}/);
    expect(page).toContain('onPack={packsOk ? () => setPackPicker(true) : undefined}');
  });
  it('keeps the Access section, with the anchor the header chip jumps to', () => {
    expect(page).toContain('id="space-access"');
    expect(page).toContain('RESTRICTED_PRIVATE_NOTE');
  });
  it('New space opens the page it made', () => {
    expect(sidebar).toMatch(/createSpace\.mutate\([\s\S]*router\.push\(`\/w\/\$\{ws\}\/s\/\$\{created\.id\}`\)/);
  });
});
