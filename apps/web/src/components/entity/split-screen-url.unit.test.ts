import { describe, expect, it } from 'vitest';
import { OPEN_PARAM, emptySplitStack, parseOpenTargets, reduceSplit, withOpenTargets } from './split-screen';
import type { SplitStackState } from './split-screen';

const t = (rec: string, db = 'db1') => ({ db, rec });
const sync = (s: SplitStackState, ...targets: Array<{ db: string; rec: string }>) =>
  reduceSplit(s, { type: 'sync', targets });
const recs = (s: SplitStackState) => s.panels.map((p) => `${p.target.db}:${p.target.rec}`);

describe('split panels live in the URL (#962)', () => {
  it('parses ?open=<db>:<rec> in stack order and skips what is malformed', () => {
    expect(parseOpenTargets(['db1:task-1-1', 'db2:abc'])).toEqual([t('task-1-1'), t('abc', 'db2')]);
    expect(parseOpenTargets(['nocolon', ':rec', 'db:', ''])).toEqual([]);
  });

  it('rewrites only the open entries and keeps every other parameter', () => {
    expect(withOpenTargets('?view=v1&open=old:rec', [t('a'), t('b')])).toBe('?view=v1&open=db1%3Aa&open=db1%3Ab');
    expect(withOpenTargets('?view=v1&open=old:rec', [])).toBe('?view=v1');
    expect(withOpenTargets('', [])).toBe('');
    expect(OPEN_PARAM).toBe('open');
    // and what it writes is what parseOpenTargets reads back
    const qs = withOpenTargets('', [t('a'), t('b', 'db2')]);
    expect(parseOpenTargets(new URLSearchParams(qs).getAll(OPEN_PARAM))).toEqual([t('a'), t('b', 'db2')]);
  });

  describe('sync — making the stack match the URL', () => {
    it('opens what the URL lists (a refresh, a pasted link)', () => {
      expect(recs(sync(emptySplitStack(), t('a')))).toEqual(['db1:a']);
      expect(recs(sync(emptySplitStack(), t('a'), t('b')))).toEqual(['db1:a', 'db1:b']);
    });
    it('closes what the URL no longer lists (Back)', () => {
      const two = sync(emptySplitStack(), t('a'), t('b'));
      expect(recs(sync(two, t('a')))).toEqual(['db1:a']);
      expect(sync(two).panels).toEqual([]);
    });
    it('is a no-op — the SAME reference — when the stack already matches (the stack just wrote that URL)', () => {
      const s = sync(emptySplitStack(), t('a'));
      expect(sync(s, t('a'))).toBe(s);
      expect(sync(emptySplitStack())).toEqual(emptySplitStack());
    });
    it('keeps a surviving panel’s identity and layout: a collapsed panel stays collapsed', () => {
      const two = sync(emptySplitStack(), t('a'), t('b')); // opening b docks a to a rail
      const keptA = two.panels.find((p) => p.target.rec === 'a')!;
      const after = sync(two, t('a'));
      expect(after.panels.find((p) => p.target.rec === 'a')?.id).toBe(keptA.id);
    });
    it('different databases are different panels', () => {
      expect(recs(sync(emptySplitStack(), t('a', 'db1'), t('a', 'db2')))).toEqual(['db1:a', 'db2:a']);
    });
  });
});
