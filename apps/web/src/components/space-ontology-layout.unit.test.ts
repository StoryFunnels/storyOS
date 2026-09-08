import { describe, expect, it } from 'vitest';
import { buildOntologyView, pickCentre, AXIS_ORDER } from './space-ontology-layout';
import type { OntologyDatabase, OntologyRelation } from './space-ontology';

/**
 * #636 — the property that matters is DETERMINISM.
 *
 * Ievgen decided placement encodes nothing: it is balance only. The risk in
 * that answer is jitter — if "whichever axis has room" is decided by anything
 * other than the data, the diagram rearranges itself between visits and after
 * unrelated edits, and a user cannot build a mental map of their own schema.
 *
 * So these tests are mostly about the same input producing the same picture,
 * including when the server hands the relations back in a different order.
 */

const SPACE = 'space-current';
const names = new Map<string, string>([
  [SPACE, 'Client Work'],
  ['space-b', 'Content Marketing'],
  ['space-c', 'Astro Collections'],
]);

const centre: OntologyDatabase = { id: 'db-centre', name: 'Articles', icon: null, color: null };

let seq = 0;
function rel(farDb: string, farName: string, farSpace: string | null): OntologyRelation {
  seq += 1;
  return {
    id: `rel-${seq}`,
    cardinality: 'one_to_many',
    self_relation: false,
    a: {
      database_id: centre.id,
      database_name: 'Articles',
      space_id: SPACE,
      field_id: `field-local-${seq}`,
      field_name: 'Parent',
    },
    b: {
      database_id: farDb,
      database_name: farName,
      space_id: farSpace,
      field_id: `field-far-${seq}`,
      field_name: 'Sub-items',
    },
  };
}

describe('#636 — balance is a pure function of the data', () => {
  it('puts the same input in the same place, whatever order the relations arrive in', () => {
    const rels = [
      rel('db-1', 'Sections', 'space-b'),
      rel('db-2', 'Blocks', 'space-b'),
      rel('db-3', 'Campaigns', 'space-c'),
      rel('db-4', 'Contacts', SPACE),
    ];
    const forward = buildOntologyView(centre, rels, names, SPACE);
    const reversed = buildOntologyView(centre, [...rels].reverse(), names, SPACE);
    const shuffled = buildOntologyView(
      centre,
      [rels[2]!, rels[0]!, rels[3]!, rels[1]!],
      names,
      SPACE,
    );

    const shape = (v: ReturnType<typeof buildOntologyView>) =>
      AXIS_ORDER.map((a) =>
        v.axes[a].map((g) => `${g.spaceName}:${g.chips.map((c) => c.name).join(',')}`),
      );

    expect(shape(reversed)).toEqual(shape(forward));
    expect(shape(shuffled)).toEqual(shape(forward));
  });

  it('sends the largest group to `down` — vertical lists grow, horizontal ones hit the edge', () => {
    const rels = [
      rel('db-1', 'A', 'space-b'),
      rel('db-2', 'B', 'space-b'),
      rel('db-3', 'C', 'space-b'),
      rel('db-4', 'D', 'space-c'),
    ];
    const v = buildOntologyView(centre, rels, names, SPACE);
    expect(v.axes.down[0]?.chips).toHaveLength(3);
  });

  it('spreads groups across axes rather than stacking them all on one', () => {
    const rels = [
      rel('db-1', 'A', 'space-b'),
      rel('db-2', 'B', 'space-c'),
      rel('db-3', 'C', SPACE),
      rel('db-4', 'D', null),
    ];
    const v = buildOntologyView(centre, rels, names, SPACE);
    const used = AXIS_ORDER.filter((a) => v.axes[a].length > 0);
    expect(used).toHaveLength(4);
  });

  it('stays legible at the reference scale — ~30 chips over 8 groups', () => {
    const rels: OntologyRelation[] = [];
    for (let g = 0; g < 8; g++) {
      names.set(`space-${g}`, `Space ${g}`);
      for (let i = 0; i < 4; i++) rels.push(rel(`db-${g}-${i}`, `Db ${g}-${i}`, `space-${g}`));
    }
    const v = buildOntologyView(centre, rels, names, SPACE);
    expect(v.totalChips).toBe(32);
    const loads = AXIS_ORDER.map((a) => v.axes[a].reduce((n, g) => n + g.chips.length, 0));
    // 8 equal groups over 4 axes: every axis carries the same load. A layout
    // that piled them up would show here.
    expect(Math.max(...loads) - Math.min(...loads)).toBe(0);
  });
});

