import { describe, expect, it } from 'vitest';
import { mapFilterValues } from './tools.js';

// Minimal DatabaseDetail with a select and a person field.
const detail = {
  id: 'db1',
  name: 'Issues',
  fields: [
    {
      apiName: 'priority',
      type: 'select',
      options: [
        { id: 'opt-urgent', label: 'Urgent' },
        { id: 'opt-high', label: 'High' },
      ],
    },
    { apiName: 'assignee', type: 'user' },
    { apiName: 'title', type: 'text' },
  ],
} as never;

describe('mapFilterValues (#204)', () => {
  it('translates eq on a select to has over an id array, mapping the label', () => {
    const out = mapFilterValues(detail, { field: 'priority', op: 'eq', value: 'Urgent' });
    expect(out).toEqual({ field: 'priority', op: 'has', value: ['opt-urgent'] });
  });

  it('translates neq to has_none', () => {
    const out = mapFilterValues(detail, { field: 'priority', op: 'neq', value: 'High' });
    expect(out).toEqual({ field: 'priority', op: 'has_none', value: ['opt-high'] });
  });

  it('recurses into grouped and/or filters', () => {
    const out = mapFilterValues(detail, {
      and: [{ field: 'priority', op: 'eq', value: 'urgent' }],
    });
    expect(out).toEqual({ and: [{ field: 'priority', op: 'has', value: ['opt-urgent'] }] });
  });

  it('maps the @me sentinel on a person field', () => {
    const out = mapFilterValues(detail, { field: 'assignee', op: 'eq', value: '@me' });
    expect(out).toEqual({ field: 'assignee', op: 'has', value: ['me'] });
  });

  it('accepts an already-correct has filter with option ids', () => {
    const out = mapFilterValues(detail, { field: 'priority', op: 'has', value: ['opt-high'] });
    expect(out).toEqual({ field: 'priority', op: 'has', value: ['opt-high'] });
  });

  it('tolerates a stringified filter', () => {
    const out = mapFilterValues(detail, '{"field":"priority","op":"eq","value":"Urgent"}');
    expect(out).toEqual({ field: 'priority', op: 'has', value: ['opt-urgent'] });
  });

  it('leaves non-membership fields untouched', () => {
    const out = mapFilterValues(detail, { field: 'title', op: 'contains', value: 'spec' });
    expect(out).toEqual({ field: 'title', op: 'contains', value: 'spec' });
  });

  it('throws a helpful error naming valid options on an unknown label', () => {
    expect(() => mapFilterValues(detail, { field: 'priority', op: 'eq', value: 'Nope' })).toThrow(
      /No option "Nope".*Urgent, High/,
    );
  });
});
