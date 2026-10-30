import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * #1168 — `var(--x, #fff)` with `--x` declared nowhere renders the fallback in EVERY theme and nothing fails: the
 * Tyron buttons wore white on gold (2.38:1 / 2.03:1) that way. A fallback hides a missing declaration, so a use that
 * carries a fallback must name a token globals.css declares. (Plain `var(--x)` with no fallback is not scanned here: an
 * undeclared one renders visibly unset.)
 */
const srcRoot = join(__dirname, '..');
const css = readFileSync(join(srcRoot, 'app', 'globals.css'), 'utf8');

function declaredTokens(source: string): Set<string> {
  return new Set([...source.matchAll(/(--[a-zA-Z0-9_-]+)['"]?\s*:/g)].map((m) => m[1]!));
}

/** `var(--name,` occurrences, i.e. uses WITH a fallback. */
function fallbackUses(source: string): string[] {
  return [...source.matchAll(/var\(\s*(--[a-zA-Z0-9_-]+)\s*,/g)].map((m) => m[1]!);
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(tsx?|css)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

/**
 * Shrink-only allowlist of known violations, as `file: --token`. #1170 declared the last two it ever held
 * (--radius-pill, --warning-soft), so it is EMPTY: the mechanism stays (an entry must name a real, current violation or
 * the stale-entry test fails) but nothing may be added without saying why here.
 */
const KNOWN_UNDECLARED = new Set<string>();

describe('var(--token, fallback) must name a declared token', () => {
  const files = walk(srcRoot);
  // "Declared" = in globals.css, or set anywhere in src (a component may set a custom property inline, e.g. --block-w).
  const declared = declaredTokens(css);
  for (const f of files) for (const t of declaredTokens(readFileSync(f, 'utf8'))) declared.add(t);
  const bad: string[] = [];
  let uses = 0;
  for (const f of files) {
    for (const name of fallbackUses(readFileSync(f, 'utf8'))) {
      uses++;
      if (!declared.has(name)) bad.push(`${f.slice(srcRoot.length + 1)}: ${name}`);
    }
  }

  it('scans a real population (a scan that matches nothing proves nothing)', () => {
    expect(files.length).toBeGreaterThan(100);
    expect(uses).toBeGreaterThan(5);
  });

  it('no NEW fallback hides an undeclared token', () => {
    expect(bad.filter((b) => !KNOWN_UNDECLARED.has(b))).toEqual([]);
  });

  it('the known-undeclared list has no stale entries', () => {
    expect([...KNOWN_UNDECLARED].filter((k) => !bad.includes(k))).toEqual([]);
  });

  it('the scanner itself flags an undeclared token and passes a declared one', () => {
    const d = declaredTokens(':root { --a: #fff; }');
    expect(fallbackUses('color: var(--a, #000); x: var(--on-accent,#fff)').filter((n) => !d.has(n))).toEqual([
      '--on-accent',
    ]);
  });
});

describe('text-on-fill tokens clear AA (4.5:1) in both themes', () => {
  const block = (selector: string): string => {
    const open = css.indexOf('{', css.indexOf(selector));
    let depth = 0;
    for (let i = open; i < css.length; i++) {
      if (css[i] === '{') depth++;
      if (css[i] === '}' && --depth === 0) return css.slice(open, i);
    }
    throw new Error(`no block for ${selector}`);
  };
  const light = block(':root {');
  const dark = block(":root[data-theme='dark']");
  const token = (b: string, name: string): string => {
    const m = new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})`).exec(b);
    if (m) return m[1]!;
    if (b !== light) return token(light, name);
    throw new Error(`${name} not found`);
  };
  const lum = (hex: string): number => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as [number, number, number];
    const f = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const ratio = (a: string, b: string): number => {
    const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x) as [number, number];
    return (hi + 0.05) / (lo + 0.05);
  };

  describe.each([
    ['light', light],
    ['dark', dark],
  ])('%s', (_n, theme) => {
    it('--text-on-accent on --accent (gold)', () => {
      expect(ratio(token(theme, '--text-on-accent'), token(theme, '--accent'))).toBeGreaterThanOrEqual(4.5);
    });
    it('--text-on-error on --error', () => {
      expect(ratio(token(theme, '--text-on-error'), token(theme, '--error'))).toBeGreaterThanOrEqual(4.5);
    });
  });
});

/**
 * #1170 (Otto's ruling) — --text-on-error is the text colour for EVERY solid --error fill. White passes on the light
 * --error (5.44:1) and fails on the lifted dark one (3.13:1), which is why the token exists. The population is derived
 * from the source: every string literal (a class list, one ternary branch) that carries a SOLID error fill.
 */
const SOLID_ERROR_FILL = /(?:^|[\s:])(?:[a-z-]+:)*bg-error(?![\w/-])/;
const WHITE_TEXT =
  /(?:^|[\s:])(?:[a-z-]+:)*text-(?:white|on-dark|\[(?:#fff(?:fff)?|white|var\(--text-on-dark\))\])(?![\w-])/;

/**
 * Text between quote characters. Deliberately NOT a literal parser: an apostrophe in a comment would throw a real parser
 * off for the rest of the file. Splitting on every quote only ever cuts a literal into sub-pieces, never merges two, so
 * a class list is never missed; the cost is that code between literals is scanned too, which cannot hold both tokens.
 */
function stringLiterals(source: string): string[] {
  return source.split(/['"`]/);
}

/** String literals pairing a solid red fill with white text, as `file: <literal>`. */
function whiteOnError(file: string, source: string): string[] {
  return stringLiterals(source)
    .filter((l) => SOLID_ERROR_FILL.test(l) && WHITE_TEXT.test(l))
    .map((l) => `${file}: ${l.replace(/\s+/g, ' ').trim()}`);
}

describe('a solid --error fill never wears white text (use --text-on-error)', () => {
  const files = walk(srcRoot);
  const bad = files.flatMap((f) => whiteOnError(f.slice(srcRoot.length + 1), readFileSync(f, 'utf8')));
  const withFill = files.filter((f) => stringLiterals(readFileSync(f, 'utf8')).some((l) => SOLID_ERROR_FILL.test(l)));

  it('scans a real population (the destructive Button and the sidebar confirm carry bg-error)', () => {
    expect(withFill.map((f) => f.slice(srcRoot.length + 1))).toEqual(
      expect.arrayContaining(['components/ui/button.tsx', 'components/sidebar.tsx']),
    );
  });

  it('no solid error fill pairs with white text', () => {
    expect(bad).toEqual([]);
  });

  it('the scanner flags each white spelling and passes the token, a tint and an opacity fill', () => {
    const f = (c: string) => whiteOnError('x', `const a = '${c}';`).length;
    expect(f('bg-error text-white')).toBe(1);
    expect(f('hover:bg-error hover:text-white')).toBe(1);
    expect(f('bg-error text-[var(--text-on-dark)]')).toBe(1);
    expect(f('bg-error text-[#fff]')).toBe(1);
    expect(f('bg-error text-[var(--text-on-error)]')).toBe(0);
    expect(f('bg-error/10 text-white')).toBe(0);
    expect(f('bg-ink text-white')).toBe(0);
    expect(f('bg-error-soft text-white')).toBe(0);
  });
});

describe('--warning-text clears AA on the --warning-soft tint, both themes (#1170)', () => {
  const rgb = (hex: string): [number, number, number] =>
    [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
  const mix = (fill: string, over: string, pct: number): string =>
    '#' +
    rgb(fill)
      .map((v, i) =>
        Math.round((v * pct) / 100 + rgb(over)[i]! * (1 - pct / 100))
          .toString(16)
          .padStart(2, '0'),
      )
      .join('');
  const lum = (hex: string): number => {
    const f = (v: number) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
    const [r, g, b] = rgb(hex);
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const ratio = (a: string, b: string): number => {
    const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x) as [number, number];
    return (hi + 0.05) / (lo + 0.05);
  };
  const darkAt = css.indexOf(":root[data-theme='dark']");
  const themes: [string, string][] = [
    ['light', css.slice(0, darkAt)],
    ['dark', css.slice(darkAt)],
  ];
  const tok = (scope: string, name: string): string =>
    new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})`).exec(scope)![1]!;

  it.each(themes)('%s: --warning-soft is 14 percent of --warning over --bg-card and the text clears 4.5:1', (_n, scope) => {
    expect(scope).toMatch(/--warning-soft:\s*color-mix\(in srgb, var\(--warning\) 14%, var\(--bg-card\)\)/);
    const soft = mix(tok(scope, '--warning'), tok(scope, '--bg-card'), 14);
    expect(ratio(tok(scope, '--warning-text'), soft)).toBeGreaterThanOrEqual(4.5);
  });

  it('the light tint also clears 4.5:1 over --bg-app', () => {
    const scope = themes[0]![1];
    const soft = mix(tok(scope, '--warning'), tok(scope, '--bg-app'), 14);
    expect(ratio(tok(scope, '--warning-text'), soft)).toBeGreaterThanOrEqual(4.5);
  });

  it('--radius-pill is declared as a full pill', () => {
    expect(css).toMatch(/--radius-pill:\s*9999px/);
  });
});
