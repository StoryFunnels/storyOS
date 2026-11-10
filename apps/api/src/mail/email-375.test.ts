import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { EmailKind } from './email.types';
import { AUTOMATION_FIXTURE, EMAIL_FIXTURES } from './email-fixtures';

/**
 * Ticket #1267: every branded email must fit a 375px phone without scrolling
 * sideways (it measured scrollWidth 512 there).
 *
 * HOW THIS IS CHECKED: two layers. (1) A deterministic STATIC check of the rendered HTML for the
 * specific constructs that cause horizontal overflow (runs everywhere, no browser needed). (2) A real
 * measurement in headless Chrome (a 375px iframe, `documentElement.scrollWidth`), which RUNS IN CI too:
 * the GitHub-hosted ubuntu runners ship google-chrome at /usr/bin/google-chrome, and a developer machine
 * is covered by the macOS path or CHROME_BIN. The browser assertion is `scrollWidth <= 375` (the AC is
 * "does not overflow", not "is exactly 375": a scrollbar in the frame can make it narrower, e.g. 360).
 * To repeat the measurement by hand, run this file with EMAIL_DUMP_DIR=<dir> and load the files written there.
 */
const VIEWPORT = 375;
const KINDS = [...readFileSync(join(__dirname, 'email.types.ts'), 'utf8').matchAll(/kind: '([a-z-]+)'/g)].map((m) => m[1] as EmailKind);

/** Every pixel width an element declares, via a width attribute or a width/min-width style. */
function pixelWidths(html: string): { what: string; px: number }[] {
  const out: { what: string; px: number }[] = [];
  for (const m of html.matchAll(/<(\w+)\b([^>]*)>/g)) {
    const tag = m[1] ?? '';
    const attrs = m[2] ?? '';
    const attr = /\swidth="(\d+)(?:px)?"/.exec(attrs);
    if (attr) out.push({ what: `<${tag} width="${attr[1]}">`, px: Number(attr[1]) });
    const style = /\sstyle="([^"]*)"/.exec(attrs)?.[1] ?? '';
    for (const s of style.matchAll(/(?:^|;)\s*(width|min-width)\s*:\s*(\d+)px/g)) out.push({ what: `<${tag} style="${s[1]}:${s[2]}px">`, px: Number(s[2]) });
  }
  return out;
}

function checkFits(rendered: string) {
  // Outlook-only conditional comments (`<!--[if mso]>`) hold the 480px ghost table; no other client renders them.
  const html = rendered.replace(/<!--[\s\S]*?-->/g, '');
  // 1. No fixed width wider than the phone, in an attribute or a style.
  expect(pixelWidths(html).filter((w) => w.px > VIEWPORT)).toEqual([]);
  // 2. A table with a pixel width attribute must be only a ceiling: its style says max-width:100%/width:100%.
  for (const t of html.matchAll(/<table\b([^>]*)>/g)) {
    const w = /\swidth="(\d+)"/.exec(t[1] ?? '');
    if (w) expect(t[1] ?? '', `<table width="${w[1]}"> must not be a rigid width`).toMatch(/max-width:\s*100%|width:\s*100%/);
  }
  // 3. The outer card is a fluid table (width 100%, capped by max-width <= 600).
  const outer = /<table\b[^>]*max-width:\s*(\d+)px[^>]*>/.exec(html);
  expect(outer, 'a fluid max-width table wraps the card').not.toBeNull();
  expect(Number(outer![1])).toBeLessThanOrEqual(600);
  expect(outer![0]).toMatch(/width:\s*100%|\swidth="100%"/);
  // 4. Every <img> can shrink.
  for (const img of html.matchAll(/<img\b[^>]*>/g)) expect(img[0]).toMatch(/max-width:\s*100%/);
  // 5. Long unbroken text (URLs, titles, names) can wrap.
  expect(html).toMatch(/overflow-wrap:\s*anywhere|word-break:\s*break-word|word-wrap:\s*break-word/);
}

describe('email layout fits a 375px phone (ticket #1267)', () => {
  it('finds the email kinds in the code', () => {
    expect(KINDS.length).toBeGreaterThanOrEqual(12);
  });

  it.each(KINDS)('%s: has no construct that forces sideways scroll', (kind) => {
    const sample = EMAIL_FIXTURES[kind];
    expect(sample, `no fixture for email kind "${kind}": add one to email-fixtures.ts`).toBeTypeOf('function');
    checkFits(sample().html);
  });

  it('the automation send-email shell fits too', () => {
    checkFits(AUTOMATION_FIXTURE().html);
  });

  it('dumps every kind for the real-browser measurement when EMAIL_DUMP_DIR is set', () => {
    const dir = process.env.EMAIL_DUMP_DIR;
    if (!dir) return;
    mkdirSync(dir, { recursive: true });
    for (const k of KINDS) writeFileSync(join(dir, `${k}.html`), EMAIL_FIXTURES[k]().html);
    writeFileSync(join(dir, 'automation.html'), AUTOMATION_FIXTURE().html);
  });
});

/**
 * Real measurement: runs wherever a Chrome binary exists (the CI ubuntu runners, a developer machine).
 * It is NOT silently green elsewhere: the skipped test's title carries the reason, and vitest lists it
 * as skipped.
 */
const CHROME = [process.env.CHROME_BIN, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'].find(
  (p): p is string => !!p && existsSync(p),
);

describe('real browser measurement at 375px', () => {
  it.skipIf(!CHROME)(
    CHROME ? 'scrollWidth is at most 375 for every kind (headless Chrome)' : 'SKIPPED: no Chrome binary found (set CHROME_BIN); the static checks above still ran',
    () => {
      const dir = mkdtempSync(join(tmpdir(), 'email-375-'));
      const all = [...KINDS.map((k) => [k, EMAIL_FIXTURES[k]().html] as const), ['automation', AUTOMATION_FIXTURE().html] as const];
      for (const [name, html] of all) {
        // An iframe's width is the viewport; headless Chrome's own window has a minimum wider than a phone.
        const page = `<!doctype html><body style="margin:0"><iframe id=f style="width:${VIEWPORT}px;height:900px;border:0" srcdoc="${html.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"></iframe><script>document.getElementById('f').onload=()=>setTimeout(()=>{document.title='SW='+document.getElementById('f').contentDocument.documentElement.scrollWidth},300)</script>`;
        const file = join(dir, `${name}.html`);
        writeFileSync(file, page);
        const out = execFileSync(CHROME!, ['--headless=new', '--disable-gpu', '--virtual-time-budget=3000', '--window-size=1000,1000', '--dump-dom', `file://${file}`], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        });
        const scrollWidth = Number(/<title>SW=(\d+)/.exec(out)?.[1]);
        expect(Number.isFinite(scrollWidth), `${name}: no measurement came back`).toBe(true);
        expect(scrollWidth, `${name}: scrollWidth must not exceed the ${VIEWPORT}px viewport`).toBeLessThanOrEqual(VIEWPORT);
      }
    },
    120_000,
  );
});
