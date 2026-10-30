import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  REUSE_COPY,
  andList,
  existingChoices,
  mapRows,
  reusedNames,
  reuseNote,
  reuseResolutions,
  reviewLead,
  type ExistingElsewhere,
  type PackRelation,
} from './pack-review';

const rel = (from: string, to: string, cardinality: PackRelation['cardinality'] = 'one_to_many', from_field = 'x'): PackRelation => ({ from, to, cardinality, from_field, to_field: 'y' });
const here = (p: string) => readFileSync(join(__dirname, p), 'utf8');

describe('reviewLead (#1149 — a pack with no copy shows nothing)', () => {
  it('a null why draws no sentence, and with no can lines draws NOTHING at all', () => {
    expect(reviewLead({ why: null, can: [] })).toEqual({ why: null, can: [], show: false });
    expect(reviewLead({})).toEqual({ why: null, can: [], show: false });
    expect(reviewLead({ why: '   ', can: ['', '  '] }).show).toBe(false);
  });
  it('keeps what exists: a why alone, or can lines alone, each still show', () => {
    expect(reviewLead({ why: 'You run client work.', can: [] })).toEqual({ why: 'You run client work.', can: [], show: true });
    const canOnly = reviewLead({ why: null, can: ['See every client'] });
    expect(canOnly.why).toBeNull();
    expect(canOnly.can).toEqual(['See every client']);
    expect(canOnly.show).toBe(true);
  });
});

describe('mapRows (#1149 — drawn from the API relations, nothing hard-coded)', () => {
  it('draws one row per link, the arrow pointing from the record that holds the link', () => {
    expect(mapRows([rel('Tasks', 'Projects'), rel('Contacts', 'Clients')], 4)).toEqual([
      { kind: 'link', from: 'Tasks', op: '→', to: 'Projects' },
      { kind: 'link', from: 'Contacts', op: '→', to: 'Clients' },
    ]);
  });
  it('a many-to-many link is two-way; a self-relation is a loop named by its field', () => {
    const rows = mapRows([rel('Articles', 'Topics', 'many_to_many'), rel('Tasks', 'Tasks', 'one_to_many', 'Parent task')], 3);
    expect(rows[0]).toEqual({ kind: 'link', from: 'Articles', op: '↔', to: 'Topics' });
    expect(rows[1]).toEqual({ kind: 'self', name: 'Tasks', via: 'parent task' });
  });
  it('says how many databases have no link, without inventing their names', () => {
    const rows = mapRows([rel('Tasks', 'Projects')], 4);
    expect(rows[rows.length - 1]).toEqual({ kind: 'note', text: '+2 more databases' });
    expect(mapRows([rel('Tasks', 'Projects')], 3).pop()).toEqual({ kind: 'note', text: '+1 more database' });
    expect(mapRows([rel('Tasks', 'Projects')], 2).some((r) => r.kind === 'note')).toBe(false);
  });
  it('a pack with no relations: one database is named if known, several are only counted, none draws nothing', () => {
    expect(mapRows([], 1, { soleDatabase: 'Tickets' })).toEqual([{ kind: 'solo', name: 'Tickets' }, { kind: 'note', text: 'One database, no links' }]);
    expect(mapRows(undefined, 1)).toEqual([{ kind: 'note', text: 'One database, no links' }]);
    expect(mapRows([], 3)).toEqual([{ kind: 'note', text: '3 databases, no links' }]);
    expect(mapRows([], 0)).toEqual([]);
    expect(mapRows(null, 0)).toEqual([]);
  });
  it('a limit says how many links it left out instead of dropping them silently', () => {
    const rows = mapRows([rel('A', 'B'), rel('B', 'C'), rel('C', 'D'), rel('D', 'E')], 5, { limit: 2 });
    expect(rows.filter((r) => r.kind === 'link')).toHaveLength(2);
    expect(rows).toContainEqual({ kind: 'note', text: '+2 more links' });
  });
  it('does not draw the same link twice', () => {
    expect(mapRows([rel('A', 'B'), rel('A', 'B')], 2).filter((r) => r.kind === 'link')).toHaveLength(1);
  });
});

const reusable: ExistingElsewhere = { database_id: 'db-1', space_name: 'Agency OS', adopted: false, reusable: true };
const blocked: ExistingElsewhere = { database_id: 'db-2', space_name: 'Client Work', adopted: false, reusable: false, reason: 'Status is a select here but this pack needs a workflow.' };
const ambiguous: ExistingElsewhere = { adopted: false, reusable: false, reason: "Can't use one: you have more than one Clients database (in A and B). Create a new one here." };

