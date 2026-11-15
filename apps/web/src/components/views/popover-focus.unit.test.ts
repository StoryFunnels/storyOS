import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { focusFirstIn } from './popover-focus';

/**
 * #1281 item 6 — Filter and Sort took no focus on open and had no role. Behaviour was also checked with real key presses in a
 * browser (recorded on the PR); these pin the parts a refactor could silently drop.
 */
const toolbar = readFileSync(join(__dirname, 'view-toolbar.tsx'), 'utf8');

const el = (name: string, onFocus: (n: string) => void) => ({ focus: () => onFocus(name) }) as unknown as HTMLElement;

describe('#1281 focusFirstIn', () => {
  it('focuses the first actionable control inside the panel', () => {
    const log: string[] = [];
    const panel = { focus: () => log.push('panel'), querySelector: () => el('first', (n) => log.push(n)) } as unknown as HTMLElement;
    focusFirstIn(panel);
    expect(log).toEqual(['first']);
  });
  it('falls back to the panel itself when it holds nothing focusable (so focus still moves in)', () => {
    const log: string[] = [];
    const panel = { focus: () => log.push('panel'), querySelector: () => null } as unknown as HTMLElement;
    focusFirstIn(panel);
    expect(log).toEqual(['panel']);
  });
  it('does nothing before the panel is mounted', () => {
    expect(() => focusFirstIn(null)).not.toThrow();
  });
});

describe('#1281 Filter and Sort panels', () => {
  it('both are named dialogs that take focus', () => {
    expect(toolbar).toMatch(/ref=\{filterPanelRef\} role="dialog" aria-label="Filter" tabIndex=\{-1\}/);
    expect(toolbar).toMatch(/ref=\{sortPanelRef\} role="dialog" aria-label=\{emptyLabel\} tabIndex=\{-1\}/);
    expect(toolbar).toContain('const filterPanelRef = usePopoverFocus(open)');
    expect(toolbar).toContain('const sortPanelRef = usePopoverFocus(open)');
  });
  it('Escape gives focus back to the button on BOTH, and still yields to a menu that claimed it', () => {
    expect(toolbar).toContain('filterButtonRef.current?.focus()');
    expect(toolbar).toContain('sortButtonRef.current?.focus()');
    expect(toolbar).toMatch(/e\.key !== 'Escape' \|\| e\.defaultPrevented/);
    expect(toolbar).toMatch(/e\.key === 'Escape' && !sortDrag\.activeId && !e\.defaultPrevented/);
  });
});
