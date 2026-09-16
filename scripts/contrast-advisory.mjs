#!/usr/bin/env node
/**
 * #722 — ADVISORY contrast report for CI. Reports; never fails the build.
 *
 * WHY THIS AND NOT docs/design/contrast-probe.js. That probe is a browser
 * console snippet by design — its own header explains that contrast depends on
 * COMPOSITED colour and that this repo has no browser harness. Confirmed still
 * true: no playwright or puppeteer in any package.json. Wiring it up would mean
 * booting web + api + a database, authenticating, and driving two themes, which
 * is a long way from this ticket's "scoped small on purpose".
 *
 * So this does the part that IS computable from source, and says plainly what
 * it cannot see:
 *
 *   (A) TOKEN PAIRS — every --text-* against every --bg-*, in both themes,
 *       parsed from globals.css. A token against a token needs no layout, so
 *       this is exact. It catches a token edited to a value that fails AA.
 *
 *   (B) NEW --text-faint SITES in the diff — the guard adopted by hand after
 *       PR #793 silently reverted five fixes by rewrapping lines someone else
 *       had changed. No test asserts a class name, so nothing else catches it.
 *
 * WHAT IT CANNOT SEE, stated rather than implied: composited/alpha contrast. A
 * chip at 13% alpha over an unknown ancestor cannot be resolved from source.
 * contrast-probe.js remains the tool for that, run by a human in a browser.
 */
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const CSS = 'apps/web/src/app/globals.css';
/** WCAG AA: 4.5 for body text, 3 for large text and non-text graphics. */
const AA_TEXT = 4.5;

const hexToRgb = (h) => {
  const s = h.replace('#', '');
  const f = s.length === 3 ? s.split('').map((c) => c + c).join('') : s;
  return [0, 2, 4].map((i) => parseInt(f.slice(i, i + 2), 16));
};
const lum = (rgb) =>
  0.2126 * ch(rgb[0]) + 0.7152 * ch(rgb[1]) + 0.0722 * ch(rgb[2]);
function ch(v) {
  const x = v / 255;
  return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
}
const ratio = (a, b) => {
  const [x, y] = [lum(hexToRgb(a)), lum(hexToRgb(b))];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};

/** Pull `--name: #hex;` declarations out of one CSS block. */
function tokensIn(block) {
  const out = {};
  for (const m of block.matchAll(/--([a-z0-9-]+)\s*:\s*(#[0-9a-fA-F]{3,8})\s*;/g)) {
    out[m[1]] = m[2];
  }
  return out;
}

/** The light block is bare `:root {`; dark is `:root[data-theme='dark'] {`. */
function themeBlocks(css) {
  const grab = (startRe) => {
    const m = css.match(startRe);
    if (!m) return '';
    const from = m.index + m[0].length;
    const end = css.indexOf('\n}', from);
    return css.slice(from, end === -1 ? undefined : end);
  };
  return {
    light: grab(/:root\s*,?[^{]*\{/),
    dark: grab(/:root\[data-theme='dark'\]\s*\{/),
  };
}

function report() {
  const css = readFileSync(CSS, 'utf8');
  const blocks = themeBlocks(css);
  const lightTokens = tokensIn(blocks.light);
  const rows = [];

  for (const [theme, block] of Object.entries(blocks)) {
    // Dark redeclares only what changes, so fall back to light for the rest.
    const t = theme === 'dark' ? { ...lightTokens, ...tokensIn(block) } : lightTokens;
    const texts = Object.keys(t).filter((k) => k.startsWith('text-') && k !== 'text-on-dark');
    const surfaces = Object.keys(t).filter((k) => k.startsWith('bg-'));
    for (const fg of texts) {
      for (const bg of surfaces) {
        const r = ratio(t[fg], t[bg]);
        rows.push({ theme, fg, bg, ratio: Math.round(r * 100) / 100, passesAA: r >= AA_TEXT });
      }
    }
  }
  return rows;
}

/** Added lines that introduce a faint class — new site, or a silent revert. */
function newFaintSites(base) {
  try {
    const diff = execSync(
      `git diff ${base}...HEAD -- 'apps/web/src/**/*.tsx' 'apps/web/src/**/*.ts'`,
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
    );
    let file = '';
    const hits = [];
    for (const line of diff.split('\n')) {
      if (line.startsWith('+++ b/')) file = line.slice(6);
      else if (line.startsWith('+') && !line.startsWith('+++') && /text-faint/.test(line)) {
        // A comment ABOUT the token is not a site — the trap that made
        // record-detail.tsx read as 6 sites when it has 5.
        if (/^\+\s*(\/\/|\*|\{\/\*)/.test(line)) continue;
        hits.push({ file, line: line.slice(1).trim().slice(0, 120) });
      }
    }
    return hits;
  } catch {
    return null; // no base ref (e.g. a shallow clone) — reported, not thrown
  }
}

const rows = report();
const failing = rows.filter((r) => !r.passesAA);

console.log('## Contrast advisory (#722) — report only, never fails the build\n');
console.log(`Token pairs checked: ${rows.length} across both themes.`);
console.log(`Pairs below AA ${AA_TEXT}:1 for body text: ${failing.length}\n`);
if (failing.length) {
  console.log('| theme | text token | surface | ratio |');
  console.log('|---|---|---|---|');
  for (const f of failing.sort((a, b) => a.ratio - b.ratio)) {
    console.log(`| ${f.theme} | --${f.fg} | --${f.bg} | ${f.ratio.toFixed(2)} |`);
  }
  console.log(
    '\n`--text-faint` is EXPECTED here: globals.css reserves it for genuinely\n' +
      'decorative text and non-text graphics, judged at 3:1 (#326, #706). Its\n' +
      'presence is not a defect; a NEW token appearing is.\n',
  );
}

const base = process.env.CONTRAST_BASE_REF || 'origin/main';
const hits = newFaintSites(base);
if (hits === null) {
  console.log(`\nDiff check skipped: could not read \`${base}\`.`);
} else {
  console.log(`\n### New \`--text-faint\` sites vs ${base}: ${hits.length}\n`);
  if (hits.length) {
    for (const h of hits) console.log(`- \`${h.file}\` — ${h.line}`);
    console.log(
      '\nEach is either a genuinely new faint site or a SILENT REVERT of an\n' +
        'earlier fix (PR #793 reverted five that way, by rewrapping lines against\n' +
        'stale text — no test and no click-through catches it). Check each against\n' +
        'the glyph-vs-prose rule in docs/design/design-system.md.',
    );
  }
}
console.log('\n_Composited/alpha contrast is NOT covered — it needs a real browser.\nUse docs/design/contrast-probe.js for that._');
