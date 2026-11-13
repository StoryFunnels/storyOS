import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MENU_ITEM_GEOMETRY } from './dropdown-menu';

/**
 * #1281 item 2 (the shared remainder) and item 7. One menu geometry for every dropdown and popover in the app:
 * items 28px tall at 12px, lists at least 200px wide, ONE 8px radius, ONE shadow, and the light hover token #ebe6da.
 * Read from source and from globals.css, like the other token guards: what matters is that every menu gets its
 * size from the shared tokens, not from a copy that can drift.
 */
const root = join(__dirname, '../..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');
const css = read('app/globals.css');
const dropdown = read('components/ui/dropdown-menu.tsx');
const popover = read('components/ui/popover.tsx');

function walk(dir: string, out: string[] = []) {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx$/.test(n)) out.push(p);
  }
  return out;
}
/** The declaration's value in the Nth block that declares it: 0 = :root (light), 1 = the dark block. */
function decl(name: string, which: number) {
  const m = [...css.matchAll(new RegExp(`^\\s*${name}:\\s*([^;]+);`, 'gm'))];
  return m[which]?.[1]?.trim();
}
describe('#1281 the shared menu geometry', () => {
  it('names the numbers once, in tokens', () => {
    expect(decl('--menu-item-height', 0)).toBe('28px');
    expect(decl('--menu-min-width', 0)).toBe('200px');
    expect(decl('--radius-popover', 0)).toBe('8px');
    expect(decl('--shadow-popover', 0)).toBe('0 8px 24px rgb(var(--shadow-ink) / 0.12)');
  });

  it('dark ships its own popover shadow, so the lift stays visible on a dark ground (the 1px border is the edge)', () => {
    const dark = decl('--shadow-popover', 1);
    expect(dark).toBeDefined();
    expect(dark).not.toBe(decl('--shadow-popover', 0));
    expect(dark).toContain('0 8px 24px');
    expect(dropdown).toContain('border border-border-default');
    expect(popover).toContain('border border-border-default');
  });

  it('a menu item is 28px at 12px and DropdownMenuItem wears the shared geometry', () => {
    expect(MENU_ITEM_GEOMETRY).toContain('min-h-[var(--menu-item-height)]');
    expect(MENU_ITEM_GEOMETRY).toContain('text-label');
    expect(decl('--text-label', 0)).toBe('12px');
    expect(dropdown).toMatch(/DropdownMenuItem[\s\S]*MENU_ITEM_GEOMETRY/);
    // the pre-#1281 numbers are gone from the primitive: py-1.5 + text-body made a 31.5px, 13px row
    expect(dropdown).not.toMatch(/px-2 py-1\.5 text-body/);
  });

  it('dropdown and popover both take min width, radius and shadow from the tokens and fix no width', () => {
    for (const src of [dropdown, popover]) {
      expect(src).toContain('min-w-[var(--menu-min-width)]');
      expect(src).toContain('rounded-[var(--radius-popover)]');
      expect(src).toContain('shadow-[var(--shadow-popover)]');
      expect(src).not.toMatch(/min-w-40|min-w-\[230px\]|[^-]w-\[230px\]|[^-]w-\[200px\]/);
    }
  });

  it('KEEPS callers that set their own width: the primitives fix none, so the w-* a caller passes still decides the width', () => {
    // a width is a min width only: nothing in the primitives uses a fixed `w-` that would override the one a caller passes
    expect(dropdown.match(/(^|\s)w-\S+/g)).toBeNull();
    expect(popover.match(/(^|[\s'])w-(?!auto)\S+/g)).toBeNull();
  });

  it('no DropdownMenuContent re-states a narrower min-w that would defeat the 200px floor', () => {
    const offenders: string[] = [];
    for (const f of walk(join(root, 'components')).concat(walk(join(root, 'app')))) {
      const s = readFileSync(f, 'utf8');
      for (const m of s.matchAll(/<DropdownMenuContent[^>]*className=["'{][^>]*min-w-[^>]*>/g)) offenders.push(`${f}: ${m[0]}`);
    }
    expect(offenders).toEqual([]);
  });

  it('every in-menu hand-rolled row in the views toolbar goes through the shared geometry, not its own 13px/py-1.5', () => {
    for (const f of ['components/views/view-toolbar.tsx', 'components/my-work/group-config.tsx']) {
      expect(read(f), f).not.toMatch(/rounded px-2 py-1\.5 text-body/);
    }
    // the select cell picker is a popover list, not a DropdownMenu, but its option rows are menu rows all the same
    expect(read('components/table-view/cells.tsx')).not.toMatch(/rounded px-2 py-1\.5 text-left text-body/);
    expect(read('components/table-view/cells.tsx')).toContain('MENU_ITEM_GEOMETRY');
  });
});
