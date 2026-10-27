import { describe, expect, it } from 'vitest';
import { ALL_PAGES_CAP, shouldLoadNextPage } from './use-table-data';

/** A grouped view loads every page of its records; the decision of WHEN to ask for the next one. */
describe('shouldLoadNextPage', () => {
  const base = { enabled: true, hasNextPage: true, isFetchingNextPage: false, pages: 1 };
  it('asks while grouped, a page remains and nothing is in flight', () => {
    expect(shouldLoadNextPage(base)).toBe(true);
  });
  it('does not ask when the view is not grouped, when the last page is in, or while a page is loading', () => {
    expect(shouldLoadNextPage({ ...base, enabled: false })).toBe(false);
    expect(shouldLoadNextPage({ ...base, hasNextPage: false })).toBe(false);
    expect(shouldLoadNextPage({ ...base, isFetchingNextPage: true })).toBe(false);
  });
  it('stops at the cap so a runaway database cannot pin the tab', () => {
    expect(shouldLoadNextPage({ ...base, pages: ALL_PAGES_CAP - 1 })).toBe(true);
    expect(shouldLoadNextPage({ ...base, pages: ALL_PAGES_CAP })).toBe(false);
  });
});
