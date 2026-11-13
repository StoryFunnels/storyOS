import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buttonVariants } from '@/components/ui/button';

/**
 * Ticket #1282, Otto's ruling 2026-11-13: ONE button size everywhere (28px, 13px/500), declared in `ui/button.tsx` and nowhere else.
 *
 * The pattern below is DERIVED from an inventory of the tree, not from a list of filenames (CLAUDE.md, "a filename is a proxy"):
 * a script found every `<Button>` that overrode its own size, and every hand-rolled `<button>` / `<Link>` / `<a>` that drew the
 * solid-primary or the bordered-secondary recipe with its own height or padding. Each hit was either migrated to the shared
 * Button or is one of the documented exceptions in EXCEPTIONS, with its reason. A NEW hit fails here.
 */
const SRC = fileURLToPath(new URL('..', import.meta.url));
function files(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    const f = join(dir, n);
    if (statSync(f).isDirectory()) files(f, out);
    else if (/\.tsx$/.test(n) && !/\.test\./.test(n)) out.push(f);
  }
  return out;
}
const ALL = files(SRC).filter((f) => !f.endsWith('components/ui/button.tsx'));
const rel = (p: string) => relative(SRC, p);

/** Every opening tag of the given names, with the className literal that belongs to it (the first one before the next tag opens). */
function tags(src: string, names: string): Array<{ at: number; cls: string }> {
  const out: Array<{ at: number; cls: string }> = [];
  const re = new RegExp(`<(?:${names})\\b`, 'g');
  for (let m = re.exec(src); m; m = re.exec(src)) {
    const rest = src.slice(m.index + 1);
    const stop = rest.search(/<[A-Za-z/]/);
    const seg = rest.slice(0, stop === -1 ? undefined : stop);
    const c = /className=(?:"([^"]*)"|\{`([^`]*)`\}|\{cn\(([^)]*)\)\})/.exec(seg);
    if (c) out.push({ at: m.index, cls: c[1] ?? c[2] ?? c[3] ?? '' });
  }
  return out;
}

/** A class that sets the button's size: height, padding or a text size. Responsive / state prefixes count too. */
const SIZING = /(^|[\s'"`])(?:[a-z-]+:)*(?:h|min-h|p|px|py|pt|pb)-(?:\d|\[)|(^|[\s'"`])(?:[a-z-]+:)*text-(?:xs|sm|prose|body|label|meta|caption|\[\d+px\])(?=[\s'"`]|$)/;

/**
 * The buttons that keep their own geometry ON PURPOSE. Each is a file plus a fragment of its class string, and a reason. The reasons
 * are the ruling's own classes of exception: icon-only controls, the toolbar (#964, #996), chips and pills, touch targets.
 */
const EXCEPTIONS: Array<{ file: string; frag: string; why: string }> = [
  { file: 'components/runners/wake-rules-editor.tsx', frag: 'h-6 w-6 px-0', why: 'icon-only remove control (24px minimum target, #1225)' },
  { file: 'app/w/[ws]/inbox/page.tsx', frag: 'min-h-[48px]', why: 'phone inbox swipe actions: a 48px touch target, not a desktop button' },
  { file: 'components/inbox-panel.tsx', frag: 'min-h-[44px]', why: 'phone inbox panel actions: a 44px touch target' },
  { file: 'components/sidebar.tsx', frag: 'h-[34px] w-[34px]', why: 'the workspace avatar tile: a square icon-only control, not a labelled button' },
  { file: 'components/sidebar.tsx', frag: 'text-faint hover:border-border-strong', why: 'the search trigger: drawn as an input, it opens the palette' },
  { file: 'components/entity/mentions.tsx', frag: 'text-meta font-medium text-muted hover:text-ink', why: 'an inline "+N more" chip inside a field, not a button row' },
];

const excepted = (file: string, cls: string) => EXCEPTIONS.some((e) => file === e.file && cls.includes(e.frag));

describe('the shared Button is the single source of the size (#1282)', () => {
  it('is 28px tall, 13px, weight 500, with no size variant left to pick', () => {
    const cls = buttonVariants();
    expect(cls).toContain('h-7');
    expect(cls).toContain('text-body');
    expect(cls).toContain('font-medium');
    expect(cls).not.toMatch(/\bh-(8|9|10|11)\b|text-prose/);
    expect(buttonVariants({ variant: 'secondary' })).toBe(buttonVariants({ variant: 'secondary' }));
  });

  it('every variant keeps the one size (the colours differ, the box does not)', () => {
    for (const v of ['primary', 'secondary', 'ghost', 'destructive'] as const) {
      expect(buttonVariants({ variant: v }), v).toContain('h-7 ');
      expect(buttonVariants({ variant: v }), v).toContain('px-2.5');
    }
  });

  it('no <Button> sets its own height, padding or text size', () => {
    const bad: string[] = [];
    for (const f of ALL) {
      for (const t of tags(readFileSync(f, 'utf8'), 'Button')) {
        if (SIZING.test(t.cls) && !excepted(rel(f), t.cls)) bad.push(`${rel(f)}: ${t.cls.slice(0, 80)}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('nothing outside ui/button.tsx asks for another size, or restates a button recipe through cn(buttonVariants(...), "h-9")', () => {
    const bad: string[] = [];
    for (const f of ALL) {
      const s = readFileSync(f, 'utf8');
      if (/<Button\b[^>]*\bsize=\{?["'](default|lg)["']/.test(s)) bad.push(`${rel(f)}: size="default|lg"`);
      for (const m of s.matchAll(/cn\(\s*buttonVariants\([^)]*\)\s*,\s*(['"`])([^'"`]*)\1/g)) {
        if (SIZING.test(m[2] ?? '')) bad.push(`${rel(f)}: buttonVariants + ${m[2]}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('no hand-rolled solid-primary button: bg-primary + on-dark text + control radius + its own height or padding', () => {
    const bad: string[] = [];
    for (const f of ALL) {
      const s = readFileSync(f, 'utf8');
      for (const t of tags(s, 'button|Link|a')) {
        if (t.cls.includes('bg-primary') && t.cls.includes('text-[var(--text-on-dark)]') && t.cls.includes('rounded-[var(--radius-control)]') && SIZING.test(t.cls) && !excepted(rel(f), t.cls)) {
          bad.push(`${rel(f)}: ${t.cls.slice(0, 90)}`);
        }
      }
    }
    expect(bad).toEqual([]);
  });

  it('no hand-rolled bordered button: control radius + border-default + side padding + its own height or vertical padding', () => {
    const bad: string[] = [];
    for (const f of ALL) {
      const s = readFileSync(f, 'utf8');
      for (const t of tags(s, 'button|Link|a')) {
        const c = t.cls;
        if (c.includes('rounded-[var(--radius-control)]') && c.includes('border-border-default') && /\bpx-\d/.test(c) && /\b(py-|h-\d)/.test(c) && !c.includes('border-dashed') && !excepted(rel(f), c)) {
          bad.push(`${rel(f)}: ${c.slice(0, 90)}`);
        }
      }
    }
    expect(bad).toEqual([]);
  });

  it('the exceptions are real: each names a class string that still exists (an entry for deleted code is a lie)', () => {
    for (const e of EXCEPTIONS) {
      expect(readFileSync(join(SRC, e.file), 'utf8'), e.file).toContain(e.frag);
    }
  });
});
