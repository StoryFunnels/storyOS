import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { notDoneConditions } from './me-view';
import type { Field } from '@/components/table-view/use-table-data';

const wf = (labels: string[]): Field =>
  ({
    id: 'f1',
    apiName: 'state',
    displayName: 'State',
    type: 'workflow',
    options: labels.map((label, i) => ({ id: `o${i}`, label })),
  }) as unknown as Field;

describe('notDoneConditions (#928)', () => {
  it('excludes the options that plainly mean finished', () => {
    expect(notDoneConditions([wf(['Todo', 'Doing', 'Done', 'Canceled'])])).toEqual([
      { field: 'state', op: 'has_none', value: ['o2', 'o3'] },
    ]);
  });
  it('reads the option\'s state category (ticket #1014), which wins over the label', () => {
    const field = {
      id: 'f1', apiName: 'state', displayName: 'State', type: 'workflow',
      options: [
        { id: 'a', label: 'Shipped it', category: 'completed' },
        { id: 'b', label: 'Done', category: 'started' },
        { id: 'c', label: 'Dropped', category: 'canceled' },
        { id: 'd', label: 'Doing', category: 'started' },
      ],
    } as unknown as Field;
    expect(notDoneConditions([field])).toEqual([{ field: 'state', op: 'has_none', value: ['a', 'c'] }]);
  });
  it('adds nothing when there is no workflow field or nothing in it is finished', () => {
    expect(notDoneConditions([])).toEqual([]);
    expect(notDoneConditions([wf(['Backlog', 'Shipping', 'Parked'])])).toEqual([]);
    expect(notDoneConditions([{ ...wf(['Done']), type: 'select' } as unknown as Field])).toEqual([]);
  });
});

describe('the chip reads in a person’s words (#928)', () => {
  it('describeCondition asks me-label first, only for user-typed fields', () => {
    const src = readFileSync(join(__dirname, 'view-toolbar.tsx'), 'utf8');
    const body = src.slice(src.indexOf('function describeCondition('));
    const head = body.slice(0, body.indexOf('const ops = opsForField(field);'));
    expect(head).toMatch(/isUserField\(field\)/);
    expect(head).toMatch(/meConditionText\(field\.displayName, condition\.op, condition\.value\)/);
  });
});
