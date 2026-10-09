import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EMBED_FONT_VAR } from './embed-fonts';

/**
 * #797 — the web build must make NO third-party font request.
 *
 * `next/font/google` fetched seven families from Google's CDN on every build; the
 * build was non-deterministic by construction (a different family failed each time,
 * lockfile identical, on PRs that touched no font) and ejected a PR from the merge
 * queue. The fonts are now vendored under app/fonts. This fails if anything puts
 * the network back, or if a font the app offers loses its face.
 */
const src = fileURLToPath(new URL('..', import.meta.url));
const fontsDir = join(src, 'app/fonts');
const css = readFileSync(join(fontsDir, 'fonts.css'), 'utf8');

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const n of readdirSync(dir)) {
    const f = join(dir, n);
    if (statSync(f).isDirectory()) out.push(...sources(f));
    else if (/\.(tsx?|css)$/.test(n) && !/\.test\./.test(n)) out.push(f);
  }
  return out;
}
const strip = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

describe('no font is fetched from the network (#797)', () => {
  it('nothing in src imports next/font/google', () => {
    const offenders = sources(src).filter((f) => /next\/font\/google/.test(strip(readFileSync(f, 'utf8'))));
    expect(offenders, 'next/font/google makes a build-time call to Google; vendor the file under app/fonts instead').toEqual([]);
  });

  it('nothing references a font CDN URL', () => {
    const offenders = sources(src).filter((f) => /fonts\.(googleapis|gstatic)\.com/.test(strip(readFileSync(f, 'utf8'))));
    expect(offenders).toEqual([]);
  });

  it('every @font-face src is a vendored file that exists', () => {
    const urls = [...css.matchAll(/url\('\.\/([^']+)'\)/g)].map((m) => m[1]!);
    expect(urls.length).toBeGreaterThan(20);
    for (const u of urls) expect(existsSync(join(fontsDir, u)), `fonts.css points at ${u}, which is missing`).toBe(true);
    expect(css).not.toMatch(/url\(\s*['"]?https?:/);
  });

  it('keeps unicode-range on every face, so a page still downloads only the subsets it uses', () => {
    const faces = css.match(/@font-face\s*\{[^}]*font-weight[^}]*\}/g) ?? [];
    expect(faces.length).toBeGreaterThan(20);
    for (const f of faces) expect(f, f.slice(0, 80)).toMatch(/unicode-range:/);
  });
});

describe('every font the app offers has a vendored face and its variable (#797)', () => {
  const FAMILY: Record<string, string> = {
    inter: 'Inter',
    figtree: 'Figtree',
    'source-sans-3': 'Source Sans 3',
    'dm-sans': 'DM Sans',
    'source-serif-4': 'Source Serif 4',
    'playfair-display': 'Playfair Display',
    'jetbrains-mono': 'JetBrains Mono',
  };
  for (const [key, cssVar] of Object.entries(EMBED_FONT_VAR)) {
    it(`${key}: a face for "${FAMILY[key]}" and ${cssVar} defined`, () => {
      expect(FAMILY[key], `add ${key} to this test's FAMILY map and to fonts.css`).toBeDefined();
      expect(css).toContain(`font-family: '${FAMILY[key]}';`);
      expect(css).toMatch(new RegExp(`${cssVar}:\\s*'${FAMILY[key]}'`));
    });
  }
  it('keeps a Latin face for every family (the subset every page needs)', () => {
    for (const fam of Object.values(FAMILY)) {
      const slug = fam.toLowerCase().replace(/ /g, '-');
      expect(existsSync(join(fontsDir, `${slug}-latin.woff2`)), `${slug}-latin.woff2`).toBe(true);
    }
  });
});
