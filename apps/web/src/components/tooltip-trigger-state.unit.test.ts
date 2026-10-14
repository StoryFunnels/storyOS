import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Ticket #922 — a menu trigger wrapped in <Tooltip> must not key its look off `data-state`.
 *
 * Observed in the browser: `<Tooltip><DropdownMenuTrigger asChild><button>` renders ONE element
 * that both Radix primitives write to, and the tooltip's `data-state="closed"` wins, so an open
 * dropdown's trigger reads `aria-expanded="true" data-state="closed"`. A `data-[state=open]:` class
 * there never matches; `aria-expanded:` does. Four triggers carried the dead selector, including
 * the sidebar row menu whose whole purpose was to keep the button visible while its menu was open.
 *
 * This is a source guard because there is no browser harness in this suite; the behaviour itself
 * was verified live (see the PR). It fails when a Tooltip-wrapped trigger uses `data-[state=…]`.
 */
function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.tsx')) out.push(p);
  }
  return out;
}

const TOOLTIP_TRIGGER = /<Tooltip\b[^>]*>\s*<DropdownMenuTrigger asChild>\s*<button[\s\S]*?<\/button>/g;

describe('Tooltip-wrapped menu triggers', () => {
  const files = walk(join(__dirname));
  const blocks = files.flatMap((f) => [...readFileSync(f, 'utf8').matchAll(TOOLTIP_TRIGGER)].map((m) => ({ f, text: m[0] })));

  it('the scan finds the pattern (otherwise the guard below proves nothing)', () => {
    expect(blocks.length).toBeGreaterThan(5);
  });

  it('none keys a class off data-state', () => {
    const bad = blocks.filter((b) => /data-\[state=/.test(b.text)).map((b) => b.f.replace(__dirname, ''));
    expect(bad).toEqual([]);
  });
});
