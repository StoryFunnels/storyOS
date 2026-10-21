import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GUARD_KEY, INDEX_KEY, PAGE_KEY, backOrParent, trackHistory } from './nav-trail';
import type { HistoryLike } from './nav-trail';

/** A just-enough History: a stack of states and a cursor, with `go` moving it. */
function fakeHistory(initial: unknown = null) {
  const stack: unknown[] = [initial];
  let at = 0;
  const h: HistoryLike & { go: (n: number) => void; at: () => number; length: () => number } = {
    get state() {
      return stack[at];
    },
    pushState(data) {
      stack.splice(at + 1);
      stack.push(data);
      at += 1;
    },
    replaceState(data) {
      stack[at] = data;
    },
    go(n) {
      at = Math.max(0, Math.min(stack.length - 1, at + n));
    },
    at: () => at,
    length: () => stack.length,
  };
  return h;
}

describe('trackHistory — "is the entry behind me inside the app?" (#962)', () => {
  it('a pasted link / fresh tab has nothing behind it', () => {
    const t = trackHistory(fakeHistory());
    expect(t.canGoBack()).toBe(false);
  });

  it('an in-app push makes the previous entry ours; going back makes it not', () => {
    const h = fakeHistory();
    const t = trackHistory(h);
    h.pushState({ __NA: true }, '', '/a');
    expect(t.canGoBack()).toBe(true);
    h.go(-1);
    expect(t.canGoBack()).toBe(false);
  });

  it('a replace is not a step', () => {
    const h = fakeHistory();
    const t = trackHistory(h);
    h.replaceState({ __NA: true }, '', '/a');
    expect(t.canGoBack()).toBe(false);
    expect(t.index()).toBe(0);
  });

  it('keeps what the router stored in the entry', () => {
    const h = fakeHistory({ __NA: true });
    trackHistory(h);
    h.pushState({ __NA: true, tree: 1 }, '', '/a');
    expect(h.state).toMatchObject({ __NA: true, tree: 1, [INDEX_KEY]: 1, [PAGE_KEY]: 1 });
  });

  it('a reload keeps the stamp but resets the base: entries behind a reload are never claimed', () => {
    const first = fakeHistory();
    const t1 = trackHistory(first);
    first.pushState({}, '', '/a');
    first.pushState({}, '', '/b');
    expect(t1.canGoBack()).toBe(true);
    // Same history, new document: a fresh tracker over the stamped entry.
    const reloaded: HistoryLike = {
      state: first.state,
      pushState: first.pushState.bind(first),
      replaceState: first.replaceState.bind(first),
    };
    const t2 = trackHistory(reloaded);
    expect(t2.canGoBack()).toBe(false);
  });

  it('an overlay guard does not count as a page: a guard on a pasted link is still "nothing behind"', () => {
    const h = fakeHistory();
    const t = trackHistory(h);
    h.pushState({ [GUARD_KEY]: true }, '');
    expect(t.index()).toBe(1);
    expect(t.page()).toBe(0);
    expect(t.canGoBack()).toBe(false);
  });

  it('reports the direction of a traversal and whether a guard was involved', () => {
    const h = fakeHistory();
    const t = trackHistory(h);
    h.pushState({}, '', '/a');
    h.pushState({ [GUARD_KEY]: true }, '');
    h.go(-1);
    expect(t.traversed()).toEqual({ dir: 'back', leftGuard: true, onGuard: false });
    h.go(1);
    expect(t.traversed()).toEqual({ dir: 'forward', leftGuard: false, onGuard: true });
  });
});

describe('backOrParent', () => {
  const router = () => {
    const calls: string[] = [];
    return { calls, back: () => calls.push('back'), replace: (href: string) => calls.push(`replace ${href}`) };
  };
  it('goes to the parent (by replace) when nothing in-app is behind', () => {
    const r = router();
    backOrParent(r, '/w/x/d/y');
    expect(r.calls).toEqual(['replace /w/x/d/y']);
  });
});

// ── The ban (#962 AC3) ────────────────────────────────────────────────────────────────
// `history.length` counts entries from before the app, and a raw `history.back()` can leave
// the product. Every close/back control goes through nav-trail's helper. The two modules
// that ARE the history layer are the only exemptions.
const SRC = join(__dirname, '..');
const EXEMPT = new Set(['lib/nav-trail.ts', 'lib/back-layers.ts']);
function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

describe('no raw history use outside the history layer (#962)', () => {
  const files = walk(SRC).filter((f) => !EXEMPT.has(relative(SRC, f)));
  it('scans a real population, not a prefix of one', () => {
    expect(files.length).toBeGreaterThan(200);
  });
  const banned = [
    { name: 'history.length', re: /\bhistory\.length\b/ },
    { name: 'history.back()', re: /\bhistory\.back\s*\(/ },
    { name: 'history.go(', re: /\bhistory\.go\s*\(/ },
  ];
  for (const { name, re } of banned) {
    it(`${name} appears nowhere`, () => {
      const hits = files.filter((f) => re.test(readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')));
      expect(hits.map((f) => relative(SRC, f))).toEqual([]);
    });
  }
});
