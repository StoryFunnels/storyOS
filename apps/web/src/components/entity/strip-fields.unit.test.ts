import { describe, expect, it } from 'vitest';
import type { Field } from '@/components/table-view/use-table-data';
import { canPinToStrip, gridFieldsExcludingStrip, stripFields, stripPlan, zonesWithTop } from './strip-fields';

const f = (id: string, type: string, zones?: string[]): Field =>
  ({ id, apiName: id, displayName: id, type, config: zones ? { entity_zones: zones } : {} }) as unknown as Field;

const state = f('state', 'workflow');
const owner = f('owner', 'user');
const due = f('due', 'date');
const created = f('created', 'date');
const note = f('note', 'text');
const all = [state, owner, due, created, note];

describe('stripFields (ticket #809)', () => {
  it('UNCONFIGURED: keeps exactly today’s type heuristic (no silent reshuffle)', () => {
    const sel = stripFields({ topFields: [], visibleFields: all, unifiedFields: all });
    expect(sel.configured).toBe(false);
    expect(sel.fields.map((x) => x.id)).toEqual(['state', 'owner', 'due']);
  });
  it('the heuristic picks the FIRST date, which is the guess this ticket exists to replace', () => {
    const sel = stripFields({ topFields: [], visibleFields: [created, due], unifiedFields: [created, due] });
    expect(sel.fields.map((x) => x.id)).toEqual(['created']);
  });
  it('CONFIGURED: shows exactly the fields stored in the top zone, in the order given', () => {
    const top = [f('note', 'text', ['top', 'sidebar']), f('due', 'date', ['top'])];
    const sel = stripFields({ topFields: top, visibleFields: all, unifiedFields: all });
    expect(sel.configured).toBe(true);
    expect(sel.fields.map((x) => x.id)).toEqual(['note', 'due']);
  });
  it('an unconfigured database with none of the heuristic types shows nothing', () => {
    expect(stripFields({ topFields: [], visibleFields: [note], unifiedFields: [note] }).fields).toEqual([]);
  });
});

describe('zonesWithTop', () => {
  it('adds top to a sidebar field and keeps its other zones', () => {
    expect(zonesWithTop(note, true)).toEqual(['top', 'sidebar']);
  });
  it('removing top returns the field to the sidebar, and never hides it', () => {
    expect(zonesWithTop(f('x', 'text', ['top']), false)).toEqual(['sidebar']);
    expect(zonesWithTop(f('x', 'text', ['top', 'body']), false)).toEqual(['body']);
  });
});

describe('stripPlan', () => {
  it('first change on an AUTOMATIC row materialises what is shown, then adds the pick', () => {
    const current = stripFields({ topFields: [], visibleFields: all, unifiedFields: all });
    const writes = stripPlan({ current, field: note, on: true });
    expect(writes.map((w) => w.field.id).sort()).toEqual(['due', 'note', 'owner', 'state']);
    expect(writes.every((w) => w.zones.includes('top'))).toBe(true);
  });
  it('removing a chip from an AUTOMATIC row pins the OTHERS and leaves the removed one out', () => {
    const current = stripFields({ topFields: [], visibleFields: all, unifiedFields: all });
    const writes = stripPlan({ current, field: owner, on: false });
    expect(writes.map((w) => w.field.id).sort()).toEqual(['due', 'state']);
  });
  it('on a CONFIGURED row only the changed field is written', () => {
    const top = [f('state', 'workflow', ['top']), f('due', 'date', ['top'])];
    const current = stripFields({ topFields: top, visibleFields: all, unifiedFields: all });
    expect(stripPlan({ current, field: note, on: true }).map((w) => w.field.id)).toEqual(['note']);
    const off = stripPlan({ current, field: top[1]!, on: false });
    expect(off.map((w) => [w.field.id, w.zones])).toEqual([['due', ['sidebar']]]);
  });
  it('is idempotent for a field already in the row', () => {
    const top = [f('state', 'workflow', ['top'])];
    const current = stripFields({ topFields: top, visibleFields: all, unifiedFields: all });
    expect(stripPlan({ current, field: top[0]!, on: true })).toEqual([]);
  });
});

