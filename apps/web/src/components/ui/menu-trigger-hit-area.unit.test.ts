import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HIT_AREA_24, HEADER_ACTION_MIN_PX } from './header-action';

/**
 * #1225 — every ⋯ menu trigger in the web app is at least 24 x 24 CSS px (WCAG 2.5.8), either because its own box is, or because it
 * carries HIT_AREA_24 (an invisible 24px `::before`, so the VISIBLE size and the layout are unchanged).
 *
 * The set is derived, not listed: every `<button>` in src that contains the ⋯ glyph (`<MoreHorizontal`, `<MoreVertical`,
 * `<Ellipsis`, or a literal "⋯"). A new ⋯ anywhere is covered the day it is written. Sizes come from the button's own classes
 * plus the classes of any constant it names (`ROW_ICON_BTN`, `SPACE_ACT`, `HEADER_MENU_TRIGGER`, ...), resolved from source.
 * Responsive variants (`max-md:h-11`) are ignored: the floor is the base box.
 */
const SRC = join(__dirname, '..', '..');
/** Comments blanked, not removed, so a line number in a failure message is the file's own line. */
const blank = (m: string) => m.replace(/[^\n]/g, ' ');
const strip = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/(^|[^:'"`\\])(\/\/[^\n]*)/g, (_m, pre: string, c: string) => pre + blank(c));
const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));
const files = walk(SRC).filter((f) => /\.tsx?$/.test(f) && !/\.(unit\.)?test\.|\/test\//.test(f));
const code = new Map(files.map((f) => [f, strip(readFileSync(f, 'utf8'))] as const));

/** `const NAME = <rhs>` anywhere in src, so a constant named in a className resolves to its classes. */
const defs = new Map<string, string>();
for (const text of code.values()) for (const m of text.matchAll(/(?:export )?const ([A-Z][A-Z0-9_]+)\s*=\s*((?:`[^`]*`|'[^']*'|"[^"]*"|[^;\n])+)/g)) defs.set(m[1]!, m[2]!);
const classSoup = (text: string, depth = 0): string => {
  const names = depth > 3 ? [] : [...new Set(text.match(/\b[A-Z][A-Z0-9_]{3,}\b/g) ?? [])].filter((n) => defs.has(n));
  return text + ' ' + names.map((n) => classSoup(defs.get(n)!, depth + 1)).join(' ');
};

const GLYPH = /<(?:MoreHorizontal|MoreVertical|Ellipsis|EllipsisVertical)\b|>\s*⋯\s*</g;
type Trigger = { where: string; w: number; h: number; hit: boolean };

function size(tokens: string[], axis: 'h' | 'w' | 'x' | 'y'): number | null {
  const base = tokens.filter((t) => !t.includes(':'));
  const find = (re: RegExp) => {
    for (const t of base) {
      const m = re.exec(t);
      if (m) return m[1]!.endsWith(']') ? parseFloat(m[1]!.slice(1)) : parseFloat(m[1]!) * 4;
    }
    return null;
  };
  const n = String.raw`(\d+(?:\.\d+)?|\[\d+(?:\.\d+)?px\])`;
  if (axis === 'h' || axis === 'w') return find(new RegExp(`^${axis}-${n}$`));
  return find(new RegExp(`^p${axis}-${n}$`)) ?? find(new RegExp(`^p-${n}$`)) ?? 0;
}

const triggers: Trigger[] = [];
for (const [f, text] of code) {
  for (const m of text.matchAll(GLYPH)) {
    const before = text.slice(0, m.index);
    const open = before.lastIndexOf('<button');
    if (open < 0 || before.slice(open).includes('</button>')) continue; // a glyph that is not inside a <button>
    const soup = classSoup(text.slice(open, m.index));
    const tokens = [...soup.matchAll(/[\w\-[\]:.%/]+/g)].map((t) => t[0]);
    const icon = /<(?:MoreHorizontal|MoreVertical|Ellipsis|EllipsisVertical)[^>]*?className="[^"]*?\bh-(\d+(?:\.\d+)?)/.exec(text.slice(m.index!, m.index! + 200));
    const iconPx = icon ? Number(icon[1]) * 4 : 16;
    const w = size(tokens, 'w') ?? iconPx + 2 * (size(tokens, 'x') ?? 0);
    const h = size(tokens, 'h') ?? iconPx + 2 * (size(tokens, 'y') ?? 0);
    const hit = /\bbefore:h-6\b/.test(soup) && /\bbefore:w-6\b/.test(soup) && /\bbefore:absolute\b/.test(soup);
    triggers.push({ where: `${relative(SRC, f)}:${before.split('\n').length}`, w, h, hit });
  }
}

describe('every ⋯ menu trigger reaches 24 x 24 px (#1225)', () => {
  it('finds the real set: the surfaces the ticket names are in it', () => {
    const where = triggers.map((t) => t.where.split(':')[0]);
    for (const f of ['components/table-view/header-cell.tsx', 'components/views/board-view.tsx', 'components/my-work/my-work-rows.tsx', 'components/entity/long-text-block.tsx', 'components/entity/field-controls.tsx', 'components/sidebar-row-menu.tsx']) {
      expect(where, f).toContain(f);
    }
    expect(triggers.length).toBeGreaterThanOrEqual(12);
  });
  it('each is 24px by its own box or by HIT_AREA_24', () => {
    const short = triggers.filter((t) => !t.hit && (t.w < HEADER_ACTION_MIN_PX || t.h < HEADER_ACTION_MIN_PX)).map((t) => `${t.where} is ${t.w} x ${t.h}`);
    expect(short).toEqual([]);
  });
  it('the measurer sees a short trigger as short (the guard is not vacuous)', () => {
    const measured = triggers.filter((t) => !t.hit && t.w >= 24 && t.h >= 24).length;
    expect(measured).toBeGreaterThan(0);
    expect(triggers.filter((t) => t.hit).length).toBeGreaterThanOrEqual(6);
  });
});

describe('HIT_AREA_24 grows the hit area and nothing else', () => {
  it('is a 24px absolutely-positioned pseudo-element centred on the button', () => {
    expect(HIT_AREA_24).toMatch(/\brelative\b/);
    expect(HIT_AREA_24).toMatch(/before:absolute/);
    expect(HIT_AREA_24).toMatch(/before:h-6/);
    expect(HIT_AREA_24).toMatch(/before:w-6/);
    expect(HIT_AREA_24).toMatch(/before:left-1\/2/);
    expect(HIT_AREA_24).toMatch(/before:top-1\/2/);
  });
  it('carries no padding, margin or size of its own, so no row changes height or overflows', () => {
    expect(HIT_AREA_24.split(/\s+/).filter((c) => !c.startsWith('before:') && c !== 'relative')).toEqual([]);
  });
});
