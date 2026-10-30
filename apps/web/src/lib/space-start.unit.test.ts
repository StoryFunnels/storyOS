import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ALL_PACKS,
  ANY_TEAM,
  FEATURED_SPACE_PACKS,
  adminAskLine,
  canAddToSpace,
  canInstallPacks,
  isSpaceEmpty,
  renamedAfterInstall,
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

describe('adminAskLine (#1094)', () => {
  const m = (...names: string[]) => names.map((name) => ({ role: 'admin', user: { name } }));
  it('names the admins naturally: one, two, three', () => {
    expect(adminAskLine(m('Ada'))).toBe('Only admins can add packs. Ask Ada to add one.');
    expect(adminAskLine(m('Ada', 'Bo'))).toBe('Only admins can add packs. Ask Ada or Bo to add one.');
    expect(adminAskLine(m('Ada', 'Bo', 'Cy'))).toBe('Only admins can add packs. Ask Ada, Bo or Cy to add one.');
  });
  it('caps at three names and counts the rest', () => {
    expect(adminAskLine(m('Ada', 'Bo', 'Cy', 'Di', 'Ed'))).toBe('Only admins can add packs. Ask Ada, Bo, Cy and 2 more to add one.');
  });
  it('names ONLY admins: members and guests in the list are never named', () => {
    const list = [...m('Ada'), { role: 'member', user: { name: 'Mia' } }, { role: 'guest', user: { name: 'Gus' } }];
    expect(adminAskLine(list)).not.toMatch(/Mia|Gus/);
  });
  it('never invents a name: no list, or no admin in it, says a workspace admin', () => {
    expect(adminAskLine(undefined)).toBe('Only admins can add packs. Ask a workspace admin to add one.');
    expect(adminAskLine([{ role: 'member', user: { name: 'Mia' } }])).toBe('Only admins can add packs. Ask a workspace admin to add one.');
  });
});

describe('renamedAfterInstall (#1094)', () => {
  it('renames a space that is still exactly "Untitled space" to the pack\'s space name', () => {
    expect(renamedAfterInstall('Untitled space', 'Product')).toBe('Product');
  });
  // The rejections: a space someone named is never renamed. Exact string match, nothing cleverer.
  it('NEVER renames a space someone named, however close to the default', () => {
    for (const name of ['Marketing', 'Untitled space 2', 'untitled space', 'Untitled space ', 'My Untitled space', '']) {
      expect(renamedAfterInstall(name, 'Product')).toBeNull();
    }
  });
  it('keeps the name when the pack names no single space', () => {
    expect(renamedAfterInstall('Untitled space', null)).toBeNull();
    expect(renamedAfterInstall('Untitled space', '   ')).toBeNull();
  });
});

describe('rename after install: wiring (#1094)', () => {
  const dialog = readFileSync(join(__dirname, '../components/pack-install-dialog.tsx'), 'utf8');
  const mutationFn = dialog.slice(dialog.indexOf('const install = useMutation'), dialog.indexOf('onSuccess: (data) => {'));
  const onSuccess = dialog.slice(dialog.indexOf('onSuccess: (data) => {'), dialog.indexOf('// With a target space the server'));
  const onError = dialog.slice(dialog.indexOf('// With a target space the server'), dialog.indexOf('// #569 — a reuse-only row'));
  it('renames only in onSuccess, through the ordinary space rename, never in the request or on a failed install', () => {
    expect(onSuccess).toContain('renamedAfterInstall(target.name');
    expect(onSuccess).toContain('updateSpace.mutate(');
    expect(mutationFn).not.toContain('updateSpace');
    expect(onError).not.toContain('updateSpace');
  });
  it('a failed rename is a toast and never fails the install', () => {
    expect(onSuccess).toMatch(/onError: \(e\) => toast\.error\(/);
    expect(onSuccess.indexOf('updateSpace.mutate(')).toBeLessThan(onSuccess.indexOf('setResult(data)'));
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

  it('sends the target space on EVERY request: the preview, the what-if preview (#1149) and the install, so none can disagree', () => {
    expect(dialog.match(/target_space_id: target\.id/g)?.length).toBe(3);
  });
  it('shows the server refusal text verbatim, not a generic error (the 409 names the database and the space)', () => {
    expect(dialog).toContain("apiErrorMessage(preview.error, 'This pack cannot be installed into this space.')");
    // #1149: a refused reuse (422) says why in its own words too, so the condition also covers a reuse the person picked.
    expect(dialog).toContain('target || Object.keys(picked).length > 0');
    expect(dialog).toContain('? apiErrorMessage(e,');
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
  it('New space is ONE click: no name dialog, "Untitled space", marked for edit mode, then opened', () => {
    expect(sidebar).toMatch(/createSpace\.mutate\(\s*(?:\/\/[^\n]*\n\s*)?\{ name: UNTITLED_SPACE, color: /);
    expect(sidebar).toMatch(/markNewSpace\(created\.id\);\s*router\.push\(`\/w\/\$\{ws\}\/s\/\$\{created\.id\}`\)/);
    const button = sidebar.slice(sidebar.indexOf('function NewSpaceButton('), sidebar.indexOf('export function NewDatabaseDialog'));
    expect(button).not.toMatch(/Dialog/);
    // the only creator of a space in the web app
    expect(sidebar.match(/createSpace\.mutate\(/g)?.length).toBe(1);
  });
  it('the space page consumes the one-shot mark and puts the name in edit mode, selected', () => {
    expect(page).toContain('consumeNewSpace(spaceId)');
    expect(page).toMatch(/nameRef\.current\?\.focus\(\);\s*nameRef\.current\?\.select\(\);/);
  });
  it('draws the space mark with the sidebar LetterMark, and a lock on a restricted database only, via showsLock', () => {
    expect(page).toContain('<LetterMark');
    expect(page).toContain('{showsLock(d) && <RestrictedLock />}');
    // the sidebar draws its locks through the same component, so the two cannot differ
    expect(sidebar).toContain('{showsLock(space) && <RestrictedLock />}');
    expect(sidebar).toContain('{showsLock(db) && <RestrictedLock />}');
  });
  it('tells a member who can add a pack, from the members list it already reads', () => {
    expect(page).toContain('adminAskLine(members.data)');
  });
});
