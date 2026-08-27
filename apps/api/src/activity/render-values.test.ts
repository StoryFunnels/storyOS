import { describe, expect, it, vi } from 'vitest';
import type { Db } from '../db/client';
import { buildRenderContext, renderTypedValue, renderValue } from './render-values';

/**
 * #335 — history must render a value the way the record does.
 *
 * The ticket found capture storing what the write stored (a number `3`) while
 * the record read path returned a coerced one (`"3"`). That exact pair is no
 * longer reachable: the API now rejects a number written into a text field
 * outright ("expected a string"), so the two cannot disagree that way any more.
 *
 * The class of defect very much survived, in the form the ACs name directly —
 * SELECT values. Capture stores the option uuid; the record surface renders the
 * label. Verified live before writing this:
 *
 *   record   values.status335 = '7c4b3ec2-…'   (id, mapped to a label by the UI)
 *   changes  new_value        = '7c4b3ec2-…'   (id, with nothing to map it)
 *   activity changes[].to     = 'Shipped'      (already resolved)
 *
 * So the activity feed had been resolving correctly all along and its sibling —
 * reading a diff written by the same `update()` — had not.
 */
const FIELDS = [
  { id: 'f-status', displayName: 'Status', type: 'select', deletedAt: null },
  { id: 'f-tags', displayName: 'Tags', type: 'multi_select', deletedAt: null },
  { id: 'f-notes', displayName: 'Notes', type: 'text', deletedAt: null },
  { id: 'f-gone', displayName: 'Retired', type: 'select', deletedAt: new Date('2026-08-01') },
];
const OPTIONS = [
  { id: 'opt-open', fieldId: 'f-status', label: 'Open' },
  { id: 'opt-shipped', fieldId: 'f-status', label: 'Shipped' },
  { id: 'opt-red', fieldId: 'f-tags', label: 'Red' },
  { id: 'opt-old', fieldId: 'f-gone', label: 'Was A Thing' },
];

const db = {
  query: {
    fields: { findMany: vi.fn().mockResolvedValue(FIELDS) },
    selectOptions: { findMany: vi.fn().mockResolvedValue(OPTIONS) },
  },
} as unknown as Db;

describe('#335 render context', () => {
  it('turns a select option id into the label the record shows', async () => {
    const ctx = await buildRenderContext(db, 'db-1');
    expect(renderValue('opt-shipped', ctx)).toBe('Shipped');
    expect(renderValue('opt-open', ctx)).toBe('Open');
  });

  it('resolves every id in a multi-select', async () => {
    const ctx = await buildRenderContext(db, 'db-1');
    expect(renderValue(['opt-red', 'opt-open'], ctx)).toEqual(['Red', 'Open']);
  });

  it('still reads a change to a field someone later DELETED', async () => {
    // The whole point of a change log. A removed field must not turn its history
    // into uuids — and its options outlive it here for the same reason.
    const ctx = await buildRenderContext(db, 'db-1');
    expect(ctx.fieldName.get('f-gone')).toBe('Retired (deleted field)');
    expect(renderValue('opt-old', ctx)).toBe('Was A Thing');
  });

  it('leaves everything that is not an option id exactly alone', async () => {
    const ctx = await buildRenderContext(db, 'db-1');
    // Dates stay ISO and numbers stay numbers: the record API returns them
    // verbatim too, and formatting only here would be a NEW disagreement.
    expect(renderValue('2026-09-01', ctx)).toBe('2026-09-01');
    expect(renderValue(3, ctx)).toBe(3);
    expect(renderValue('3', ctx)).toBe('3');
    expect(renderValue(null, ctx)).toBe(null);
    expect(renderValue(true, ctx)).toBe(true);
  });

  it('falls through to the raw id when the option is gone', async () => {
    // Better a true uuid than a confident "(unknown)". The caller still holds
    // the faithful old_value/new_value pair alongside.
    const ctx = await buildRenderContext(db, 'db-1');
    expect(renderValue('opt-vanished', ctx)).toBe('opt-vanished');
  });

  it('carries the field TYPE, so a client can render without the schema', async () => {
    const ctx = await buildRenderContext(db, 'db-1');
    expect(ctx.fieldType.get('f-status')).toBe('select');
    expect(ctx.fieldType.get('f-notes')).toBe('text');
    // Including for the field that no longer exists — the case a client cannot
    // resolve for itself, which is why this is done server-side.
    expect(ctx.fieldType.get('f-gone')).toBe('select');
  });

  it('does not query options when the database has no select-like field', async () => {
    const plain = {
      query: {
        fields: { findMany: vi.fn().mockResolvedValue([FIELDS[2]]) },
        selectOptions: { findMany: vi.fn() },
      },
    } as unknown as Db;
    await buildRenderContext(plain, 'db-1');
    expect(plain.query.selectOptions.findMany).not.toHaveBeenCalled();
  });
});

describe('#335 typed rendering', () => {
  it('translates option ids only for select-like fields', async () => {
    const ctx = await buildRenderContext(db, 'db-1');
    expect(renderTypedValue('opt-shipped', 'select', ctx)).toBe('Shipped');
    expect(renderTypedValue(['opt-red'], 'multi_select', ctx)).toEqual(['Red']);
    expect(renderTypedValue('opt-open', 'workflow', ctx)).toBe('Open');
  });

  it('leaves a TEXT field alone even when its value looks like an option id', () => {
    // The reason this function exists. `renderValue` maps any string that
    // matches an option id; a text field that happened to store one would
    // silently render as an unrelated field's label. Improbable, not impossible.
    const ctx = { optionLabel: new Map([['opt-shipped', 'Shipped']]) };
    expect(renderTypedValue('opt-shipped', 'text', ctx)).toBe('opt-shipped');
    expect(renderValue('opt-shipped', ctx)).toBe('Shipped'); // the looser sibling
  });

  it('leaves a value alone when the type is unknown', async () => {
    // A change to a field that no longer exists at all: better the raw value
    // than a guess, and the caller still has old_value/new_value.
    const ctx = await buildRenderContext(db, 'db-1');
    expect(renderTypedValue('opt-shipped', null, ctx)).toBe('opt-shipped');
    expect(renderTypedValue('opt-shipped', undefined, ctx)).toBe('opt-shipped');
  });
});
