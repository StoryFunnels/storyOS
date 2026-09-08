import { describe, expect, it } from 'vitest';
import { computeLayout, estimateTextWidth } from './space-ontology';
import type { OntologyDatabase, OntologyRelation } from './space-ontology';

function db(id: string, name: string): OntologyDatabase {
  return { id, name, icon: null, color: null };
}

function side(databaseId: string, spaceId: string | null, fieldName: string): {
  database_id: string;
  database_name: string | null;
  space_id: string | null;
  field_id: string;
  field_name: string | null;
} {
  return { database_id: databaseId, database_name: null, space_id: spaceId, field_id: `${databaseId}-field`, field_name: fieldName };
}

function rel(
  id: string,
  a: ReturnType<typeof side>,
  b: ReturnType<typeof side>,
  opts: { selfRelation?: boolean } = {},
): OntologyRelation {
  return { id, cardinality: 'one_to_many', self_relation: opts.selfRelation ?? false, a, b };
}

/**
 * #528 — Vera's own reproduction: two same-space relations between the
 * identical pair (Affiliates ⇄ Contacts, "primary" and "referrer") land two
 * edge labels on the exact same pixel before the fix.
 */
describe('computeLayout — #528: two relations between the same database pair', () => {
  it('gives each edge label a distinct position', () => {
    const databases = [db('affiliates', 'Affiliates'), db('contacts', 'Contacts')];
    const relations = [
      rel('r1', side('contacts', 'space-a', 'Primary Contact'), side('affiliates', 'space-a', 'Affiliate (primary)')),
      rel('r2', side('contacts', 'space-a', 'Referrer Contact'), side('affiliates', 'space-a', 'Affiliate (referrer)')),
    ];
    const layout = computeLayout(databases, relations, 'space-a', new Map());
    expect(layout.edges).toHaveLength(2);
    const [e1, e2] = layout.edges;
    expect([e1!.labelX, e1!.labelY]).not.toEqual([e2!.labelX, e2!.labelY]);
  });

  it('places a THIRD relation between the same pair at a third distinct position', () => {
    const databases = [db('a', 'A'), db('b', 'B')];
    const relations = [
      rel('r1', side('a', 'space-a', 'One'), side('b', 'space-a', 'Uno')),
      rel('r2', side('a', 'space-a', 'Two'), side('b', 'space-a', 'Dos')),
      rel('r3', side('a', 'space-a', 'Three'), side('b', 'space-a', 'Tres')),
    ];
    const layout = computeLayout(databases, relations, 'space-a', new Map());
    const positions = layout.edges.map((e) => `${e.labelX},${e.labelY}`);
    expect(new Set(positions).size).toBe(3);
  });

  it('a single relation between a pair is UNCHANGED — still the exact midpoint', () => {
    const databases = [db('a', 'A'), db('b', 'B')];
    const relations = [rel('r1', side('a', 'space-a', 'One'), side('b', 'space-a', 'Uno'))];
    const layout = computeLayout(databases, relations, 'space-a', new Map());
    const [nodeA, nodeB] = layout.nodes;
    expect(layout.edges[0]!.labelX).toBeCloseTo((nodeA!.x + nodeB!.x) / 2, 5);
  });
});

/**
 * #528 — Vera's second reproduction: two cross-space relations from the SAME
 * local node land two satellites (and their "in {space}" labels) on the
 * identical (x, y) before the fix.
 */
describe('computeLayout — #528: two cross-space relations from the same local node', () => {
  it('gives each satellite a distinct position', () => {
    const databases = [db('affiliates', 'Affiliates')];
    const relations = [
      rel('r1', side('affiliates', 'space-a', 'Parent Company'), side('companies', 'space-b', 'Affiliates')),
      rel('r2', side('affiliates', 'space-a', 'Related Deal'), side('deals', 'space-b', 'Affiliates')),
    ];
    const spaceNameById = new Map([['space-b', 'JCM Marketing Test']]);
    const layout = computeLayout(databases, relations, 'space-a', spaceNameById);
    expect(layout.satellites).toHaveLength(2);
    const [s1, s2] = layout.satellites;
    expect([s1!.x, s1!.y]).not.toEqual([s2!.x, s2!.y]);
  });

  it('a single cross-space relation is UNCHANGED — satellite stays exactly 46px past the node, on the same ray from centre', () => {
    // With one node (n=1) and one satellite (satIndex 0, no fan applied), both
    // sit on the identical ray from the (unexported) canvas centre, at radius
    // and radius+46 respectively — so their separation is exactly 46px,
    // regardless of the global shift computeLayout applies afterward
    // (a translation preserves distances between two shifted points).
    const databases = [db('affiliates', 'Affiliates')];
    const relations = [rel('r1', side('affiliates', 'space-a', 'Parent Company'), side('companies', 'space-b', 'Affiliates'))];
    const layout = computeLayout(databases, relations, 'space-a', new Map([['space-b', 'Marketing']]));
    const node = layout.nodes[0]!;
    const satellite = layout.satellites[0]!;
    expect(Math.hypot(satellite.x - node.x, satellite.y - node.y)).toBeCloseTo(46, 5);
  });
});

/**
 * #528 — a self-relation loop (already fanned by loopIndexByNode) is
 * untouched by this fix; guards against the new pairIndexByKey/
 * satelliteIndexByNode logic accidentally intercepting the self-relation
 * branch, which returns (`continue`) before either new counter is read.
 */
/**
 * #607 — Vera's finding: #528's fan-out fixed identical-pixel stacking, but
 * used a FIXED step regardless of the labels' actual rendered width, so
 * realistic (multi-word) field names still overlapped by ~85% of their own
 * width. Same field names as the ticket's own live repro ("Rel One / Rel One
 * Back", "Rel Two / Rel Two Back").
 */
