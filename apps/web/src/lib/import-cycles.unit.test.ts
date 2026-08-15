import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/**
 * #315 — no NEW import cycles in `apps/web/src`.
 *
 * The public form outage was an import cycle (`cells.tsx` -> `ui/avatar.tsx` ->
 * `cells.tsx`) that only broke on routes where `cells.tsx` evaluated first. The
 * smoke test next to the form route catches that specific page; this catches the
 * CLASS, which is the actual ask — a cycle is only dangerous once some route
 * happens to evaluate it in the wrong order, and by then it is in production.
 *
 * Written as a plain graph walk rather than pulling in `dpdm` or
 * `eslint-plugin-import`: the check is ~40 lines, needs no new dependency, and
 * runs with the existing suite on every PR.
 *
 * BASELINE. Cycles that already existed are listed below and tolerated, so this
 * can land green today and still block anything new. Shrink the list; never grow
 * it. A cycle is not automatically a crash — it breaks when a value is read at
 * MODULE SCOPE, as `avatar`'s `Object.keys(OPTION_COLORS)` was — but every entry
 * here is a latent version of the same outage.
 */
const SRC = resolve(__dirname, '..');

/** Cycles present when this check was introduced. Sorted, normalised keys. */
const BASELINE: string[] = [];

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      sourceFiles(full, out);
    } else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

/** Resolve an import specifier to a file in SRC, or null if it leaves the tree. */
function resolveSpecifier(fromFile: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith('@/')) base = join(SRC, spec.slice(2));
  else if (spec.startsWith('.')) base = resolve(dirname(fromFile), spec);
  else return null; // node_modules / bare package — cannot participate in our cycles

  for (const candidate of [
    `${base}.ts`,
    `${base}.tsx`,
    join(base, 'index.ts'),
    join(base, 'index.tsx'),
  ]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

function buildGraph(): Map<string, string[]> {
  const graph = new Map<string, string[]>();
  for (const file of sourceFiles(SRC)) {
    const source = readFileSync(file, 'utf8');
    const edges: string[] = [];
    // Static imports only. `import type` is erased at compile time and cannot
    // cause a runtime cycle, so it is excluded — flagging those would be noise.
    const pattern = /^\s*import\s+(?!type\s)[^;]*?from\s+['"]([^'"]+)['"]/gm;
    for (const match of source.matchAll(pattern)) {
      const target = resolveSpecifier(file, match[1]!);
      if (target && target !== file) edges.push(target);
    }
    graph.set(file, edges);
  }
  return graph;
}

/** Every cycle, as a normalised `a -> b -> a` key rooted at its smallest member. */
function findCycles(graph: Map<string, string[]>): string[] {
  const found = new Set<string>();
  const state = new Map<string, 'visiting' | 'done'>();
  const stack: string[] = [];

  const rel = (f: string) => f.slice(SRC.length + 1);

  function visit(node: string) {
    if (state.get(node) === 'done') return;
    if (state.get(node) === 'visiting') {
      const cycle = stack.slice(stack.indexOf(node)).map(rel);
      // Root the key at the alphabetically smallest member so the same cycle
      // reported from different entry points collapses to one key.
      const pivot = cycle.indexOf([...cycle].sort()[0]!);
      found.add([...cycle.slice(pivot), ...cycle.slice(0, pivot)].join(' -> '));
      return;
    }
    state.set(node, 'visiting');
    stack.push(node);
    for (const next of graph.get(node) ?? []) visit(next);
    stack.pop();
    state.set(node, 'done');
  }

  for (const node of graph.keys()) visit(node);
  return [...found].sort();
}

describe('module import cycles in apps/web/src (#315)', () => {
  it('has no cycle outside the baseline', () => {
    const cycles = findCycles(buildGraph());
    const unexpected = cycles.filter((c) => !BASELINE.includes(c));
    expect(unexpected, `New import cycle(s):\n${unexpected.join('\n')}`).toEqual([]);
  });

  it('has no STALE baseline entries — shrink the list when a cycle is fixed', () => {
    const cycles = findCycles(buildGraph());
    const fixed = BASELINE.filter((c) => !cycles.includes(c));
    expect(fixed, `Fixed — remove from BASELINE:\n${fixed.join('\n')}`).toEqual([]);
  });
});
