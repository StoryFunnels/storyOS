import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * #422 — the stacking scale is a checked artefact, not a convention.
 *
 * The bug: the filter builder's invisible full-screen close-backdrop sat at
 * z-40 and the relation picker it opened sat at z-30, so every click on an epic
 * hit the backdrop and closed the panel instead. Three symptoms — clicks
 * swallowed, no scrolling, hidden search box — one cause.
 *
 * A test that renders the picker passes today AND passed while the bug was
 * live, because the markup was never wrong; only the numbers were. Real hit
 * testing needs `elementFromPoint`, which needs layout, which needs a real
 * browser (jsdom does no layout and this repo has no jsdom — see
 * vitest.config.ts). So the assertions here are on the two properties that
 * actually decide the outcome and CAN be checked mechanically:
 *
 *   ORDERING   — a popover outranks anything that can open one.
 *   UNIQUENESS — no two document-level layers tie, so nothing is decided by
 *                DOM order. Both current ties (the mobile sidebar scrim and
 *                Tyron's thread menu, which sat exactly on the old popover
 *                layer) are resolved by construction.
 *
 * Plus a source sweep, because the failure mode is not "someone edits the
 * scale", it is "someone adds a fourth hardcoded number in a new file".
 */

const WEB_SRC = join(import.meta.dirname, '..', '..');
const CSS = readFileSync(join(WEB_SRC, 'app', 'globals.css'), 'utf8');

function scale(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const m of CSS.matchAll(/--(z-[a-z-]+):\s*(\d+);/g)) out[m[1]!] = Number(m[2]);
  return out;
}

function tsxFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return tsxFiles(p);
    return e.isFile() && (p.endsWith('.tsx') || p.endsWith('.ts')) && !p.includes('.test.') ? [p] : [];
  });
}

describe('#422 — the z-scale', () => {
  const z = scale();

  it('defines every layer the app actually uses', () => {
    // Guards the guard: a typo in the regex above would make every ordering
    // assertion below vacuously true over an empty object.
    expect(Object.keys(z).sort()).toEqual([
      'z-dialog',
      'z-dialog-backdrop',
      'z-drawer',
      'z-drawer-backdrop',
      'z-overlay',
      'z-overlay-backdrop',
      'z-palette',
      'z-popover',
      'z-sticky',
      'z-toast',
    ]);
  });

  it('puts a popover above ANYTHING that can open one — the rule the bug broke', () => {
    // Not "above the filter backdrop", which is the fix that would have been
    // found again next time. Above all of them.
    const openers = ['z-sticky', 'z-drawer', 'z-drawer-backdrop', 'z-overlay-backdrop', 'z-overlay', 'z-dialog-backdrop', 'z-dialog', 'z-palette'];
    for (const layer of openers) {
      expect(z['z-popover'], `a popover must outrank ${layer}`).toBeGreaterThan(z[layer]!);
    }
  });

  it('keeps the specific pair that caused #422 in the right order', () => {
    // The filter panel's close-backdrop vs the relation picker it opens.
    expect(z['z-popover']!).toBeGreaterThan(z['z-overlay-backdrop']!);
    // And above the panel body too — the picker overlapped the panel's top
    // ~37px, which is where its own search box lives.
    expect(z['z-popover']!).toBeGreaterThan(z['z-overlay']!);
  });

  it('closes the latent dialog trap #422 identified but could not trigger', () => {
    // DialogOverlay was z-40 and PopoverContent z-30, so the first dialog to
    // contain a date or relation picker would have hit this same bug in a
    // different file. Nothing renders that combination today; this is what
    // stops it being discovered the hard way later.
    expect(z['z-popover']!).toBeGreaterThan(z['z-dialog']!);
    expect(z['z-popover']!).toBeGreaterThan(z['z-dialog-backdrop']!);
  });

  it('pairs every backdrop directly beneath the thing it belongs to', () => {
    expect(z['z-overlay-backdrop']!).toBeLessThan(z['z-overlay']!);
    expect(z['z-dialog-backdrop']!).toBeLessThan(z['z-dialog']!);
    expect(z['z-drawer-backdrop']!).toBeLessThan(z['z-drawer']!);
  });

  it('gives every layer a DISTINCT value, so nothing depends on DOM order', () => {
    const values = Object.values(z);
    expect(new Set(values).size, `duplicate layer values: ${values.join(', ')}`).toBe(values.length);
  });

  it('puts toasts on top — they report on what you just did to the layer below', () => {
    expect(z['z-toast']!).toBeGreaterThan(z['z-popover']!);
  });
});

describe('#422 — no fourth hardcoded copy', () => {
  it('has no raw z-index on any full-screen (document-level) overlay', () => {
    /*
     * The real failure mode. #422 is the third time this exact shape has been
     * fixed one number at a time (#276 portalled the picker; #375/#399/#408 are
     * the same one-concept-many-copies family), so the scale only helps if the
     * next `fixed inset-0` cannot quietly opt out of it.
     */
    const offenders: string[] = [];
    for (const file of tsxFiles(WEB_SRC)) {
      const src = readFileSync(file, 'utf8');
      for (const m of src.matchAll(/fixed inset-0[^"'`]*?\bz-(\d+)\b/g)) {
        offenders.push(`${file.replace(WEB_SRC, 'src')}: z-${m[1]}`);
      }
    }
    expect(
      offenders,
      `Use a scale token (z-[var(--z-overlay-backdrop)] etc.) — see the block in globals.css:\n  ${offenders.join('\n  ')}\n`,
    ).toEqual([]);
  });
});
