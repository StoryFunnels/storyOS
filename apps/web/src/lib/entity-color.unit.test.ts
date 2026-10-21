import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { OPTION_COLORS } from '@/components/table-view/option-colors';
import {
  DEFAULT_ENTITY_COLORS,
  DEFAULT_ENTITY_PALETTE,
  databaseColor,
  defaultEntityColor,
  entityColor,
  hashId,
  isEntityToken,
} from './entity-color';

function uuid(n: number): string {
  // A spread of v4-shaped ids, deterministic so the test cannot flake.
  let x = n * 2654435761;
  const hex = (len: number) => {
    let s = '';
    for (let i = 0; i < len; i++) {
      x = (Math.imul(x, 1103515245) + 12345) >>> 0;
      s += (x >>> 16 & 15).toString(16);
    }
    return s;
  };
  return `${hex(8)}-${hex(4)}-4${hex(3)}-a${hex(3)}-${hex(12)}`;
}

describe('defaultEntityColor (#1001): a stable colour from the id', () => {
  it('is the same colour for the same id, every time', () => {
    for (let i = 0; i < 50; i++) expect(defaultEntityColor(uuid(i))).toBe(defaultEntityColor(uuid(i)));
  });

  it('pins known ids, so a change to the hash cannot go unnoticed (it would recolour every workspace)', () => {
    // Index = hashId % 8 into the palette order; the server's backfill (#1016) uses the same hash and order.
    expect(defaultEntityColor('80b45166-9b95-41f1-b237-97a6e9ef5ffd')).toBe('c6');
    expect(defaultEntityColor('549b4ab9-17ce-46de-bdf7-56eab5c105b5')).toBe('c2');
    expect(defaultEntityColor('1392ae95-d35d-40a2-87aa-14005700d7d4')).toBe('c1');
    expect(hashId('')).toBe(0x811c9dc5);
  });

  it('reaches all eight colours, and no one of them takes more than a quarter of 400 ids', () => {
    const counts = new Map<string, number>();
    for (let i = 0; i < 400; i++) counts.set(defaultEntityColor(uuid(i)), (counts.get(defaultEntityColor(uuid(i))) ?? 0) + 1);
    expect([...counts.keys()].sort()).toEqual([...DEFAULT_ENTITY_COLORS].sort());
    for (const [color, n] of counts) expect(n, color).toBeLessThan(100);
  });

  it('each default token corresponds to a picker palette name, never grey (what the server backfill stores)', () => {
    expect(DEFAULT_ENTITY_PALETTE.map((p) => p.token)).toEqual(['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'c8']);
    for (const { name } of DEFAULT_ENTITY_PALETTE) {
      expect(OPTION_COLORS[name], name).toBeTruthy();
      expect(name).not.toBe('gray');
    }
    expect(new Set(DEFAULT_ENTITY_PALETTE.map((p) => p.name)).size).toBe(8);
  });
});

describe('databaseColor: a set colour wins, a missing one falls back', () => {
  it('resolves a default token to a theme-aware variable and a chosen name to its fixed palette hex', () => {
    expect(isEntityToken('c3')).toBe(true);
    expect(isEntityToken('c9')).toBe(false);
    expect(isEntityToken('blue')).toBe(false);
    expect(entityColor('c3')).toBe('var(--c3)');
    expect(entityColor('blue')).toBe(OPTION_COLORS.blue);
    expect(entityColor(null)).toBeUndefined();
  });
  it('keeps the colour a person chose', () => {
    expect(databaseColor('purple', 'any-id')).toBe('purple');
    expect(databaseColor('gray', 'any-id')).toBe('gray'); // an explicit grey is a choice
  });
  it('falls back to the default when nothing is set or the name is not a palette entry', () => {
    const id = '80b45166-9b95-41f1-b237-97a6e9ef5ffd';
    expect(databaseColor(null, id)).toBe(defaultEntityColor(id));
    expect(databaseColor(undefined, id)).toBe(defaultEntityColor(id));
    expect(databaseColor('', id)).toBe(defaultEntityColor(id));
    expect(databaseColor('not-a-colour', id)).toBe(defaultEntityColor(id));
  });
  it('is null only when there is no id to derive from', () => {
    expect(databaseColor(null, null)).toBeNull();
    expect(databaseColor(undefined, undefined)).toBeNull();
  });
});

describe('contrast: every default token is a legible glyph on both sidebars, in both themes (#1001 AC4)', () => {
  const css = readFileSync(join(import.meta.dirname, '..', 'app', 'globals.css'), 'utf8');
  const block = (selector: string): string => {
    const open = css.indexOf('{', css.indexOf(selector));
    let depth = 0;
    for (let i = open; i < css.length; i++) {
      if (css[i] === '{') depth++;
      if (css[i] === '}' && --depth === 0) return css.slice(open, i);
    }
    throw new Error(selector);
  };
  const light = block(':root {');
  const dark = block(":root[data-theme='dark']");
  const hexOf = (b: string, name: string): string => {
    const m = new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})`).exec(b);
    if (m) return m[1]!;
    if (b !== light) return hexOf(light, name);
    throw new Error(`${name} missing`);
  };
  const lum = (hex: string) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
    const f = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
    return 0.2126 * f(r!) + 0.7152 * f(g!) + 0.0722 * f(b!);
  };
  const ratio = (a: string, b: string) => {
    const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
    return (hi! + 0.05) / (lo! + 0.05);
  };
  it.each([
    ['light', light],
    ['dark', dark],
  ])('%s: --c1..--c8 are declared and clear 3:1 on the sidebar and the frame', (_name, theme) => {
    for (const token of DEFAULT_ENTITY_COLORS) {
      for (const bg of ['--bg-sidebar', '--bg-frame']) {
        expect(ratio(hexOf(theme, `--${token}`), hexOf(theme, bg)), `${token} on ${bg}`).toBeGreaterThanOrEqual(3);
      }
    }
  });
  it('dark uses the prototype’s dark set, not the light values', () => {
    for (const token of DEFAULT_ENTITY_COLORS) expect(hexOf(dark, `--${token}`)).not.toBe(hexOf(light, `--${token}`));
  });
});

describe('no surface reads a database colour raw (#1001 AC1)', () => {
  // The bug returns the day someone draws a database glyph straight from `.color`. Sweep the places that draw one.
  const WEB_SRC = join(import.meta.dirname, '..');
  const files = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = join(dir, e.name);
      return e.isDirectory() ? files(p) : /\.tsx$/.test(p) && !/\.test\./.test(p) ? [p] : [];
    });
  const offenders: string[] = [];
  for (const file of files(WEB_SRC)) {
    const src = readFileSync(file, 'utf8');
    src.split('\n').forEach((line, i) => {
      // A database glyph: EntityIcon / EntityIconChip / DbMarker / DbColorMarker handed a database's colour directly.
      // `DbMarker` resolves the default itself when handed the database's `id`, so that form is the correct one.
      if (/<(EntityIcon|EntityIconChip|DbMarker|DbColorMarker)\b/.test(line) && !/\bid=\{/.test(line) && /color=\{(?:\w+\.)*(?:database|db|d|hit|center|s\.database|g\.database)\??\.(?:data\??\.)?color\b/.test(line)) {
        offenders.push(`${file.replace(WEB_SRC, 'src')}:${i + 1}: ${line.trim()}`);
      }
    });
  }
  it('has no database glyph given `<db>.color` directly', () => {
    expect(offenders, `Use databaseColor(<db>.color, <db>.id):\n  ${offenders.join('\n  ')}`).toEqual([]);
  });
});

describe('no surface throws away a colour it was given (#1001, Vera’s review of PR 1207)', () => {
  // `databaseColor(null, id)` ignores the database's stored colour and draws the id's DEFAULT, so a surface using it shows a
  // different colour from the sidebar for the same database. The search and recents endpoints return `database_color`.
  const WEB_SRC = join(import.meta.dirname, '..');
  const files = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = join(dir, e.name);
      return e.isDirectory() ? files(p) : /\.tsx$/.test(p) && !/\.test\./.test(p) ? [p] : [];
    });
  it('never calls databaseColor(null, …) when a colour could be passed', () => {
    const offenders = files(WEB_SRC).filter((f) => /databaseColor\(\s*null\s*,/.test(readFileSync(f, 'utf8')));
    expect(offenders.map((f) => f.replace(WEB_SRC, 'src'))).toEqual([]);
  });
});

