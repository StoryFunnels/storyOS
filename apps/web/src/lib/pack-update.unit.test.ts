import { describe, expect, it } from 'vitest';
import { itemEffect, releaseNotes, versionsBetween, type PackVersion } from './pack-update';

const v = (version: string, changelog?: string): PackVersion => ({ version, changelog, published_at: '2026-10-01T00:00:00Z' });

describe('versionsBetween (#978)', () => {
  const all = [v('1.0'), v('1.1'), v('1.4'), v('1.5'), v('1.10')];
  it('returns the versions an update crosses, newest first, excluding the installed one', () => {
    expect(versionsBetween(all, '1.1', '1.5').map((x) => x.version)).toEqual(['1.5', '1.4']);
  });
  it('compares dotted numbers, not text: 1.10 is after 1.9', () => {
    expect(versionsBetween([v('1.9'), v('1.10')], '1.9', '1.10').map((x) => x.version)).toEqual(['1.10']);
  });
  it('excludes versions beyond the target', () => {
    expect(versionsBetween(all, '1.4', '1.5').map((x) => x.version)).toEqual(['1.5']);
  });
  it('is empty when nothing is newer', () => {
    expect(versionsBetween(all, '1.10', '1.10')).toEqual([]);
  });
});

describe('releaseNotes', () => {
  it('splits the newest version from the earlier ones it skipped over', () => {
    const n = releaseNotes([v('1.4', 'four'), v('1.5', 'five'), v('1.3', 'old')], '1.3', '1.5');
    expect(n.latest?.version).toBe('1.5');
    expect(n.earlier.map((x) => x.version)).toEqual(['1.4']);
    expect(n.noNotes).toBe(false);
  });
  it('says there are no notes when every crossed version is blank or missing a changelog', () => {
    expect(releaseNotes([v('1.5'), v('1.4', '   ')], '1.3', '1.5').noNotes).toBe(true);
  });
  it('a built-in pack has no version data at all: no latest, no notes', () => {
    const n = releaseNotes(undefined, '1.0', '1.1');
    expect(n).toEqual({ latest: null, earlier: [], noNotes: true });
  });
  it('still has notes when only an earlier version wrote one', () => {
    expect(releaseNotes([v('1.5'), v('1.4', 'only this')], '1.3', '1.5').noNotes).toBe(false);
  });
});

describe('itemEffect: states what install does today', () => {
  it('an agent that already exists is kept as it is, and updating agents is not available yet', () => {
    expect(itemEffect('agent', 'reuse')).toBe('Agent: kept as it is. Updating agents from a pack isn’t available yet.');
  });
  it('a reused database keeps what is there and adds only missing fields', () => {
    expect(itemEffect('database', 'reuse')).toMatch(/Kept as it is, except fields the pack needs that are missing are added/);
  });
  it('a reused view or automation is left alone', () => {
    expect(itemEffect('view', 'reuse')).toBe('Already there. Kept as it is.');
    expect(itemEffect('automation', 'reuse')).toBe('Already there. Kept as it is.');
  });
  it('a new item will be created, whatever it is', () => {
    for (const k of ['database', 'view', 'automation', 'agent'] as const) expect(itemEffect(k, 'create')).toBe('Will be created.');
  });
  it('a collision hands the choice to the person', () => {
    expect(itemEffect('view', 'collision')).toMatch(/You choose/);
  });
  it('never offers Keep mine / Take update: those arrive with #977', () => {
    for (const k of ['database', 'view', 'automation', 'agent'] as const)
      for (const a of ['create', 'reuse', 'collision'] as const) expect(itemEffect(k, a)).not.toMatch(/keep mine|take update/i);
  });
});
