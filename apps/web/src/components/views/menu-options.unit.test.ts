import { createElement } from 'react';
import { describe, expect, it } from 'vitest';
import { optionsFromChildren } from './menu-options';

/** #1114 — a picker's items come off its `<option>` children. */
describe('optionsFromChildren', () => {
  it('reads value, label and disabled from each option, in order', () => {
    const items = optionsFromChildren([
      createElement('option', { key: 'a', value: '' }, 'None'),
      createElement('option', { key: 'b', value: 'f1', disabled: true }, 'State'),
    ]);
    expect(items).toEqual([
      { value: '', label: 'None', disabled: undefined },
      { value: 'f1', label: 'State', disabled: true },
    ]);
  });
  it('skips what is not an option element — a conditional null, a stray string', () => {
    expect(optionsFromChildren([null, 'text', createElement('option', { key: 'x', value: 'x' }, 'X')])).toEqual([{ value: 'x', label: 'X', disabled: undefined }]);
  });
});