describe('canPinToStrip', () => {
  it('refuses body-locked fields', () => {
    expect(canPinToStrip(f('r', 'rich_text'))).toBe(false);
    expect(canPinToStrip(note)).toBe(true);
  });
});

describe('gridFieldsExcludingStrip (ticket #937)', () => {
  const sidebarField = (id: string, type: string, zones: string[]) => f(id, type, zones);
  const status = sidebarField('status', 'workflow', ['sidebar', 'top']);
  const priority = sidebarField('priority', 'select', ['sidebar', 'top']);
  const notes = sidebarField('notes', 'text', ['sidebar']);
  const epic = sidebarField('epic', 'relation', ['sidebar', 'top']);
  const unified = [status, priority, notes, epic];

  it('a field in the row under the title is not repeated in the grid, and the rest stay', () => {
    const strip = stripFields({ topFields: [status, priority, epic], visibleFields: unified, unifiedFields: unified });
    expect(gridFieldsExcludingStrip(unified, strip).map((x) => x.id)).toEqual(['notes']);
  });

  it('unpinning puts the field back in the grid (the row is what the grid is measured against)', () => {
    const before = stripFields({ topFields: [status, priority], visibleFields: unified, unifiedFields: unified });
    expect(gridFieldsExcludingStrip(unified, before).map((x) => x.id)).toEqual(['notes', 'epic']);
    const after = stripFields({ topFields: [status], visibleFields: unified, unifiedFields: unified });
    expect(gridFieldsExcludingStrip(unified, after).map((x) => x.id)).toEqual(['priority', 'notes', 'epic']);
  });

  it('the automatic (heuristic) row also is not repeated: what the row shows, the grid does not', () => {
    const plain = [f('s', 'workflow'), f('o', 'user'), f('d', 'date'), f('t', 'text')];
    const strip = stripFields({ topFields: [], visibleFields: plain, unifiedFields: plain });
    expect(strip.configured).toBe(false);
    expect(gridFieldsExcludingStrip(plain, strip).map((x) => x.id)).toEqual(['t']);
  });

  it('promoted blocks still leave the grid, and a field in neither stays', () => {
    const strip = stripFields({ topFields: [status], visibleFields: unified, unifiedFields: unified });
    expect(gridFieldsExcludingStrip(unified, strip, [notes]).map((x) => x.id)).toEqual(['priority', 'epic']);
  });
});

import { SET_ON_CREATE_TYPES, partitionStrip } from './strip-fields';

