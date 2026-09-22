import { describe, expect, it } from 'vitest';
import { defaultTableHiddenFieldIds } from './default-table-columns';
import type { Field } from '@/components/table-view/use-table-data';

function field(apiName: string, type = 'text'): Field {
  return { id: `f_${apiName}`, apiName, displayName: apiName, type, config: {}, isSystem: false };
}

describe('defaultTableHiddenFieldIds — #739 AC1/T1', () => {
  it('an Issues-shaped database hides everything except title and the four named fields', () => {
    const fields = [
      field('name', 'title'),
      field('state', 'workflow'),
      field('priority', 'select'),
      field('type', 'select'),
      field('next', 'relation'),
      field('description', 'text'),
      field('labels', 'multi_select'),
    ];
    const hidden = defaultTableHiddenFieldIds(fields);
    expect(hidden.sort()).toEqual(['f_description', 'f_labels'].sort());
  });

  it('title is never hidden regardless of its api_name', () => {
    const fields = [field('name', 'title')];
    expect(defaultTableHiddenFieldIds(fields)).toEqual([]);
  });

  it('a database with none of the four named fields hides everything but title', () => {
    const fields = [field('name', 'title'), field('email', 'email'), field('phone', 'text')];
    const hidden = defaultTableHiddenFieldIds(fields);
    expect(hidden.sort()).toEqual(['f_email', 'f_phone'].sort());
  });

  it('a field merely named like one of the four but not the exact api_name is still hidden', () => {
    const fields = [field('name', 'title'), field('priority_score', 'number')];
    expect(defaultTableHiddenFieldIds(fields)).toEqual(['f_priority_score']);
  });
});
