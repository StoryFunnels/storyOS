import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DatabaseRelationsDiagram } from './database-relations-diagram';
import { computeSpokeLayout, overlapArea, truncate } from './database-relations-layout';
import type { OntologyRelation } from './space-ontology';

/**
 * Ticket #1259 — labels on the per-database relations map were unreadable in
 * dark mode and overlapped once a database had ~8 neighbours. The overlap
 * property is asserted on the layout (pure geometry); the colour property on
 * the rendered markup, because the defect there was a CSS variable that did not
 * exist and nothing failed to compile.
 */

const CENTRE = { id: 'db-c', name: 'Accounts', icon: null, color: null };
let seq = 0;
function rel(farId: string, farName: string, local = 'Account manager', far = 'Accounts'): OntologyRelation {
  seq += 1;
  return {
    id: `r${seq}`,
    cardinality: 'one_to_many',
    self_relation: false,
    a: { database_id: CENTRE.id, database_name: 'Accounts', space_id: 's', field_id: `fa${seq}`, field_name: local },
    b: { database_id: farId, database_name: farName, space_id: 's', field_id: `fb${seq}`, field_name: far },
  };
}

const EIGHT = [
  'Pinewood Contacts',
  'Pinewood Opportunities',
  'Pinewood Contracts',
  'Pinewood Invoices',
  'Pinewood Support Tickets',
  'Pinewood Renewals',
  'Pinewood Products',
  'Pinewood Campaigns',
].map((n, i) => rel(`db-${i}`, n, `Linked ${n.split(' ')[1]}`, 'Account manager'));

function allBoxes(l: ReturnType<typeof computeSpokeLayout>) {
  const labels = l.spokes.flatMap((s) => s.edges.map((e) => ({ what: `label ${e.text}`, box: e.box })));
  const names = l.spokes.map((s) => ({ what: `name ${s.nameText}`, box: s.nameBox }));
  // obstacles also holds every node-name box (already in `names`); keep only the
  // node discs and the centre so a name is not compared against itself.
  const nameKeys = new Set(l.spokes.map((s) => JSON.stringify(s.nameBox)));
  const others = l.obstacles
    .filter((b) => !nameKeys.has(JSON.stringify(b)))
    .map((box, i) => ({ what: `obstacle ${i}`, box }));
  return { labels, names, others };
}

describe('computeSpokeLayout — nothing drawn as text overlaps', () => {
  for (const n of [2, 5, 8, 12]) {
    it(`${n} related databases with long names: no label touches another label, name or node`, () => {
      const l = computeSpokeLayout(CENTRE, EIGHT.slice(0, Math.min(n, 8)).concat(
        Array.from({ length: Math.max(0, n - 8) }, (_, i) => rel(`x-${i}`, `Extra database number ${i}`)),
      ));
      const { labels, names, others } = allBoxes(l);
      const text = [...labels, ...names];
      for (let i = 0; i < text.length; i++) {
        for (let j = i + 1; j < text.length; j++) {
          expect(overlapArea(text[i]!.box, text[j]!.box), `${text[i]!.what} vs ${text[j]!.what}`).toBe(0);
        }
        for (const o of others) expect(overlapArea(text[i]!.box, o.box), `${text[i]!.what} vs ${o.what}`).toBe(0);
      }
    });
  }

  it('every drawn box sits inside the SVG viewBox', () => {
    const l = computeSpokeLayout(CENTRE, EIGHT);
    const { labels, names } = allBoxes(l);
    for (const { what, box } of [...labels, ...names]) {
      expect(box.x0, what).toBeGreaterThanOrEqual(0);
      expect(box.y0, what).toBeGreaterThanOrEqual(0);
      expect(box.x1, what).toBeLessThanOrEqual(l.width);
      expect(box.y1, what).toBeLessThanOrEqual(l.height);
    }
  });

  it('KEEPS every relation: several relations to one far database each keep their own label', () => {
    const l = computeSpokeLayout(CENTRE, [rel('db-1', 'Deals', 'Owner', 'Deals'), rel('db-1', 'Deals', 'Backup owner', 'Deals'), rel('db-2', 'Tasks')]);
    expect(l.spokes).toHaveLength(2);
    expect(l.spokes[0]!.edges.map((e) => e.shortLabel)).toEqual(['Owner / Deals', 'Backup owner / Deals']);
    const [a, b] = l.spokes[0]!.edges;
    expect(overlapArea(a!.box, b!.box)).toBe(0);
  });

  it('KEEPS self-relations out of the ring, and the full text in the hover title', () => {
    const self: OntologyRelation = { ...rel('db-c', 'Accounts'), self_relation: true };
    expect(computeSpokeLayout(CENTRE, [self]).spokes).toHaveLength(0);
    const l = computeSpokeLayout(CENTRE, [rel('db-1', 'A very long related database name indeed', 'A rather long local field name', 'Another long field')]);
    expect(l.spokes[0]!.edges[0]!.text.endsWith('…')).toBe(true);
    expect(l.spokes[0]!.edges[0]!.label).toContain('A rather long local field name');
    expect(truncate('short', 24)).toBe('short');
  });

  it('is deterministic', () => {
    expect(computeSpokeLayout(CENTRE, EIGHT)).toEqual(computeSpokeLayout(CENTRE, EIGHT));
  });
});

describe('DatabaseRelationsDiagram — colours come from theme tokens', () => {
  const html = renderToStaticMarkup(
    createElement(DatabaseRelationsDiagram, { center: CENTRE, relations: EIGHT, onOpenDatabase: () => {} }),
  );

  it('never references the undefined --ink / --muted / --card variables (they fell back to black in dark mode)', () => {
    expect(html).not.toMatch(/var\(--(ink|muted|card)\)/);
  });

  it('paints names, edge labels and node discs through theme utilities', () => {
    expect(html).toContain('fill-ink');
    expect(html).toContain('fill-muted');
    expect(html).toContain('fill-card');
    expect(html).not.toMatch(/#[0-9a-fA-F]{3,8}/);
  });

  it('draws one label per relation', () => {
    expect((html.match(/pointer-events-none fill-muted/g) ?? []).length).toBe(EIGHT.length);
  });
});
