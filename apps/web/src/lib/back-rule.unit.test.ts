import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const src = (rel: string) => readFileSync(join(__dirname, '..', rel), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');

/**
 * #962 AC5 — "view tab switches push; filter / sort / grouping changes never push". The rule is split across files,
 * so it is pinned where each half lives: the switch goes through ONE function that pushes, and the modules that
 * write a view's configuration cannot navigate at all (no router in them to push with).
 */
describe('places push, edits never do (#962)', () => {
  const page = src('app/w/[ws]/d/[db]/page.tsx');

  it('every way of landing on another view goes through goToView, which pushes', () => {
    expect(page).toMatch(/const goToView = [\s\S]*?router\.push\(/);
    expect(page).toMatch(/onNavigate=\{\(\) => goToView\(view\.id\)\}/); // a tab
    expect(page).toMatch(/onNavigate=\{goToView\}/); // the switcher
    expect(page).toMatch(/onDuplicated=\{goToView\}/);
    expect(page).toMatch(/onSuccess: \(v\) => goToView\(v\.id\)/); // created / duplicated
  });

  it('what stays `replace` is a rewrite of where you already are, or leaving something that is gone', () => {
    // ?share / ?field clean-ups, the deleted view, and nothing that selects a view.
    const replaces = [...page.matchAll(/router\.replace\(([^)]*)\)/g)].map((m) => m[1]);
    expect(replaces.length).toBeGreaterThan(0);
    for (const r of replaces) expect(r).not.toMatch(/view=\$\{(view|id|v)\./);
  });

  it.each([
    'components/views/use-view-state.ts',
    'components/views/filter-state.ts',
    'components/views/sort-config.ts',
    'components/views/filter-config.ts',
    'components/views/view-grouping.ts',
    'components/views/group-chip.tsx',
  ])('%s cannot navigate: a filter, sort or grouping edit has no router to push with', (rel) => {
    const code = src(rel);
    expect(code).not.toMatch(/useRouter|router\.(push|replace|back)|history\.(push|replace)State/);
  });
});
