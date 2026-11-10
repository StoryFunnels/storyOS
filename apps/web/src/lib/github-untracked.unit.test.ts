import { describe, expect, it } from 'vitest';
import { trackRequestBody, untrackedModel, type IgnoredDeliveries } from './github-untracked';

/** Ticket #1221 — GitHub's "Not tracked, but sending events" list. */
const repo = (name: string, n = 1) => ({ repo: name, count: n, last_seen_at: '2026-11-09T10:00:00Z' });
const five: IgnoredDeliveries = { repos: ['a/1', 'a/2', 'a/3', 'a/4', 'a/5'].map((r) => repo(r, 4)), other_count: 0 };

describe('untrackedModel', () => {
  it('says nothing when nothing is sending', () => {
    expect(untrackedModel(undefined, [], false).heading).toBeNull();
    expect(untrackedModel({ repos: [], other_count: 0 }, [], false).heading).toBeNull();
  });

  it('counts repositories in the heading and shows the first 3, then "N more"', () => {
    const m = untrackedModel(five, [], false);
    expect(m.heading).toBe('Not tracked, but sending events · 5 repositories');
    expect(m.rows.map((r) => r.repo)).toEqual(['a/1', 'a/2', 'a/3']);
    expect(m.hiddenCount).toBe(2);
  });

  it('Show all lists every repository', () => {
    const m = untrackedModel(five, [], true);
    expect(m.rows).toHaveLength(5);
    expect(m.hiddenCount).toBe(0);
  });

  it('uses the singular for one repository', () => {
    expect(untrackedModel({ repos: [repo('a/1')], other_count: 0 }, [], false).heading).toBe('Not tracked, but sending events · 1 repository');
  });

  it('KEEPS the other repositories when one becomes tracked, and drops only that one', () => {
    const m = untrackedModel(five, ['a/2'], false);
    expect(m.rows.map((r) => r.repo)).toEqual(['a/1', 'a/3', 'a/4']);
    expect(m.heading).toContain('· 4 repositories');
  });

  it('a stale tally for a repository now tracked never lists it', () => {
    expect(untrackedModel({ repos: [repo('a/1')], other_count: 0 }, ['a/1'], false).heading).toBeNull();
  });

  it('deliveries from unnamed repositories are a muted count, never rows', () => {
    const m = untrackedModel({ repos: [], other_count: 7 }, [], false);
    expect(m.heading).toBe('Not tracked, but sending events');
    expect(m.rows).toEqual([]);
    expect(m.otherDeliveries).toBe(7);
  });
});

describe('trackRequestBody (the existing selection call: POST integrations/github { repos })', () => {
  it('adds the repository to the current selection, keeping what was tracked', () => {
    expect(trackRequestBody(['a/x', 'a/y'], 'a/z')).toEqual({ repos: ['a/x', 'a/y', 'a/z'] });
  });
  it('tracking from an empty selection sends just that repository', () => {
    expect(trackRequestBody([], 'a/z')).toEqual({ repos: ['a/z'] });
  });
  it('is idempotent and does not mutate the input', () => {
    const cur = ['a/x'];
    expect(trackRequestBody(cur, 'a/x')).toEqual({ repos: ['a/x'] });
    trackRequestBody(cur, 'a/q');
    expect(cur).toEqual(['a/x']);
  });
});
