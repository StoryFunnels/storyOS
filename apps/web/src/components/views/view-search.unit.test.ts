import { describe, expect, it } from 'vitest';
import { normalizeSearch } from './view-search';
import { queryBodyFromConfig } from './use-view-state';
import { SHORTCUTS } from '@/lib/shortcuts';

describe('normalizeSearch (#835)', () => {
  it('drops blank and whitespace-only text — a blank must never narrow the view', () => {
    expect(normalizeSearch('')).toBeUndefined();
    expect(normalizeSearch('   ')).toBeUndefined();
    expect(normalizeSearch(undefined)).toBeUndefined();
    expect(normalizeSearch(null)).toBeUndefined();
  });
  it('trims, and keeps interior spaces', () => {
    expect(normalizeSearch('  fix login  ')).toBe('fix login');
  });
  it("caps at the API's 200-char limit instead of sending a request it would reject", () => {
    expect(normalizeSearch('a'.repeat(500))).toHaveLength(200);
  });
});

describe('queryBodyFromConfig carries the search (#835)', () => {
  const config = { filters: undefined, sorts: [] } as never;
  it('sends q alongside — not instead of — the view filter and sorts', () => {
    const body = queryBodyFromConfig(
      { sorts: [{ field: 'priority', dir: 'asc' }] } as never,
      { field: 'state', op: 'is', value: 'open' } as never,
      'login',
    );
    expect(body.q).toBe('login');
    expect(body.filter).toBeTruthy();
    expect(body.sorts).toBeTruthy();
  });
  it('omits q entirely when there is no search (keeps every existing request byte-identical)', () => {
    expect('q' in queryBodyFromConfig(config)).toBe(false);
    expect('q' in queryBodyFromConfig(config, undefined, undefined)).toBe(false);
  });
});

describe('the find shortcut is discoverable (#835 AC8)', () => {
  it('is registered once, as a platform-neutral mod+ token', () => {
    const find = SHORTCUTS.filter((s) => s.id === 'find');
    expect(find).toHaveLength(1);
    expect(find[0]!.keys).toBe('mod+F');
  });
  it('does not displace the workspace palette', () => {
    expect(SHORTCUTS.find((s) => s.id === 'palette')?.keys).toBe('mod+K');
  });
});
