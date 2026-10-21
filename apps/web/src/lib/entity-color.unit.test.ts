import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { OPTION_COLORS } from '@/components/table-view/option-colors';
import { DEFAULT_ENTITY_COLORS, databaseColor, defaultEntityColor, hashId } from './entity-color';

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
    expect(defaultEntityColor('80b45166-9b95-41f1-b237-97a6e9ef5ffd')).toBe('pink');
    expect(defaultEntityColor('549b4ab9-17ce-46de-bdf7-56eab5c105b5')).toBe('teal');
    expect(defaultEntityColor('1392ae95-d35d-40a2-87aa-14005700d7d4')).toBe('blue');
    expect(hashId('')).toBe(0x811c9dc5);
  });

  it('reaches all eight colours, and no one of them takes more than a quarter of 400 ids', () => {
    const counts = new Map<string, number>();
    for (let i = 0; i < 400; i++) counts.set(defaultEntityColor(uuid(i)), (counts.get(defaultEntityColor(uuid(i))) ?? 0) + 1);
    expect([...counts.keys()].sort()).toEqual([...DEFAULT_ENTITY_COLORS].sort());
    for (const [color, n] of counts) expect(n, color).toBeLessThan(100);
  });

  it('only ever names a colour the picker has, and never grey', () => {
    for (const name of DEFAULT_ENTITY_COLORS) {
      expect(OPTION_COLORS[name], name).toBeTruthy();
      expect(name).not.toBe('gray');
    }
  });
});

describe('databaseColor: a set colour wins, a missing one falls back', () => {
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

describe('contrast: every default is a legible glyph on both sidebars (#1001 AC4)', () => {
  const lum = (hex: string) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
    const f = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
    return 0.2126 * f(r!) + 0.7152 * f(g!) + 0.0722 * f(b!);
  };
  const ratio = (a: string, b: string) => {
    const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
    return (hi! + 0.05) / (lo! + 0.05);
  };
  it.each(['#f4efe5', '#0a0d12'])('3:1 against %s', (bg) => {
    for (const name of DEFAULT_ENTITY_COLORS) expect(ratio(OPTION_COLORS[name]!, bg), name).toBeGreaterThanOrEqual(3);
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
