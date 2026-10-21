import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * #994 — the sidebar's space rows, pinned in the source (the failure is textual: a later edit restores the hover-only
 * actions, or draws a chosen icon OUTSIDE the mark, or loses it).
 */
const read = (f: string) => readFileSync(fileURLToPath(new URL(f, import.meta.url)), 'utf8');
const sidebar = read('./sidebar.tsx');
const menu = read('./sidebar-row-menu.tsx');
const viewRow = read('./sidebar-view-row.tsx');

describe('#994 sidebar space rows', () => {
  it('a space’s mark is ONE object: its colour, with the chosen icon inside, else its two letters', () => {
    expect(sidebar).toMatch(/<LetterMark name=\{space\.name\} color=\{space\.color\} icon=\{space\.icon\} \/>/);
    // the chosen icon is drawn inside the coloured box, never beside it
    expect(sidebar).toMatch(/\{icon \? <EntityIcon icon=\{icon\}[^>]*fallback=\{letter\}/);
  });

  it('the mark’s colour goes through the option palette, not the raw name as a CSS keyword', () => {
    expect(sidebar).toMatch(/OPTION_COLORS\[color\] \?\? color/);
  });

  it('the + and ⋯ on a space header rest visible: no hover-only reveal and no count swap', () => {
    expect(sidebar).toMatch(/const SPACE_ACT =\s*'[^']*text-faint[^']*group-hover:text-muted/);
    expect(sidebar).not.toMatch(/hidden group-focus-within:flex group-hover:flex/);
    expect(sidebar).not.toMatch(/group-focus-within:hidden group-hover:hidden/);
  });

  it('every row’s ⋯ rests at --faint instead of opacity-0', () => {
    expect(menu).toMatch(/text-faint transition-colors group-hover:text-muted/);
    expect(menu).not.toMatch(/opacity-0 transition-opacity group-hover:opacity-100/);
  });

  it('a view pinned to the viewer’s tabs carries the star at the right edge', () => {
    expect(viewRow).toMatch(/\{pinned && <Star /);
  });
});
