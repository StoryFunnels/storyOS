import { describe, expect, it } from 'vitest';
import { cellToText } from './cell-text';
import type { Field } from './use-table-data';

/**
 * MN-294: cellToText() (the shared copy-to-clipboard / cross-type-paste-fallback
 * serializer, MN-135/MN-015) had every field type covered except `user` — it fell
 * through to `default: String(value)`, so copying an Assignee cell put the raw
 * better-auth user id on the clipboard instead of the name shown on screen.
 */

const userField = (over: Partial<Field> = {}): Field =>
  ({ id: 'assignee', apiName: 'assignee', displayName: 'Assignee', type: 'user', ...over }) as Field;

const names: Record<string, string> = {
  'usr-1': 'Ada Lovelace',
  'usr-2': 'Grace Hopper',
};
const resolve = (id: string) => names[id] ?? id;

describe('cellToText — user field (MN-294)', () => {
  it('copies the display name for a single-user value, not the raw id', () => {
    expect(cellToText(userField(), 'usr-1', resolve)).toBe('Ada Lovelace');
  });

  it('joins multi-user values with ", " — the same convention multi_select already uses', () => {
    expect(cellToText(userField(), ['usr-1', 'usr-2'], resolve)).toBe('Ada Lovelace, Grace Hopper');
  });

  it('falls back to the raw id when no resolver is supplied', () => {
    // paste.ts's cross-type coercion fallback calls cellToText without a
    // resolver (it's a pure module with no member data) — must not throw and
    // must still return something sane rather than blowing up.
    expect(cellToText(userField(), 'usr-1')).toBe('usr-1');
  });

  it('falls back to the raw id for a member the resolver does not recognize', () => {
    expect(cellToText(userField(), 'usr-999', resolve)).toBe('usr-999');
  });

  it('returns an empty string for an unset user cell', () => {
    expect(cellToText(userField(), null, resolve)).toBe('');
    expect(cellToText(userField(), undefined, resolve)).toBe('');
  });

  it('filters out empty/non-string entries in a multi-user array rather than printing them', () => {
    expect(cellToText(userField(), ['usr-1', '', null as unknown as string], resolve)).toBe('Ada Lovelace');
  });
});

describe('cellToText — unrelated field types are unaffected (no regression from the signature change)', () => {
  const selectField = (): Field =>
    ({
      id: 'state',
      apiName: 'state',
      displayName: 'State',
      type: 'select',
      options: [{ id: 'opt-1', label: 'Done', color: 'green' }],
    }) as Field;

  it('select still resolves to its option label without a resolver argument', () => {
    expect(cellToText(selectField(), 'opt-1')).toBe('Done');
  });
});
