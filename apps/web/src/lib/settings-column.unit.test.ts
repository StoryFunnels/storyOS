import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('..', import.meta.url));
const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8');
const layout = read('app/w/[ws]/settings/layout.tsx');
const chrome = read('components/settings/settings-chrome.tsx');

function pages(dir = join(SRC, 'app/w/[ws]/settings')): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? pages(p) : p.endsWith('page.tsx') ? [p] : [];
  });
}

describe('the Settings page column lives in one place (#1186, Dara: left-aligned, 720, 28px gutter, title 10px higher)', () => {
  it('is a layout over every settings route, with a 28px gutter, 22px top and a 720px content column', () => {
    const cls = layout.match(/className="([^"]+)"/)![1]!;
    expect(cls).toContain('sm:px-7'); // 28px
    expect(cls).toContain('sm:pt-[22px]'); // title top = pane top + 22 = 31px in a 1270px window
    expect(cls).toContain('max-w-[720px]');
    expect(cls).toContain('box-content'); // 720 is the CONTENT width, the gutter sits outside it
  });

  it('is left-aligned: the column never centres itself', () => {
    expect(layout.match(/className="([^"]+)"/)![1]).not.toMatch(/\bmx-auto\b/);
  });

  it('takes centring, padding and width from the page roots, so no page has to change to get the column', () => {
    const cls = layout.match(/className="([^"]+)"/)![1]!;
    for (const rule of ['[&>*]:mx-0!', '[&>*]:max-w-none!', '[&>*]:p-0!']) expect(cls).toContain(rule);
  });

  it('the page title is 18px / 700 (the shared header)', () => {
    expect(chrome).toMatch(/<h1 className="text-lg font-bold /);
  });
});

describe('a switch is never stretched (#1186 send-back: 328 x 20 at 390px)', () => {
  it('the shared row never flexes a switch: its buttons-that-stretch rule excludes role=switch', () => {
    expect(chrome).toContain('[&>button:not([role=switch])]:flex-1');
    expect(chrome).not.toMatch(/\[&>button\]:flex-1/);
  });

  it('every Switch on a Settings page that sits in a SettingsRow says its controls stay inline', () => {
    for (const file of pages()) {
      const src = readFileSync(file, 'utf8');
      if (!src.includes('<Switch')) continue;
      const rowStart = src.lastIndexOf('<SettingsRow', src.indexOf('<Switch'));
      if (rowStart < 0) continue; // a switch outside the shared row lays itself out
      // The row's own props come before its children, so everything up to the Switch holds them.
      expect(src.slice(rowStart, src.indexOf('<Switch')), file).toContain('inlineControls');
    }
  });
});

describe('no Settings page root sets its own column (ticket #1137, Dara: the Runners page sat at x=445, every other page at x=313)', () => {
  // The layout takes centring, width and padding from each page's root, so a root either says nothing about the column or says
  // the one standard string the layout is known to override. Anything else (the Runners page had its own `max-w-[720px]`) is a root
  // that can escape the column, and nothing fails to compile when it does.
  const STANDARD = /^mx-auto (flex )?max-w-3xl (flex-col gap-\[18px\] )?p-4 sm:p-8$/;
  const ROOT = /return \(\s*(?:\/\/[^\n]*\n\s*)*<(?:div|section|main)\s+(?:data-testid="[^"]*"\s+)?className="([^"]*)"/g;
  const OWN = /\bmx-auto\b|\bmax-w-/;
  it('every page root is free of column classes or exactly the standard string', () => {
    for (const file of pages()) {
      for (const m of readFileSync(file, 'utf8').matchAll(ROOT)) {
        const cls = m[1]!;
        if (!OWN.test(cls)) continue;
        expect(cls, file).toMatch(STANDARD);
      }
    }
  });
  it('the Runners page root sets no centring or width at all', () => {
    const roots = [...read('app/w/[ws]/settings/runners/page.tsx').matchAll(ROOT)].map((m) => m[1]!);
    expect(roots.length).toBeGreaterThan(0);
    for (const cls of roots) expect(cls).not.toMatch(OWN);
  });
});
