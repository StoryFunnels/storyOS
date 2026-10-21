import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * #996 — the toolbar's narrow tiers, pinned in the source. Vera measured the view toolbar's "New" button cut off by the record
 * peek (1270 wide: pane 299px, New at 631–669; 1440: pane 465px, New at 738–807) because the row was wider than its pane. The
 * fix is a ladder of container-query tiers; the live check is `row.scrollWidth <= row.clientWidth` and New's right edge inside
 * the pane at 1270 / 1440 / 2000 (measured: 299=299, 465=465, 1025=1025).
 */
const src = readFileSync(fileURLToPath(new URL('./view-toolbar.tsx', import.meta.url)), 'utf8');
const row = /<div className="flex min-h-9 flex-nowrap[^"]*"/.exec(src)?.[0] ?? '';

describe('toolbar narrow tiers (#996)', () => {
  it('the row never wraps', () => {
    expect(row).toContain('flex-nowrap');
  });
  it.each([
    ['@max-[600px]:[&_.tb-count]:hidden', 'the count goes first'],
    ['@max-[600px]:[&_.tb-find]:hidden', 'then the Find word'],
    ['@max-[560px]:[&_.tb-display]:hidden', 'then the Display word'],
    ['@max-[500px]:[&_.tb-new]:hidden', 'then the New word'],
    ['@max-[440px]:[&_.tb-fs]:hidden', 'then the Filter and Sort words'],
    ['@max-[340px]:[&_.tb-group]:hidden', 'at a peek-sized pane the Group chip keeps only its icon'],
    ['@max-[340px]:[&_.tb-pinned]:hidden', 'and pinned condition chips step aside (they are in the Filter panel)'],
    ['@max-[340px]:[&_button]:px-2', 'and every control tightens'],
  ])('has %s — %s', (cls) => {
    expect(row).toContain(cls);
  });
});
