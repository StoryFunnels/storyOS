import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Ticket #1196 — Ievgen's ruling on the first design of the hire card ("bad design" on the native time picker): NO native select
 * or time/date/datalist control anywhere on the card; every choice is the product's own menu (`MenuSelect`, `Popover`). A guard
 * on the three files that make up the card, so a native control cannot come back in one of them without a failing test.
 * (This reads source on purpose: the claim is "these files draw no native picker", which is what source can say; the live check
 * is recorded on the PR.)
 */
const FILES = ['hire-dialog.tsx', 'wake-rules-editor.tsx', 'works-in-picker.tsx'];
const read = (f: string) => readFileSync(join(__dirname, f), 'utf8');

describe('the hire card draws no native picker', () => {
  for (const f of FILES) {
    it(`${f}: no <select>, <datalist>, or time/date input`, () => {
      const src = read(f);
      expect(src).not.toMatch(/<select[\s>]/);
      expect(src).not.toMatch(/<datalist/);
      expect(src).not.toMatch(/type=["'](time|date|datetime-local|month|week)["']/);
    });
  }
  it('the rules editor builds every choice from the shared MenuSelect', () => {
    const src = read('wake-rules-editor.tsx');
    expect(src).toContain("from '@/components/ui/menu-select'");
    expect(src.match(/<MenuSelect/g)!.length).toBeGreaterThanOrEqual(7);
  });
  it('the Works in list is clickable inside the modal hire dialog: its portalled content re-enables pointer events (found live: without it a click fell through onto the checkbox beneath)', () => {
    expect(read('works-in-picker.tsx')).toMatch(/<PopoverContent[^>]*pointer-events-auto/);
  });
  it('the only native inputs are the two the product already uses everywhere: a text field and a checkbox', () => {
    for (const f of FILES) {
      for (const m of read(f).matchAll(/<input[^>]*?type="([a-z]+)"/g)) expect(['checkbox'], `${f}: ${m[1]}`).toContain(m[1]);
    }
  });
});
