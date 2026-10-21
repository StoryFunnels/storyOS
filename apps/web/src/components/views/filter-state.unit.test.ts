import { describe, expect, it } from 'vitest';
import { emptyViewCause, filterButtonState } from './filter-state';
import type { FilterGroup } from './filter-config';

const group = (...conds: Array<Record<string, unknown>>): FilterGroup => ({ and: conds }) as unknown as FilterGroup;
const done = (extra: Record<string, unknown> = {}) => ({ field: 'status', op: 'eq', value: 'x', ...extra });

describe('filterButtonState (#965): when the Filter button is yellow', () => {
  it('nothing applied: neutral, no count', () => {
    const s = filterButtonState(undefined, undefined);
    expect(s).toMatchObject({ yellow: false, personalOn: false, applied: 0, buttonCount: 0 });
  });

  it('a PINNED-only filter is yellow, and its chip means the button count is 0', () => {
    const s = filterButtonState(group(done({ pinned: true })), undefined);
    expect(s.yellow).toBe(true);
    expect(s.personalOn).toBe(false);
    expect(s.buttonCount).toBe(0);
  });

  it('a DISABLED-only filter hides nothing: neutral', () => {
    const s = filterButtonState(group(done({ disabled: true })), undefined);
    expect(s.yellow).toBe(false);
    expect(s.applied).toBe(0);
    expect(s.configured).toBe(1);
  });

  it('an UNFINISHED-only filter (#345, no value yet) is never queried: neutral', () => {
    const s = filterButtonState(group({ field: 'status', op: 'eq', value: '' }), undefined);
    expect(s.yellow).toBe(false);
    expect(s.applied).toBe(0);
    expect(s.configured).toBe(1);
  });

  it('a PERSONAL-only filter is yellow with the person mark', () => {
    const s = filterButtonState(undefined, group(done()));
    expect(s).toMatchObject({ yellow: true, personalOn: true, applied: 1, buttonCount: 1 });
  });

  it('a personal condition always counts on the button: it never becomes a chip', () => {
    const s = filterButtonState(group(done({ pinned: true })), group(done({ pinned: true })));
    expect(s.applied).toBe(2);
    expect(s.buttonCount).toBe(1);
  });

  it('counts conditions inside nested groups, not only the top level', () => {
    const nested = { and: [done(), { or: [done(), done({ disabled: true })] }] } as unknown as FilterGroup;
    expect(filterButtonState(nested, undefined)).toMatchObject({ applied: 2, configured: 3 });
  });

  it('valueless ops (is empty) are complete, so they count', () => {
    expect(filterButtonState(group({ field: 'due', op: 'is_empty' }), undefined).yellow).toBe(true);
  });
});

const counts = { total: 10, shown: 0, afterView: 10, afterViewPersonal: 10, hasViewFilter: false, hasPersonal: false, hasSearch: false };

describe('emptyViewCause (#965): why a view is empty', () => {
  it('says nothing while a count is still loading', () => {
    expect(emptyViewCause({ ...counts, total: undefined })).toBeNull();
    expect(emptyViewCause({ ...counts, shown: undefined })).toBeNull();
  });

  it('says nothing when something is shown', () => {
    expect(emptyViewCause({ ...counts, shown: 3, hasViewFilter: true })).toBeNull();
  });

  it('a database with no records at all is "empty" (the coached empty state)', () => {
    expect(emptyViewCause({ ...counts, total: 0 })).toBe('empty');
  });

  it('the view\'s own filter hides everything -> filters', () => {
    expect(emptyViewCause({ ...counts, hasViewFilter: true, afterView: 0, afterViewPersonal: 0 })).toBe('filters');
  });

  it('the view\'s filter keeps some but the PERSONAL filter hides all -> personal', () => {
    expect(emptyViewCause({ ...counts, hasViewFilter: true, hasPersonal: true, afterView: 4, afterViewPersonal: 0 })).toBe('personal');
  });

  it('personal-only narrowing -> personal', () => {
    expect(emptyViewCause({ ...counts, hasPersonal: true, afterViewPersonal: 0 })).toBe('personal');
  });

  it('only Find hides everything -> search', () => {
    expect(emptyViewCause({ ...counts, hasSearch: true })).toBe('search');
  });

  it('filters take the blame before Find when both narrow to zero', () => {
    expect(emptyViewCause({ ...counts, hasViewFilter: true, afterView: 0, hasSearch: true })).toBe('filters');
  });

  it('nothing narrows the view and it is still empty with records existing: no cause to name', () => {
    expect(emptyViewCause(counts)).toBeNull();
  });
});