describe('#636 — what a chip carries', () => {
  it('keeps the LOCAL side field id, so #497 deep-linking survives the redesign', () => {
    const r = rel('db-1', 'Sections', 'space-b');
    const v = buildOntologyView(centre, [r], names, SPACE);
    const chip = v.axes.down[0]!.chips[0]!;
    // side A is the centre here, so the local field is A's — the column the
    // chevron must open, not the far database's own field.
    expect(chip.fieldId).toBe(r.a.field_id);
    expect(chip.databaseId).toBe('db-1');
  });

  it('reads the local side correctly when the centre is side B', () => {
    const r = rel('db-1', 'Sections', 'space-b');
    // flip it: the centre is now side B
    const flipped: OntologyRelation = { ...r, a: r.b, b: r.a };
    const v = buildOntologyView(centre, [flipped], names, SPACE);
    const chip = v.axes.down[0]!.chips[0]!;
    expect(chip.fieldId).toBe(flipped.b.field_id);
    expect(chip.databaseId).toBe('db-1');
  });

  it('carries both field names for the hover label, and draws nothing at rest', () => {
    const v = buildOntologyView(centre, [rel('db-1', 'Sections', 'space-b')], names, SPACE);
    const chip = v.axes.down[0]!.chips[0]!;
    expect(chip.localFieldName).toBe('Parent');
    expect(chip.farFieldName).toBe('Sub-items');
    expect(chip.cardinality).toBe('one_to_many');
  });

  it('names the current space by name, not as "another space"', () => {
    const v = buildOntologyView(centre, [rel('db-1', 'Contacts', SPACE)], names, SPACE);
    expect(v.axes.down[0]!.spaceName).toBe('Client Work');
  });

  it('falls back to a stated label rather than a bare id when a space cannot be resolved', () => {
    const v = buildOntologyView(centre, [rel('db-1', 'Thing', 'space-unknown')], names, SPACE);
    expect(v.axes.down[0]!.spaceName).toBe('Another space');
  });

  it('ignores relations that do not touch the centre', () => {
    const other = rel('db-1', 'Sections', 'space-b');
    const unrelated: OntologyRelation = {
      ...other,
      id: 'rel-unrelated',
      a: { ...other.a, database_id: 'db-x' },
      b: { ...other.b, database_id: 'db-y' },
    };
    const v = buildOntologyView(centre, [unrelated], names, SPACE);
    expect(v.totalChips).toBe(0);
  });

  it('renders a centre with no relations as an empty view rather than throwing', () => {
    const v = buildOntologyView(centre, [], names, SPACE);
    expect(v.totalChips).toBe(0);
    expect(AXIS_ORDER.every((a) => v.axes[a].length === 0)).toBe(true);
  });
});

describe('#636 — picking the centre', () => {
  const dbs: OntologyDatabase[] = [
    { id: 'db-a', name: 'Articles', icon: null, color: null },
    { id: 'db-b', name: 'Blocks', icon: null, color: null },
    { id: 'db-c', name: 'Contacts', icon: null, color: null },
  ];

  it('picks the database with the most relations', () => {
    const rels = [
      { ...rel('db-b', 'Blocks', SPACE), a: { ...rel('db-b', 'B', SPACE).a, database_id: 'db-a' } },
    ] as OntologyRelation[];
    // db-a appears on both of the two relations below, db-c on neither
    const many: OntologyRelation[] = [
      {
        ...rels[0]!,
        id: 'r1',
        a: { ...rels[0]!.a, database_id: 'db-a' },
        b: { ...rels[0]!.b, database_id: 'db-b' },
      },
      {
        ...rels[0]!,
        id: 'r2',
        a: { ...rels[0]!.a, database_id: 'db-a' },
        b: { ...rels[0]!.b, database_id: 'db-c' },
      },
    ];
    expect(pickCentre(dbs, many)?.id).toBe('db-a');
  });

  it('is stable when nothing has a relation — falls to name order, not array order', () => {
    expect(pickCentre(dbs, [])?.id).toBe('db-a');
    expect(pickCentre([...dbs].reverse(), [])?.id).toBe('db-a');
  });

  it('returns null for an empty space rather than throwing', () => {
    expect(pickCentre([], [])).toBeNull();
  });
});
