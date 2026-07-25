import { describe, expect, it } from 'vitest';
import { SYSTEM_FIELDS, SYSTEM_FIELD_BY_API_NAME } from '@storyos/schemas';
import type { Field } from '../table-view/use-table-data';
import {
  SYSTEM_FIELD_LABELS,
  SYSTEM_FIELD_OPS,
  SYSTEM_SORTABLE_TYPES,
  withSystemFields,
} from './system-fields';

/**
 * #352 — the filter/sort controls must enumerate the built-in system fields from
 * the shared @storyos/schemas registry, with type-appropriate operator widgets,
 * and never surface an op the API filter compiler would reject.
 */

function sys(apiName: string, type: string, displayName: string): Field {
  return { id: `f_${apiName}`, apiName, displayName, type, config: {}, isSystem: true };
}
function userField(apiName: string, type: string): Field {
  return { id: `u_${apiName}`, apiName, displayName: apiName, type, config: {}, isSystem: false };
}

// The four system fields that exist as stored rows on every database, plus a
// user-defined field — the shape the introspection endpoint returns today.
const STORED: Field[] = [
  sys('id', 'id', 'ID'),
  sys('created_at', 'created_at', 'Created at'),
  sys('updated_at', 'updated_at', 'Updated at'),
  sys('created_by', 'created_by', 'Created by'),
  userField('status', 'select'),
];

describe('withSystemFields — field-list enumeration', () => {
  const out = withSystemFields(STORED);
  const byApiName = new Map(out.map((f) => [f.apiName, f]));

  it('surfaces all six canonical system fields', () => {
    for (const spec of SYSTEM_FIELDS) {
      expect(byApiName.has(spec.api_name), `missing ${spec.api_name}`).toBe(true);
    }
  });

  it('appends the two fields with no stored row (number, updated_by) as synthetic system fields', () => {
    const number = byApiName.get('number');
    const updatedBy = byApiName.get('updated_by');
    expect(number).toMatchObject({ apiName: 'number', type: 'id', isSystem: true, displayName: 'Number' });
    expect(updatedBy).toMatchObject({ apiName: 'updated_by', type: 'updated_by', isSystem: true, displayName: 'Last edited by' });
  });

  it('applies the ticket display labels to the stored system rows', () => {
    expect(byApiName.get('id')?.displayName).toBe('ID');
    expect(byApiName.get('created_at')?.displayName).toBe('Created');
    expect(byApiName.get('updated_at')?.displayName).toBe('Last edited');
    expect(byApiName.get('created_by')?.displayName).toBe('Created by');
  });

  it('labels match the exported SYSTEM_FIELD_LABELS map', () => {
    for (const spec of SYSTEM_FIELDS) {
      expect(byApiName.get(spec.api_name)?.displayName).toBe(SYSTEM_FIELD_LABELS[spec.api_name]);
    }
  });

  it('leaves user-defined fields untouched', () => {
    expect(byApiName.get('status')).toMatchObject({ type: 'select', isSystem: false, displayName: 'status' });
  });

  it('never adds a duplicate — a real user field named `number` wins over the synthetic overlay', () => {
    const withUserNumber = withSystemFields([...STORED, userField('number', 'number')]);
    const numbers = withUserNumber.filter((f) => f.apiName === 'number');
    expect(numbers).toHaveLength(1);
    expect(numbers[0]).toMatchObject({ type: 'number', isSystem: false, displayName: 'number' });
  });
});

describe('SYSTEM_FIELD_OPS — operator menus per system type', () => {
  it('exposes an op menu for every distinct system compiler type', () => {
    for (const type of ['id', 'created_at', 'updated_at', 'created_by', 'updated_by']) {
      expect(SYSTEM_FIELD_OPS[type]?.length, `no ops for ${type}`).toBeGreaterThan(0);
    }
  });

  it('never surfaces an operator the registry does not allow (no backend-rejected op)', () => {
    for (const spec of SYSTEM_FIELDS) {
      const menu = SYSTEM_FIELD_OPS[spec.type] ?? [];
      const allowed = new Set(spec.filter_ops as string[]);
      for (const entry of menu) {
        expect(allowed.has(entry.op), `${spec.api_name} must not offer ${entry.op}`).toBe(true);
      }
    }
  });

  it('number/id → numeric comparison widgets + emptiness', () => {
    const menu = SYSTEM_FIELD_OPS['id'] ?? [];
    const byOp = new Map(menu.map((e) => [e.op, e]));
    expect(byOp.get('eq')).toMatchObject({ input: 'number', label: '=' });
    expect(byOp.get('gte')).toMatchObject({ input: 'number', label: '≥' });
    expect(byOp.get('lte')).toMatchObject({ input: 'number', label: '≤' });
    expect(byOp.get('is_empty')).toMatchObject({ input: 'none' });
    // no set/text/date widgets on a number field
    expect(menu.every((e) => e.input === 'number' || e.input === 'none')).toBe(true);
  });

  it('created_at/updated_at → date + relative-range widgets', () => {
    for (const type of ['created_at', 'updated_at']) {
      const byOp = new Map((SYSTEM_FIELD_OPS[type] ?? []).map((e) => [e.op, e]));
      expect(byOp.get('before')).toMatchObject({ input: 'date', label: 'before' });
      expect(byOp.get('after')).toMatchObject({ input: 'date', label: 'after' });
      expect(byOp.get('within')).toMatchObject({ input: 'relative', label: 'within' });
      expect(byOp.get('eq')).toMatchObject({ input: 'date', label: 'on' });
    }
  });

  it('created_by/updated_by → member-picker (set membership) widgets only', () => {
    for (const type of ['created_by', 'updated_by']) {
      const menu = SYSTEM_FIELD_OPS[type] ?? [];
      const byOp = new Map(menu.map((e) => [e.op, e]));
      expect(byOp.get('has')).toMatchObject({ input: 'options', label: 'is any of' });
      expect(byOp.get('has_none')).toMatchObject({ input: 'options', label: 'is none of' });
      // scalar eq/neq are intentionally not offered (would send an array to a
      // scalar op) — only the safe set-membership + emptiness idiom.
      expect(byOp.has('eq')).toBe(false);
      expect(byOp.has('neq')).toBe(false);
      expect(menu.every((e) => e.input === 'options' || e.input === 'none')).toBe(true);
    }
  });
});

describe('SYSTEM_SORTABLE_TYPES', () => {
  it('marks all system compiler types sortable', () => {
    for (const type of ['id', 'created_at', 'updated_at', 'created_by', 'updated_by']) {
      expect(SYSTEM_SORTABLE_TYPES).toContain(type);
    }
  });

  it('only lists types the registry flags sortable', () => {
    for (const type of SYSTEM_SORTABLE_TYPES) {
      const anySortable = SYSTEM_FIELDS.some((f) => f.type === type && f.sortable);
      expect(anySortable, `${type} not registry-sortable`).toBe(true);
    }
  });

  it('registry sanity — every canonical system field is sortable', () => {
    // guards the assumption the UI leans on
    for (const spec of SYSTEM_FIELDS) {
      expect(SYSTEM_FIELD_BY_API_NAME.get(spec.api_name)?.sortable).toBe(true);
    }
  });
});
