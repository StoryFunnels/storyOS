import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { chipClass } from './toolbar-chip';

const code = (rel: string) => readFileSync(join(__dirname, rel), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');

describe('calendar navigation is drawn at the toolbar height (#1275 item 8)', () => {
  const cal = code('calendar-view.tsx');
  it('prev, next and Today use the toolbar chip class (26px, bordered), not a borderless ghost', () => {
    expect(chipClass()).toMatch(/\bh-\[26px\]/);
    expect(cal).toMatch(/cn\(chipClass\(\), CAL_NAV_ICON\)\} onClick=\{\(\) => shiftAnchor\(-1\)\}/);
    expect(cal).toMatch(/cn\(chipClass\(\), CAL_NAV_ICON\)\} onClick=\{\(\) => shiftAnchor\(1\)\}/);
    expect(cal).toMatch(/className=\{cn\(chipClass\(\), 'disabled:cursor-default/);
    expect(cal).not.toMatch(/rounded px-2 py-0\.5 text-label text-muted/);
  });
  it('the mode switch and the increment select share the 26px height', () => {
    expect(cal).toContain("const CAL_CONTROL_HEIGHT = 'h-[26px]'");
    expect(cal).toMatch(/className=\{CAL_CONTROL_HEIGHT\}/);
    expect(cal).toMatch(/text-ink-secondary', CAL_CONTROL_HEIGHT\)/);
  });
  it('KEEPS Today disabled (and explained) while the view already shows today (#808)', () => {
    expect(cal).toMatch(/disabled=\{showingToday\}/);
    expect(cal).toContain("title={showingToday ? 'Already showing today' : undefined}");
  });
  it('the icon-only buttons say what they are', () => {
    expect(cal).toContain('aria-label="Previous"');
    expect(cal).toContain('aria-label="Next"');
  });
});
