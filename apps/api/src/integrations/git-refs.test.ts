import { describe, expect, it } from 'vitest';
import { branchNameFor, extractIdentifiers, extractRecordNumbers, slugify } from './git-refs';

describe('branchNameFor (ticket #1219: copy branch name gives a stable, slugged name)', () => {
  it('is number-led, lane-prefixed and slugged', () => {
    expect(
      branchNameFor({ number: 1219, title: 'Git: every issue gets a branch name!', lane: 'api' }),
    ).toBe('api/1219-git-every-issue-gets-a-branch-name');
  });

  it('is stable: same input, same output; the number never changes when the title does', () => {
    const a = branchNameFor({ number: 7, title: 'Old title', lane: 'web' });
    expect(branchNameFor({ number: 7, title: 'Old title', lane: 'web' })).toBe(a);
    expect(branchNameFor({ number: 7, title: 'New title', lane: 'web' }).startsWith('web/7-')).toBe(true);
  });

  it('caps the slug at a word boundary and strips accents and symbols', () => {
    const s = slugify('Über-long title with many many many many many words in it to cut');
    expect(s.length).toBeLessThanOrEqual(48);
    expect(s.startsWith('uber-long-title')).toBe(true);
    expect(s.endsWith('-')).toBe(false);
  });

  it('an empty or symbol-only title still yields a valid name', () => {
    expect(branchNameFor({ number: 5, title: '???' })).toBe('5');
    expect(branchNameFor({ number: 5, title: '', lane: 'fix' })).toBe('fix/5');
  });
});

describe('extractRecordNumbers (ticket #1219)', () => {
  it('reads the number from a lane branch, and what branchNameFor emits round-trips', () => {
    const b = branchNameFor({ number: 1219, title: 'Anything at all', lane: 'api' });
    expect(extractRecordNumbers({ branch: b })).toEqual([1219]);
  });

  it('matches "ticket #N" and "Issue #N" in title and body, case-insensitively, deduped', () => {
    expect(
      extractRecordNumbers({ title: 'fix (Ticket #12)', body: 'Closes issue #34 and ticket #12, issues #56' }),
    ).toEqual([12, 34, 56]);
  });

  it('a bare #N is ambiguous: never matches (PR numbers and ticket numbers collide)', () => {
    expect(extractRecordNumbers({ title: 'Fixes #12', body: 'PR #34, see #56' })).toEqual([]);
  });

  it('does not match cross-repo or look-alike references', () => {
    expect(
      extractRecordNumbers({
        body: 'owner/repo#12 other/issue #9 multi-ticket #4 tickets#7 ticket #',
      }),
    ).toEqual([]);
  });

  it('does not match a branch that merely contains a number or a non-lane prefix', () => {
    expect(extractRecordNumbers({ branch: 'chore/1219-x' })).toEqual([]);
    expect(extractRecordNumbers({ branch: 'feat/api/1219-x' })).toEqual([]);
    expect(extractRecordNumbers({ branch: 'api/v2-1219' })).toEqual([]);
  });

  it('rejects absurd numbers instead of rounding them', () => {
    expect(extractRecordNumbers({ title: 'ticket #99999999999999999999' })).toEqual([]);
    expect(extractRecordNumbers({ title: 'ticket #0' })).toEqual([]);
  });
});

describe('extractIdentifiers (ticket #1368: an identifier, not a record number)', () => {
  it.each(['feat', 'bugfix', 'fix', 'release'])('reads %s/issue-5201 as ISSUE-5201', (kind) => {
    expect(extractIdentifiers({ branch: `${kind}/issue-5201` })).toEqual([{ prefix: 'ISSUE', number: 5201 }]);
  });

  it('reads an identifier followed by a slug, and one behind a user segment', () => {
    expect(extractIdentifiers({ branch: 'feat/issue-5201-fix-the-thing' })).toEqual([{ prefix: 'ISSUE', number: 5201 }]);
    expect(extractIdentifiers({ branch: 'dana/sp-77-widen-picker' })).toEqual([{ prefix: 'SP', number: 77 }]);
  });

  it('reads ISSUE-n from the title and the body, branch first, deduped, in order', () => {
    expect(
      extractIdentifiers({ branch: 'feat/issue-3', title: 'ISSUE-9: widen it', body: 'Follows ISSUE-9 and ISSUE-12.\nISSUE-3' }),
    ).toEqual([
      { prefix: 'ISSUE', number: 3 },
      { prefix: 'ISSUE', number: 9 },
      { prefix: 'ISSUE', number: 12 },
    ]);
  });

  it('only upper-case identifiers count in prose (a lower-case issue-5 is just words)', () => {
    expect(extractIdentifiers({ title: 'see issue-5 for background' })).toEqual([]);
  });

  it('ignores near-misses: no number, a longer word, a path', () => {
    expect(extractIdentifiers({ title: 'ISSUE- and ISSUE-x and https://x.test/ISSUE-5' })).toEqual([]);
    expect(extractIdentifiers({ title: 'ISSUE-5abc' })).toEqual([]);
  });

  it('does not take a #n or a bare number', () => {
    expect(extractIdentifiers({ title: 'fixes #5201', branch: 'feat/5201' })).toEqual([]);
  });

  it('ignores a number that is not a safe record number', () => {
    expect(extractIdentifiers({ title: 'ISSUE-0 ISSUE-99999999999 ISSUE-2147483648' })).toEqual([]);
  });
});