describe('computeLayout — #607: fan-out scales with label width, not a fixed step', () => {
  it('two same-pair edges with realistic field names get labels that do not overlap', () => {
    const databases = [db('a', 'A'), db('b', 'B')];
    const relations = [
      rel('r1', side('a', 'space-a', 'Rel One'), side('b', 'space-a', 'Rel One Back')),
      rel('r2', side('a', 'space-a', 'Rel Two'), side('b', 'space-a', 'Rel Two Back')),
    ];
    const layout = computeLayout(databases, relations, 'space-a', new Map());
    const [e1, e2] = layout.edges;
    const dist = Math.hypot(e2!.labelX - e1!.labelX, e2!.labelY - e1!.labelY);
    // Each label's own width (both are drawn at the SAME 9px shortLabel size),
    // centered on its anchor — two anchors must be at least one full label
    // width apart (half of each) for the text to clear, not just the anchor.
    const width1 = estimateTextWidth(e1!.shortLabel, 9);
    const width2 = estimateTextWidth(e2!.shortLabel, 9);
    expect(dist).toBeGreaterThanOrEqual((width1 + width2) / 2);
    // #528 MUST KEEP WORKING: anchors stay genuinely distinct, not just
    // adequately spaced text sharing a point.
    expect(dist).toBeGreaterThan(0);
  });

  it('a fixed-step spacing (the pre-#607 constant) would NOT have cleared these labels — proves the test is a real regression guard', () => {
    // Sanity check on the test itself: the old 14px constant genuinely fails
    // this bar for these realistic names, so the assertion above is not
    // trivially satisfied by any spacing at all.
    const shortLabel = 'Rel One / Rel One Back';
    const width = estimateTextWidth(shortLabel, 9);
    expect(14).toBeLessThan(width);
  });

  it('two cross-space satellites from the same local node, with realistic long names, get labels that do not overlap', () => {
    const databases = [db('affiliates', 'Affiliates')];
    const relations = [
      rel(
        'r1',
        side('affiliates', 'space-a', 'Related Deal One'),
        side('deals-one', 'space-b', 'Affiliate'),
      ),
      rel(
        'r2',
        side('affiliates', 'space-a', 'Related Deal Two'),
        side('deals-two', 'space-b', 'Affiliate'),
      ),
    ];
    const layout = computeLayout(
      databases,
      relations,
      'space-a',
      new Map([['space-b', 'A Fairly Long Space Name']]),
    );
    const [s1, s2] = layout.satellites;
    const dist = Math.hypot(s2!.x - s1!.x, s2!.y - s1!.y);
    const width1 = Math.max(
      estimateTextWidth(s1!.name, 9),
      estimateTextWidth(`in ${s1!.spaceName}`, 8),
    );
    const width2 = Math.max(
      estimateTextWidth(s2!.name, 9),
      estimateTextWidth(`in ${s2!.spaceName}`, 8),
    );
    expect(dist).toBeGreaterThanOrEqual((width1 + width2) / 2);
  });
});

describe('computeLayout — #528 regression: self-relations still use their own fan-out', () => {
  it('two self-relation loops on one node still get distinct label positions', () => {
    const databases = [db('issues', 'Issues')];
    const relations = [
      rel('r1', side('issues', 'space-a', 'Parent task'), side('issues', 'space-a', 'Sub-tasks'), { selfRelation: true }),
      rel('r2', side('issues', 'space-a', 'Blocked by'), side('issues', 'space-a', 'Blocks'), { selfRelation: true }),
    ];
    const layout = computeLayout(databases, relations, 'space-a', new Map());
    const [e1, e2] = layout.edges;
    expect([e1!.labelX, e1!.labelY]).not.toEqual([e2!.labelX, e2!.labelY]);
  });
});

/**
 * #497 — a relation edge carries the LOCAL side's field id so a click can
 * deep-link to that relation's own column (`?field={id}`), not just the
 * local database. Covers all three edge shapes computeLayout produces.
 */
describe('computeLayout — #497: edges carry the local side field id for deep-linking', () => {
  it('a same-space line edge uses side A\'s field id (the local side by convention)', () => {
    const databases = [db('a', 'A'), db('b', 'B')];
    const relations = [rel('r1', side('a', 'space-a', 'Owner'), side('b', 'space-a', 'Owned by'))];
    const layout = computeLayout(databases, relations, 'space-a', new Map());
    expect(layout.edges).toHaveLength(1);
    expect(layout.edges[0]!.localFieldId).toBe('a-field');
    expect(layout.edges[0]!.localDatabaseId).toBe('a');
  });

  it('a cross-space line edge uses the LOCAL side\'s field id, whichever side that is', () => {
    const databases = [db('a', 'A')];
    // Only "a" is in this space's database list — "b" is the far side.
    const relations = [rel('r1', side('b', 'space-b', 'Far field'), side('a', 'space-a', 'Local field'))];
    const layout = computeLayout(databases, relations, 'space-a', new Map());
    expect(layout.edges).toHaveLength(1);
    expect(layout.edges[0]!.localFieldId).toBe('a-field');
    expect(layout.edges[0]!.localDatabaseId).toBe('a');
  });

  it('a self-relation loop uses side A\'s field id', () => {
    const databases = [db('issues', 'Issues')];
    const relations = [
      rel('r1', side('issues', 'space-a', 'Parent'), side('issues', 'space-a', 'Sub-items'), { selfRelation: true }),
    ];
    const layout = computeLayout(databases, relations, 'space-a', new Map());
    expect(layout.edges).toHaveLength(1);
    expect(layout.edges[0]!.localFieldId).toBe('issues-field');
  });
});
