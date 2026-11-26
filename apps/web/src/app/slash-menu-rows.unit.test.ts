import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * #1344 — the "/" menu's group headings drew on top of the rows beneath them.
 *
 * The menu is a capped-height column flexbox, so every row and heading is a flex item with the default
 * `flex-shrink: 1`. #338 removed the rows' `min-height` floor, which let a long menu squeeze each item to ~20px
 * while its 32px icon tile kept its size. This pins the rule that stops it; the computed result was checked in a
 * real browser (rows 52px, `flex-shrink: 0`, no overlap), because a node test cannot lay anything out.
 */
const css = readFileSync(join(__dirname, 'globals.css'), 'utf8');

/** The declaration block of the first rule whose selector list is exactly `selectors`. */
function blockFor(selectors: string[]): string | undefined {
  const want = selectors.join(',').replace(/\s+/g, ' ');
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const sel = m[1]!.replace(/\/\*[\s\S]*?\*\//g, '').split(',').map((s) => s.trim().replace(/\s+/g, ' ')).join(',');
    if (sel === want) return m[2];
  }
  return undefined;
}

describe('#1344 slash-menu rows keep their height', () => {
  const rule = blockFor(['.bn-suggestion-menu > .bn-suggestion-menu-item', '.bn-suggestion-menu > .bn-suggestion-menu-label']);

  it('has a rule for both the rows and the group headings', () => {
    expect(rule).toBeDefined();
  });

  it('stops both from shrinking inside the scrolling menu', () => {
    expect(rule).toMatch(/flex-shrink:\s*0\s*;/);
  });

  it('still lets the rows go below their content height, which is why the rule is needed', () => {
    // If #338's `min-height: 0` is ever removed this guard may be dropped; until then it is the reason for the rule above.
    expect(blockFor(['.bn-suggestion-menu .bn-suggestion-menu-item'])).toMatch(/min-height:\s*0\s*;/);
  });
});
