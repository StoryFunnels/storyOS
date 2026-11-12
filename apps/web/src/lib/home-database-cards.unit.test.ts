import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildDatabaseCards, databaseCardLabel } from './home-database-cards';
import { databaseColor } from './entity-color';

/**
 * Ticket #1207 — every "Where to go" card drew the same generic database icon, and JCM's four
 * "Projects" and two "Epics" cards had nothing saying which space each lived in.
 */
const spaces = [
  { id: 's1', name: 'Client Work' },
  { id: 's2', name: 'Internal' },
  { id: 's3', name: 'Ops' },
];
const db = (id: string, name: string, spaceId: string, icon: string | null = null, color: string | null = null) => ({
  id,
  name,
  spaceId,
  icon,
  color,
});

describe('database cards (ticket #1207)', () => {
  it('keeps the order the list gives them', () => {
    const cards = buildDatabaseCards([db('b', 'B', 's1'), db('a', 'A', 's2'), db('c', 'C', 's1')], spaces);
    expect(cards.map((c) => c.id)).toEqual(['b', 'a', 'c']);
  });

  it('carries the database own icon and colour, untouched', () => {
    const [card] = buildDatabaseCards([db('d1', 'Projects', 's1', 'set:rocket', 'c3')], spaces);
    expect(card!.icon).toBe('set:rocket');
    expect(card!.color).toBe('c3');
  });

  it('a database with no icon or colour stays unset, so the shared glyph draws the sidebar default', () => {
    const [card] = buildDatabaseCards([db('d1', 'Projects', 's1', undefined as never, undefined as never)], spaces);
    expect(card!.icon).toBeNull();
    expect(card!.color).toBeNull();
    // the colour the sidebar would give it is a function of the id alone, never a grey
    expect(databaseColor(card!.color, card!.id)).not.toBeNull();
  });

  it('tells same-named databases apart by their space', () => {
    const cards = buildDatabaseCards(
      [db('p1', 'Projects', 's1'), db('p2', 'Projects', 's2'), db('p3', 'Projects', 's3'), db('e1', 'Epics', 's1'), db('e2', 'Epics', 's2')],
      spaces,
    );
    expect(cards.map((c) => c.spaceName)).toEqual(['Client Work', 'Internal', 'Ops', 'Client Work', 'Internal']);
    expect(new Set(cards.filter((c) => c.name === 'Projects').map((c) => c.label)).size).toBe(3);
    expect(cards[0]!.label).toBe('Projects · Client Work');
  });

  it('never names a space the viewer was not given: an unknown space leaves no space line', () => {
    const [card] = buildDatabaseCards([db('d1', 'Projects', 'someone-elses-space')], spaces);
    expect(card!.spaceName).toBeNull();
    expect(card!.label).toBe('Projects');
  });
});

describe('databaseCardLabel', () => {
  it('joins name and space with a middle dot', () => {
    expect(databaseCardLabel('Projects', 'Client Work')).toBe('Projects · Client Work');
  });
  it('keeps long names whole (truncation is the CSS job, the tooltip needs the full text)', () => {
    const long = 'A'.repeat(120);
    expect(databaseCardLabel(long, long)).toBe(`${long} · ${long}`);
  });
  it('missing, null or blank space gives just the name, never a dangling separator', () => {
    expect(databaseCardLabel('Projects', null)).toBe('Projects');
    expect(databaseCardLabel('Projects', undefined)).toBe('Projects');
    expect(databaseCardLabel('Projects', '   ')).toBe('Projects');
  });
});

describe('the home card draws the SAME glyph as the sidebar', () => {
  const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
  const home = read('../components/workspace-home-blocks.tsx');
  const sidebar = read('../components/sidebar.tsx');

  it('both surfaces render DatabaseGlyph', () => {
    expect(home).toMatch(/<DatabaseGlyph\b/);
    expect(sidebar).toMatch(/<DatabaseGlyph\b/);
  });

  it('the home card has no glyph of its own: no generic database icon, no EntityIcon, no colour logic', () => {
    expect(home).not.toMatch(/Database as DatabaseIcon|<DatabaseIcon\b|<Database\b/);
    expect(home).not.toMatch(/<EntityIcon\b/);
    expect(home).not.toMatch(/databaseColor|entityColor/);
  });

  it('the shared component carries the default, and the sidebar has no second copy of it', () => {
    const glyph = read('../components/database-glyph.tsx');
    expect(glyph).toMatch(/databaseColor\(color, id\)/);
    expect(glyph).toMatch(/fallback=\{<Database className="h-3\.5 w-3\.5" \/>\}/);
    expect(sidebar).not.toMatch(/icon=\{db\.icon\}\s+color=\{databaseColor/);
  });

  it('the space name sits on the right of the row, in the muted text token, truncated not wrapped (ticket #1274)', () => {
    expect(home).toMatch(/shrink-0 truncate text-label text-muted">\{d\.spaceName\}/);
  });
});
