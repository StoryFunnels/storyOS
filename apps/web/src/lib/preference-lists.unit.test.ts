import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { listAfterEdit, withListEdit, type UserPreferences } from './preferences';

describe('listAfterEdit (#1007) — the optimistic twin of the server’s atomic edit', () => {
  it('adds an item at the end, once', () => {
    expect(listAfterEdit(['a'], { add: ['b'] })).toEqual(['a', 'b']);
    expect(listAfterEdit(['a', 'b'], { add: ['b'] })).toEqual(['a', 'b']);
    expect(listAfterEdit(undefined, { add: ['a'] })).toEqual(['a']);
  });

  // What the filter must KEEP: one workspace's change never disturbs another's.
  it('removes only the named item and leaves the rest in order', () => {
    expect(listAfterEdit(['a', 'b', 'c'], { remove: ['b'] })).toEqual(['a', 'c']);
    expect(listAfterEdit(['a'], { remove: ['zzz'] })).toEqual(['a']);
    expect(listAfterEdit(undefined, { remove: ['a'] })).toEqual([]);
  });

  it('an item in both add and remove is removed, as on the server', () => {
    expect(listAfterEdit(['a'], { add: ['b'], remove: ['b'] })).toEqual(['a']);
  });

  it('does not mutate its input', () => {
    const list = ['a'];
    listAfterEdit(list, { add: ['b'], remove: ['a'] });
    expect(list).toEqual(['a']);
  });
});

describe('withListEdit', () => {
  const prefs = {
    activation: { dismissedWorkspaces: ['w1'] },
    sidebar: { viewsOnlyWorkspaces: ['w1', 'w2'] },
  } as unknown as UserPreferences;

  it('edits the dismissed list and leaves the views-only list alone', () => {
    const next = withListEdit(prefs, { list: 'dismissed_workspaces', add: ['w2'] });
    expect(next.activation.dismissedWorkspaces).toEqual(['w1', 'w2']);
    expect(next.sidebar.viewsOnlyWorkspaces).toEqual(['w1', 'w2']);
  });

  it('edits the views-only list and leaves the dismissed list alone', () => {
    const next = withListEdit(prefs, { list: 'views_only_workspaces', remove: ['w1'] });
    expect(next.sidebar.viewsOnlyWorkspaces).toEqual(['w2']);
    expect(next.activation.dismissedWorkspaces).toEqual(['w1']);
  });
});

/**
 * The defect was a CALLER replacing the whole list, so the guard is on callers: no file other than the preferences
 * module may assign either list (`dismissedWorkspaces: …` / `viewsOnlyWorkspaces: …`). Reading them is fine.
 */
describe('no caller sends a whole list (#1007)', () => {
  const SRC = join(__dirname, '..');
  function walk(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p, out);
      else if (/\.(ts|tsx)$/.test(name) && !/\.(unit\.)?test\.(ts|tsx)$/.test(name)) out.push(p);
    }
    return out;
  }
  const ASSIGNS = /\b(?:dismissedWorkspaces|viewsOnlyWorkspaces)\s*:\s*[\w[({]/;
  it('only lib/preferences.ts declares or assigns the lists', () => {
    const offenders = walk(SRC)
      .map((p) => ({ rel: relative(SRC, p).split('\\').join('/'), text: readFileSync(p, 'utf8') }))
      .filter((f) => f.rel !== 'lib/preferences.ts' && ASSIGNS.test(f.text))
      .map((f) => f.rel);
    expect(offenders).toEqual([]);
  });
});
