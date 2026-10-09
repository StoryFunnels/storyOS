import { describe, expect, it } from 'vitest';
import type { Field } from '@/components/table-view/use-table-data';
import { canPinToStrip, stripFields, stripPlan, zonesWithTop } from './strip-fields';

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
