import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SelectField, type SelectFieldProps } from './select-field';

function render(props: Partial<SelectFieldProps> & Pick<SelectFieldProps, 'value'>) {
  return renderToStaticMarkup(
    createElement(SelectField, {
      label: 'Field',
      onChange: () => {},
      options: [
        { value: 'a', label: 'Option A' },
        { value: 'b', label: 'Option B' },
      ],
      ...props,
    }),
  );
}

/** Match the opening tag of the blank `<option value="">` regardless of the
 * extra SSR-injected attributes (`selected`, `disabled`) or their order. */
function blankOption(html: string): string | undefined {
  return html.match(/<option value=""[^>]*>[^<]*<\/option>/)?.[0];
}

describe('SelectField', () => {
  describe('default (allowEmpty=true, backward-compatible)', () => {
    it('renders a selectable (non-disabled) blank option', () => {
      const option = blankOption(render({ value: '' }));
      expect(option).toBeDefined();
      expect(option).toContain('Choose');
      expect(option).not.toContain('disabled');
    });

    it('keeps the blank option even when a value is set (optional fields)', () => {
      const option = blankOption(render({ value: 'a' }));
      expect(option).toBeDefined();
      expect(option).not.toContain('disabled');
    });

    it('uses the placeholder as the blank label when provided', () => {
      const option = blankOption(render({ value: '', placeholder: 'No description' }));
      expect(option).toContain('No description');
    });
  });

  describe('strict (allowEmpty=false) — #104', () => {
    it('renders the blank option disabled while nothing is selected', () => {
      const option = blankOption(render({ value: '', allowEmpty: false, placeholder: 'Choose database' }));
      expect(option).toBeDefined();
      expect(option).toContain('disabled');
      expect(option).toContain('Choose database');
    });

    it('suppresses the blank option entirely once a value is set', () => {
      const html = render({ value: 'a', allowEmpty: false });
      expect(html).not.toContain('value=""');
    });

    it('never offers a selectable (non-disabled) empty value in either state', () => {
      // Unset: blank present but disabled; set: blank absent. In neither case
      // is there an enabled empty value to pick back to (no silent clear).
      const unset = blankOption(render({ value: '', allowEmpty: false }));
      expect(unset).toContain('disabled');
      expect(blankOption(render({ value: 'a', allowEmpty: false }))).toBeUndefined();
    });
  });
});