describe('partitionStrip (#1019)', () => {
  const f = (id: string, type: string): Field => ({ id, apiName: id, displayName: id, type }) as unknown as Field;
  const status = f('status', 'workflow'), who = f('who', 'user'), epic = f('epic', 'relation'), done = f('done', 'button');
  const values: Record<string, unknown> = { status: 'o1', who: undefined, epic: [] };
  const valueOf = (x: Field) => values[x.apiName];

  const due = f('due', 'date'), pri = f('pri', 'select');
  it('draws what has a value, keeps empty properties out of sight, and sets actions apart', () => {
    // epic (a relation) and pri (a select) are empty and stay absent; who (a person) is empty and is drawn (#1089, below).
    const p = partitionStrip([status, epic, pri, done], valueOf, new Set());
    expect(p.shown.map((x) => x.id)).toEqual(['status']);
    expect(p.absent.map((x) => x.id)).toEqual(['epic', 'pri']);
    expect(p.buttons.map((x) => x.id)).toEqual(['done']);
  });
  it('#1089: an EMPTY person or date field is drawn by default, so a new record can be assigned and dated in one click', () => {
    const p = partitionStrip([status, who, due, epic, pri], (x) => ({ status: 'o1' })[x.apiName as 'status'], new Set());
    expect(p.shown.map((x) => x.id)).toEqual(['status', 'who', 'due']);
    expect(p.absent.map((x) => x.id)).toEqual(['epic', 'pri']);
  });
  it('#1089: only user and date qualify: a text, number, select, checkbox or relation that is empty stays out of sight', () => {
    expect([...SET_ON_CREATE_TYPES].sort()).toEqual(['date', 'user']);
    for (const type of ['text', 'number', 'select', 'multi_select', 'checkbox', 'relation', 'workflow', 'url', 'email']) {
      expect(partitionStrip([f('x', type)], () => undefined, new Set()).shown).toEqual([]);
    }
  });
  it('#1089 MUST KEEP WORKING: a person or date field only reaches the strip if it is a visible member, so one a person hid stays hidden', () => {
    // partitionStrip only ever sees `strip.fields`, which record-detail builds from `visibleFields` (hidden fields removed).
    // The hidden field is simply not passed in, so it cannot be drawn by the rule above.
    const p = partitionStrip([status], valueOf, new Set());
    expect(p.shown.map((x) => x.id)).toEqual(['status']);
    expect(p.shown.some((x) => x.id === 'who')).toBe(false);
  });
  it('a property asked for through "+ Add property" is drawn even while empty — nothing loses its edit path', () => {
    const p = partitionStrip([status, epic], valueOf, new Set(['epic']));
    expect(p.shown.map((x) => x.id)).toEqual(['status', 'epic']);
    expect(p.absent).toEqual([]);
  });
  it('a button is never a property: not in shown, not in absent, whatever its value', () => {
    const p = partitionStrip([done], () => 'x', new Set());
    expect(p.shown).toEqual([]);
    expect(p.absent).toEqual([]);
    expect(p.buttons).toHaveLength(1);
  });
});

import { addableProperties, fieldTitle, plainValue } from './strip-fields';

describe('the strip names its values (ticket #1060)', () => {
  const opt = (id: string, label: string) => ({ id, label, color: 'gray' });
  const sel = (api: string, name: string, type = 'select'): Field =>
    ({ id: api, apiName: api, displayName: name, type, options: [opt('o1', 'Low'), opt('o2', 'High')] }) as unknown as Field;
  const names = new Map([['u1', 'Illia']]);

  it('says each value in words, for the tooltip and aria-label', () => {
    expect(plainValue(sel('p', 'Priority'), 'o1', names)).toBe('Low');
    expect(plainValue(sel('p', 'Priority', 'multi_select'), ['o1', 'o2'], names)).toBe('Low, High');
    expect(plainValue({ ...sel('a', 'Assignee'), type: 'user' } as Field, 'u1', names)).toBe('Illia');
    expect(plainValue({ ...sel('e', 'Epic'), type: 'relation' } as Field, [{ title: 'StoryOS-security' }], names)).toBe('StoryOS-security');
  });
  it('titles it "Field: Value", and never invents a value it cannot read', () => {
    expect(fieldTitle(sel('p', 'Priority'), 'o1', names)).toBe('Priority: Low');
    expect(fieldTitle(sel('p', 'Priority'), 'gone', names)).toBe('Priority'); // a dangling option id
    expect(fieldTitle(sel('p', 'Priority'), null, names)).toBe('Priority');
  });
  it('offers "+ Add property" only the EMPTY, fillable fields that are not already drawn', () => {
    const f = (id: string, type: string) => ({ id, apiName: id, displayName: id, type }) as unknown as Field;
    const fields = [f('prio', 'select'), f('who', 'user'), f('body', 'rich_text'), f('calc', 'formula'), f('rolled', 'rollup'), f('made', 'created_at'), f('kids', 'relation'), f('done', 'button'), f('due', 'date'), f('shown', 'select')];
    const values: Record<string, unknown> = { who: undefined, due: '2026-10-24', shown: 'x' };
    const kids = { ...fields[6]!, relation: { cardinality: 'many_to_many', side: 'a' } } as unknown as Field;
    const out = addableProperties([fields[0]!, fields[1]!, fields[2]!, fields[3]!, fields[4]!, fields[5]!, kids, fields[7]!, fields[8]!, fields[9]!], [fields[9]!], (x) => values[x.apiName]);
    expect(out.map((x) => x.id)).toEqual(['prio', 'who']);
  });
});
