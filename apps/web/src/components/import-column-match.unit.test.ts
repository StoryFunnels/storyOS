import { describe, expect, it } from 'vitest';
import { matchExistingField, normalizeColumnKey, type MatchableField } from '@storyos/schemas';

const field = (displayName: string, type = 'text', apiName?: string): MatchableField => ({
  id: `id-${displayName}-${type}`,
  displayName,
  apiName,
  type,
});

describe('normalizeColumnKey (#379)', () => {
  it('ignores case and separators', () => {
    const keys = ['Company Name', 'company_name', 'companyName', 'COMPANY-NAME', 'company name '].map(
      normalizeColumnKey,
    );
    expect(new Set(keys).size, 'all five spellings are one key').toBe(1);
  });

  it('is empty for a name with nothing alphanumeric in it', () => {
    expect(normalizeColumnKey('---')).toBe('');
  });
});

describe('matchExistingField (#379)', () => {
  const fields = [
    field('Website', 'url'),
    field('Company Name'),
    field('Notes', 'rich_text'),
    field('Open Issues', 'rollup'),
    field('Total', 'formula'),
  ];

  it('matches on the display name, ignoring case and separators', () => {
    expect(matchExistingField('website', fields)?.displayName).toBe('Website');
    expect(matchExistingField('company_name', fields)?.displayName).toBe('Company Name');
    expect(matchExistingField('CompanyName', fields)?.displayName).toBe('Company Name');
  });

  it('matches on the api_name too — a StoryOS export carries those', () => {
    const withApi = [field('Monthly Value', 'number', 'monthly_value')];
    expect(matchExistingField('monthly_value', withApi)?.displayName).toBe('Monthly Value');
  });

  it('does NOT fuzzy-match a near miss', () => {
    // The important negative. `contact_email` onto `email` looks helpful and is
    // wrong, and a wrong pre-selection reads as deliberate so nobody re-checks it.
    const withEmail = [field('Email', 'email')];
    expect(matchExistingField('contact_email', withEmail)).toBeNull();
    expect(matchExistingField('websites', fields), 'a plural is a different column').toBeNull();
    expect(matchExistingField('web', fields)).toBeNull();
  });

  it('never matches a field a value cannot be written into', () => {
    // A rollup named Notes would be a destination guaranteed to fail.
    expect(matchExistingField('open_issues', fields), 'rollup').toBeNull();
    expect(matchExistingField('total', fields), 'formula').toBeNull();
  });

  it('refuses an ambiguous match rather than picking one', () => {
    // Two fields normalising the same: choosing is a coin flip the user cannot
    // see, and they would have to notice it to undo it.
    const ambiguous = [field('Company Name'), field('company_name', 'text')];
    expect(matchExistingField('Company Name', ambiguous)).toBeNull();
  });

  it('returns null for an unmatched column and for an empty key', () => {
    expect(matchExistingField('something_else', fields)).toBeNull();
    expect(matchExistingField('---', fields)).toBeNull();
  });
});

/**
 * #432 AC-6 — there is exactly ONE matcher.
 *
 * The rules moved to @storyos/schemas so the copy-record feature can use the
 * identical ones on the API side. The failure this guards is not someone
 * editing them, it is someone re-implementing them next to the new caller —
 * the habit CLAUDE.md's field-surface rules exist to stop (#375, #399, #408 are
 * all one concept that grew a second hardcoded copy).
 *
 * A forked matcher would auto-map a column in the import wizard and refuse it
 * in the copy dialog, which is worse than either behaviour on its own.
 */
describe('#432 — one matcher, not two', () => {
  it('is gone from apps/web — the module was MOVED, not copied', async () => {
    const { existsSync } = await import('node:fs');
    const { join } = await import('node:path');
    expect(
      existsSync(join(import.meta.dirname, 'import-column-match.ts')),
      'apps/web must import the shared matcher, not keep its own',
    ).toBe(false);
  });

  it('normalises the three spellings of one name to one key, wherever it is called from', () => {
    // The behaviour both callers depend on, asserted through the shared entry
    // point so a re-export that silently changed would fail here.
    const key = normalizeColumnKey('Company Name');
    expect(normalizeColumnKey('company_name')).toBe(key);
    expect(normalizeColumnKey('companyName')).toBe(key);
  });
});
