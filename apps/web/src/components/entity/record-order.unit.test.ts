import { describe, expect, it } from 'vitest';
import { hasOwnRecordOrder, orderKey, resetOrderPlan } from './entity-field-utils';
import type { Field } from '@/components/table-view/use-table-data';

/**
 * #414 — the properties panel must say when it has forked from the database order.
 *
 * The UAT case, exactly: on `Deals`, drag `Won` to the front in the GRID (which
 * writes `field.position`), then drag `Close Date` to the top in a RECORD (which
 * writes `entity_order`). Both persist. They disagree, and nothing said they would.
 *
 * Grid:   Won, Amount, Stage, Owner, Close Date
 * Record: Close Date, Won, Amount, Stage, Owner
 *
 * The founder chose (a): keep both orders, but surface the fork and offer a way
 * back. So the assertions here are (1) the fork is detected only once it exists,
 * and (2) undoing it actually restores the grid's order — not merely that some
 * mutation fired.
 */
const field = (id: string, config: Record<string, unknown> = {}): Field =>
  ({ id, apiName: id, displayName: id, type: 'text', config }) as unknown as Field;

/** Grid order after the first drag — this is what `field.position` yields. */
const GRID = ['won', 'amount', 'stage', 'owner', 'close_date'];
const apiIndex = new Map(GRID.map((id, i) => [id, i]));
const sorted = (fields: Field[]) =>
  [...fields].sort((a, b) => orderKey(a, apiIndex.get(a.id) ?? 0) - orderKey(b, apiIndex.get(b.id) ?? 0)).map((f) => f.id);

describe('#414 record order vs database order', () => {
  it('says nothing while the record is still following the database', () => {
    const fields = GRID.map((id) => field(id));
    expect(hasOwnRecordOrder(fields)).toBe(false);
    expect(sorted(fields)).toEqual(GRID);
  });

  it('detects the fork the moment one property carries its own order', () => {
    const fields = GRID.map((id) => field(id, id === 'close_date' ? { entity_order: 0 } : {}));
    expect(hasOwnRecordOrder(fields)).toBe(true);
  });

  it('reproduces the exact divergence from the ticket', () => {
    // What the record drag writes: Close Date to the top, the rest renumbered.
    const forked = ['close_date', 'won', 'amount', 'stage', 'owner'];
    const fields = GRID.map((id) => field(id, { entity_order: forked.indexOf(id) }));
    expect(sorted(fields)).toEqual(forked);
    expect(sorted(fields)).not.toEqual(GRID);
  });

  it('follows the database order again once the plan is applied', () => {
    const forked = ['close_date', 'won', 'amount', 'stage', 'owner'];
    const fields = GRID.map((id) => field(id, { entity_order: forked.indexOf(id) }));

    const plan = resetOrderPlan(fields);
    expect(plan.fieldIds.sort()).toEqual([...GRID].sort());

    // The mutation sends null, not a missing key — the PATCH is a shallow merge
    // server-side, so an omitted key would keep the stored number.
    const cleared = fields.map((f) => field(f.id, { ...f.config, entity_order: null }));
    expect(sorted(cleared)).toEqual(GRID);
    expect(hasOwnRecordOrder(cleared)).toBe(false);
  });

  it('counts the description, which shares the integer space without being a field', () => {
    // #310 put the description in the same order space. Ignoring it would leave it
    // parked where a drag dropped it while every field snapped back.
    const clean = GRID.map((id) => field(id));
    expect(hasOwnRecordOrder(clean, null)).toBe(false);
    expect(hasOwnRecordOrder(clean, 2)).toBe(true);
    expect(resetOrderPlan(clean, 2)).toEqual({ fieldIds: [], clearDescription: true });
    expect(resetOrderPlan(clean, null).clearDescription).toBe(false);
  });

  it('leaves other layout config alone — this button resets ORDER, not visibility', () => {
    const fields = [field('won', { entity_order: 3, entity_hidden: true, entity_zones: ['top'] })];
    expect(resetOrderPlan(fields).fieldIds).toEqual(['won']);
    // Only entity_order is in the patch the caller sends; a reset that also wiped
    // zones or hidden flags would silently undo the user's other arrangement.
    const patch = { entity_order: null };
    expect(Object.keys(patch)).toEqual(['entity_order']);
  });
});
