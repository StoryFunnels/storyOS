import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { FONT_SIZE_STEPS, cn } from './utils';

/**
 * #846 — keep `FONT_SIZE_STEPS` (lib/utils.ts) in step with globals.css, by a
 * test rather than a comment.
 *
 * tailwind-merge only knows a custom `text-*` step is a font SIZE if it is
 * declared; an undeclared one is read as a colour and deleted beside a colour
 * class. The comment asking for the list to be kept in step failed on the very
 * first step added after it (`--text-reading`, #792).
 *
 * THE TRAP: globals.css spells BOTH sizes and colours `--text-*`
 * (`--text-primary: #0f1729`, `--text-body: 13px`). Collecting every `--text-*`
 * would put colours in the font-size group and make tailwind-merge delete
 * COLOURS, the same bug with the sign flipped. So sizes are told apart from
 * colours BY VALUE: a step is a size only if its value is a length.
 */
const css = readFileSync(fileURLToPath(new URL('../app/globals.css', import.meta.url)), 'utf8');

/** `--text-<name>: <length>;` — a name, then a px/rem/em length. `--text-x--line-height`
 * (a double dash) and every colour (`#hex`, `rgb(...)`, `var(...)`) do not match. */
const SIZE_DECL = /--text-([a-z][a-z0-9]*):\s*(-?\d*\.?\d+)(?:px|rem|em)\s*;/g;
const ANY_TEXT_DECL = /--text-([a-z][a-z0-9]*):\s*([^;]+);/g;

function declared(re: RegExp): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of css.matchAll(re)) out.set(m[1]!, m[2]!.trim());
  return out;
}

const sizesInCss = [...declared(SIZE_DECL).keys()].sort();
const listed = [...FONT_SIZE_STEPS].sort();

describe('FONT_SIZE_STEPS matches the size steps in globals.css (#846)', () => {
  it('actually found the scale (an empty extraction must not pass)', () => {
    expect(sizesInCss.length).toBeGreaterThanOrEqual(6);
    expect(sizesInCss).toEqual(expect.arrayContaining(['micro', 'body', 'title']));
  });

  it('every size step in globals.css is in FONT_SIZE_STEPS', () => {
    const missing = sizesInCss.filter((s) => !listed.includes(s));
    expect(
      missing,
      `globals.css declares --text-${missing[0]} but it is not in FONT_SIZE_STEPS. Add '${missing[0]}' to apps/web/src/lib/utils.ts, or cn() will silently delete text-${missing[0]} beside any colour class.`,
    ).toEqual([]);
  });

  it('every entry in FONT_SIZE_STEPS is still a size step in globals.css', () => {
    const stale = listed.filter((s) => !sizesInCss.includes(s));
    expect(
      stale,
      `FONT_SIZE_STEPS lists '${stale[0]}' but globals.css no longer declares --text-${stale[0]} as a length. Remove it from apps/web/src/lib/utils.ts.`,
    ).toEqual([]);
  });

  it('colour tokens are NEVER treated as sizes: --text-primary / secondary / muted / faint stay out', () => {
    const colours = [...declared(ANY_TEXT_DECL).entries()]
      .filter(([, v]) => !/^-?\d*\.?\d+(px|rem|em)$/.test(v))
      .map(([k]) => k);
    expect(colours.length).toBeGreaterThanOrEqual(4); // proves the colour tokens were seen
    for (const c of colours) expect(listed, `colour token --text-${c} must not be a font-size step`).not.toContain(c);
    for (const c of ['primary', 'secondary', 'muted', 'faint']) expect(listed).not.toContain(c);
  });

  it('and behaviourally: every listed step survives a colour, while two colours still conflict', () => {
    for (const step of FONT_SIZE_STEPS) expect(cn(`text-${step}`, 'text-muted')).toBe(`text-${step} text-muted`);
    expect(cn('text-muted', 'text-faint')).toBe('text-faint'); // colours still override each other
  });
});
