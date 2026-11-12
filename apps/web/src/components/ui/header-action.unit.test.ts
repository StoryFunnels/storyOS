import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HEADER_ACTION_BOX, HEADER_ACTION_MIN_PX, HEADER_ADD_BUTTON, HEADER_MENU_TRIGGER } from './header-action';

const src = (rel: string) => readFileSync(join(__dirname, '..', '..', rel), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');

/** Tailwind's default scale: `h-6` is 6 x 4 = 24px. Only the integer scale is used for a header action. */
const px = (cls: string, axis: 'h' | 'w') => {
  const m = new RegExp(`(?:^| )${axis}-(\\d+(?:\\.\\d+)?)(?: |$)`).exec(cls);
  return m ? Number(m[1]) * 4 : null;
};

describe('header actions meet WCAG 2.5.8 (#1225)', () => {
  it('the shared box is at least 24 x 24 px', () => {
    expect(px(HEADER_ACTION_BOX, 'h')).toBeGreaterThanOrEqual(HEADER_ACTION_MIN_PX);
    expect(px(HEADER_ACTION_BOX, 'w')).toBeGreaterThanOrEqual(HEADER_ACTION_MIN_PX);
  });
  it('the ⋯ trigger and the + both take that box', () => {
    expect(HEADER_MENU_TRIGGER.startsWith(HEADER_ACTION_BOX)).toBe(true);
    expect(HEADER_ADD_BUTTON.startsWith(HEADER_ACTION_BOX)).toBe(true);
  });
  it('the ⋯ keeps its resting --faint and the hover / focus / open darkening (#900: never hover-only)', () => {
    expect(HEADER_MENU_TRIGGER).toMatch(/\btext-faint\b/);
    expect(HEADER_MENU_TRIGGER).toMatch(/hover:text-ink/);
    expect(HEADER_MENU_TRIGGER).toMatch(/focus-visible:text-ink/);
    expect(HEADER_MENU_TRIGGER).toMatch(/aria-expanded:text-ink/);
  });
  it('the box lifts its extra 2px out of the layout so a header row does not grow', () => {
    expect(HEADER_ACTION_BOX).toMatch(/(^| )-my-0\.5( |$)/);
  });
  it('the table header and the board column both render the ⋯ from the shared constant, with no size of their own', () => {
    for (const f of ['components/table-view/header-cell.tsx', 'components/views/board-view.tsx']) {
      const code = src(f);
      expect(code).toContain('className={HEADER_MENU_TRIGGER}');
      expect(code).toMatch(/from '@\/components\/ui\/header-action'/);
    }
    // The board's + beside it takes the same box, so the two 24px areas sit side by side without overlapping.
    expect(src('components/views/board-view.tsx')).toMatch(/className=\{HEADER_ADD_BUTTON\} title="Add card"/);
  });
});
