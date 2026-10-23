import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { OptionChip } from '../table-view/cells';
import { STRIP_PERSON, STRIP_PILL, StripChipContext } from './strip-chip';

const src = (rel: string) => readFileSync(join(__dirname, '..', '..', rel), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');

/**
 * Ticket #1060 — the strip's values are ONE pill, and the action is a BUTTON that can never be mistaken for one. This is the regression
 * #1019 shipped without: the relation chip and the action were never seen, and "Mark as Done" read as another status chip.
 */
describe('the header strip: one pill for values, a button for the action (ticket #1060)', () => {
  const option = { id: 'o1', label: 'Confirmed', color: 'green' };

  it('a select / state / verdict value in the strip wears the strip pill: 19px, 8px padding, 12px / 600', () => {
    const html = renderToStaticMarkup(createElement(StripChipContext.Provider, { value: true }, createElement(OptionChip, { option })));
    for (const cls of STRIP_PILL.split(' ').filter((c) => c.startsWith('h-[') || c.startsWith('px-') || c.startsWith('text-') || c.startsWith('font-'))) {
      expect(html, cls).toContain(cls);
    }
    expect(html).toContain('option-tint'); // the same tint mechanism as every other option chip
  });

  it('outside the strip the very same chip keeps the shared value chip (the table, the sidebar, the filters are untouched)', () => {
    const html = renderToStaticMarkup(createElement(OptionChip, { option }));
    expect(html).not.toContain('h-[19px]');
  });

  it('an action in the strip is the app\'s secondary Button, 27px, a strong border and no fill — never a tinted chip', () => {
    const cells = src('components/table-view/cells.tsx');
    const strip = cells.slice(cells.indexOf('if (strip) {', cells.indexOf('export function PressButton')));
    const branch = strip.slice(0, strip.indexOf('return (\n    <button'));
    expect(branch).toMatch(/<Button[\s\S]*variant="secondary"/);
    expect(branch).toContain('h-[27px]');
    expect(branch).toContain('border-border-strong');
    expect(branch).toContain('bg-transparent');
    expect(branch).toContain('data-strip-action');
    // and nothing in that branch tints from the field's colour (the green that made it read as a value)
    expect(branch).not.toMatch(/backgroundColor|color\}|OPTION_COLORS/);
  });

  it('the relation (the Epic) is the same pill in a neutral tint, not a bordered chip with a dot', () => {
    const scalar = src('components/entity/scalar-fields.tsx');
    const at = scalar.indexOf("cn(STRIP_PILL, '");
    expect(at, 'the relation chip uses the strip pill').toBeGreaterThan(0);
    const classes = scalar.slice(at, scalar.indexOf(')', at));
    expect(classes).toContain('bg-hover');
    expect(classes).not.toMatch(/border/);
  });

  it('every strip value carries its field name, the state and people carry no visible label, and the action sits at the right end', () => {
    const page = src('components/entity/record-detail.tsx');
    expect(page).toMatch(/role="group" aria-label=\{title\} title=\{title\}/);
    expect(page).toMatch(/SELF_EVIDENT_IN_STRIP = new Set\(\['workflow', 'user', 'created_by'\]\)/);
    expect(page).toMatch(/ml-auto flex flex-wrap/);
    expect(STRIP_PERSON).toContain('h-[19px]');
  });
});