describe('the existing_elsewhere choice (#1149 AC4)', () => {
  const dbs = [
    { name: 'Clients', existing_elsewhere: reusable },
    { name: 'Proposals' },
    { name: 'Contacts', existing_elsewhere: blocked },
    { name: 'Projects', existing_elsewhere: { ...reusable, adopted: true } },
  ];

  it('offers a choice for exactly the databases that carry the hint, and not for one an earlier install already adopted', () => {
    expect(existingChoices(dbs).map((c) => c.name)).toEqual(['Clients', 'Contacts']);
    expect(existingChoices([{ name: 'Proposals' }])).toEqual([]);
  });

  it('DEFAULT is create new: with nothing chosen no reuse resolution is sent', () => {
    const choices = existingChoices(dbs);
    expect(reuseResolutions(choices, {})).toEqual({});
    expect(reusedNames(choices, {})).toEqual([]);
    expect(reuseNote([])).toBeNull();
  });

  it('choosing "use existing" sends resolutions: reuse for that database only', () => {
    const choices = existingChoices(dbs);
    expect(reuseResolutions(choices, { Clients: true })).toEqual({ Clients: { action: 'reuse' } });
    // an explicit "create new" is the same as the default
    expect(reuseResolutions(choices, { Clients: false })).toEqual({});
  });

  it('a disabled (non-reusable) choice can never be sent, whatever the state says', () => {
    const choices = existingChoices([
      { name: 'Contacts', existing_elsewhere: blocked },
      { name: 'Clients', existing_elsewhere: ambiguous },
    ]);
    expect(reuseResolutions(choices, { Contacts: true, Clients: true })).toEqual({});
  });

  it('is per database', () => {
    const choices = existingChoices([
      { name: 'Clients', existing_elsewhere: reusable },
      { name: 'Contacts', existing_elsewhere: { ...reusable, database_id: 'db-9' } },
    ]);
    expect(reuseResolutions(choices, { Contacts: true })).toEqual({ Contacts: { action: 'reuse' } });
  });

  it('the bottom note names what is reused', () => {
    expect(reuseNote(['Clients'])).toBe('Uses your existing Clients from another space. Everything else is new, and nothing you have is removed.');
    expect(reuseNote(['Clients', 'Contacts'])).toContain('Clients and Contacts');
    expect(andList(['A', 'B', 'C'])).toBe('A, B and C');
  });

  it("uses Dara's wording (ticket #1149)", () => {
    expect(REUSE_COPY.heading('Clients')).toBe('You already have a Clients database in another space.');
    expect(REUSE_COPY.createTitle('Clients')).toBe('Create a new Clients here');
    expect(REUSE_COPY.createSub('Empty space')).toBe('Empty, in Empty space, with the fields this pack needs.');
    expect(REUSE_COPY.useTitle('Clients', 'Agency OS')).toBe('Use your existing Clients (in Agency OS)');
    // two matches: the card's title drops "(in <space>)" — there isn't one space to name
    expect(REUSE_COPY.useTitle('Clients', undefined)).toBe('Use your existing Clients');
    expect(REUSE_COPY.existingSub({ noun: 'client', count: 11, space: 'Empty space', its: 'Client Work', adds: [] })).toBe(
      "Your 11 clients stay where they are, and Empty space links to them. It already has every field this pack needs. Nothing in it is removed or renamed. People who can't open Client Work won't see these clients here.",
    );
    expect(REUSE_COPY.existingSub({ noun: 'client', count: 1, space: 'S', its: 'W', adds: ['Owner', 'Industry'] })).toContain('Your 1 client stays where it is, and S links to it. Adds Owner, Industry.');
  });

  it('claims no number and no fields line it does not have', () => {
    const s = REUSE_COPY.existingSub({ noun: 'client', count: null, space: 'S', its: 'W', adds: null });
    expect(s.startsWith('Your clients stay where they are')).toBe(true);
    expect(s).not.toContain('Adds');
    expect(s).not.toContain('every field');
  });
});

describe('source guards — the wiring the pure functions cannot see', () => {
  const dialog = here('../components/pack-install-dialog.tsx');
  it('the install request carries the picked reuse resolutions, and nothing is picked by default', () => {
    expect(dialog).toMatch(/resolutions: \{ \.\.\.payload, \.\.\.agentResolutions\([^)]*\), \.\.\.picked \}/);
    expect(dialog).toMatch(/useState<ReuseSelection>\(\{\}\)/);
  });
  it('the review leads with why, then the map, then the hero; each is skipped for a pack that has none', () => {
    const why = dialog.indexOf('<PackWhy source={card} />');
    const map = dialog.indexOf('<PackMap');
    const visual = dialog.indexOf('<PackVisual pack={card} />');
    expect(why).toBeGreaterThan(0);
    expect(map).toBeGreaterThan(why);
    expect(visual).toBeGreaterThan(map);
  });
  it('the pack card on the space page draws the map from the listing', () => {
    const grid = here('../components/space-start.tsx');
    expect(grid).toContain('pack.why ?? pack.summary');
    expect(grid).toContain('<PackMap slug={pack.slug} relations={pack.relations}');
  });
  it('the choice shows a refused reuse with the server reason, verbatim', () => {
    const c = here('../components/pack-review.tsx');
    expect(c).toContain('hint.reason');
    expect(c).toContain('disabled={!usable}');
  });
});
