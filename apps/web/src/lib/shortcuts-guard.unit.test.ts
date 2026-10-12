import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * #837 AC6 — "is focus somewhere a global shortcut must not intercept" is
 * answered in ONE place (`isTypingTarget`, in shortcuts.ts). It had been written
 * four times, and the ones that bit this codebase were all small when written.
 *
 * This reads every source file under apps/web/src and fails if a handler
 * re-derives the answer from `isContentEditable` or an INPUT/TEXTAREA/SELECT tag
 * test instead of calling it. The allowlist is the definition itself, and
 * escape-layers.ts's `isEditorTarget` — a DIFFERENT question (a rich-text surface
 * specifically, so Esc blurs it first) that happens to need `isContentEditable`.
 */
const root = fileURLToPath(new URL('..', import.meta.url));
const ALLOWED = new Set(['lib/shortcuts.ts', 'lib/escape-layers.ts']);

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...sources(full));
    else if (/\.tsx?$/.test(name) && !/\.test\./.test(name)) out.push(full);
  }
  return out;
}

const strip = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const TYPING_CHECK = /isContentEditable|===\s*['"](?:INPUT|TEXTAREA|SELECT)['"]|\(INPUT\|TEXTAREA|INPUT\|TEXTAREA\|SELECT/;

describe('no second copy of the typing-target check (#837)', () => {
  it('scans a real tree', () => {
    expect(sources(root).length).toBeGreaterThan(100);
  });
  it('finds no inline typing-target test outside the two allowed files', () => {
    const offenders = sources(root)
      .filter((f) => !ALLOWED.has(relative(root, f)))
      .filter((f) => TYPING_CHECK.test(strip(readFileSync(f, 'utf8'))))
      .map((f) => relative(root, f));
    expect(offenders, 'call isTypingTarget() from @/lib/shortcuts instead of re-deriving it').toEqual([]);
  });
  it('keeps the allowed files honest: escape-layers.ts may not carry its own tag test', () => {
    const t = strip(readFileSync(join(root, 'lib/escape-layers.ts'), 'utf8'));
    expect(t).not.toMatch(/===\s*['"](?:INPUT|TEXTAREA|SELECT)['"]/);
  });
});
