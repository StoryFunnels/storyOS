import { describe, expect, it } from 'vitest';
import { FormulaError, parseFormula } from '@storyos/schemas';
import type { FormulaFieldInfo } from '@storyos/schemas';

/**
 * #760 — the api_name FALLBACK in parseFormula() checked `byApi.has(raw)`
 * un-lowercased, against a set built from api_names, which are ALWAYS
 * lowercase snake_case in this codebase. So the fallback only ever matched a
 * reference typed in that exact lowercase form — never the mixed/upper case
 * a real api_name reference is likely to be typed in, and never a stale
 * display-name reference surviving a rename in the shape #743 hit.
 *
 * This file's own header comment makes a promise the bug broke: field refs
 * are "stored as api_names in the AST so renames never break". That was
 * only true if you happened to type the reference in all-lowercase.
 */
const FIELDS: FormulaFieldInfo[] = [
  { api_name: 'hours_spent', display_name: 'Hours Spent', formula_type: 'number' },
  { api_name: 'renamed_field', display_name: 'New Name', formula_type: 'number' },
];

describe('#760 — the api_name fallback resolves regardless of case', () => {
  it('a reference typed in a case that matches no display name, but IS the api_name in a different case, resolves', () => {
    // "HOURS_SPENT" matches neither "hours spent" (the lowercased display
    // name) nor, before the fix, the api_name set (which held only the
    // lowercase form). This is the fallback path itself, isolated from any
    // rename.
    const node = parseFormula('{HOURS_SPENT}', FIELDS);
    expect(node).toEqual({ kind: 'ref', api_name: 'hours_spent' });
  });

  it('the exact-case api_name still resolves (no regression on the one case that always worked)', () => {
    expect(parseFormula('{hours_spent}', FIELDS)).toEqual({ kind: 'ref', api_name: 'hours_spent' });
  });

  it('the display name still resolves exactly as before — this fix only touches the fallback', () => {
    expect(parseFormula('{Hours Spent}', FIELDS)).toEqual({ kind: 'ref', api_name: 'hours_spent' });
    // Case-insensitivity on the display path is pre-existing behavior, not
    // part of this fix — asserted here so a future change can't quietly
    // narrow it while "fixing" the fallback.
    expect(parseFormula('{hours spent}', FIELDS)).toEqual({ kind: 'ref', api_name: 'hours_spent' });
  });

  it('#743 shape: a reference to a field\'s RENAMED-AWAY-FROM display name fails with a clear error, never silently', () => {
    // `renamed_field`'s display name is "New Name" today; "Old Name" is
    // nobody's current display name AND isn't the api_name either. This must
    // stay a clear, expected error — not resolve to the wrong field, and not
    // crash.
    expect(() => parseFormula('{Old Name}', FIELDS)).toThrow(FormulaError);
    expect(() => parseFormula('{Old Name}', FIELDS)).toThrow(/Unknown field/);
  });

  it('#743 shape: a reference to the api_name itself survives any future display-name rename', () => {
    // This is the actual promise this file's header makes, verified: once a
    // formula's stored reference resolves to an api_name, re-parsing the
    // SOURCE TEXT via that api_name (not the since-changed display name)
    // still works after the field's display name has moved on.
    expect(parseFormula('{renamed_field}', FIELDS)).toEqual({ kind: 'ref', api_name: 'renamed_field' });
    expect(parseFormula('{RENAMED_FIELD}', FIELDS)).toEqual({ kind: 'ref', api_name: 'renamed_field' });
  });

  it('the same fallback fix applies across a relation reference ({Relation.Field})', () => {
    const withRelation: FormulaFieldInfo[] = [
      {
        api_name: 'epic',
        display_name: 'Epic',
        formula_type: 'relation',
        related: [{ api_name: 'story_points', display_name: 'Story Points', formula_type: 'number' }],
      },
    ];
    // Neither side of the dotted reference matches any display name here —
    // both must fall back to their api_name, case-insensitively.
    expect(parseFormula('{EPIC.STORY_POINTS}', withRelation)).toEqual({
      kind: 'rel',
      relation: 'epic',
      field: 'story_points',
    });
  });

  it('AC3 — when two entries share a display name, the reference resolves to ONE field, not silently to whichever was constructed last by accident', () => {
    // Mirrors the shape #743's relabel would produce: two system-field-style
    // entries both reading "ID". `byDisplay` is built from an array via Map
    // construction, so the LAST entry sharing a key wins — asserted here
    // explicitly rather than left as an unverified assumption, per Otto's
    // instruction that this must be confirmed before #743's relabel ships.
    const sharedDisplayName: FormulaFieldInfo[] = [
      { api_name: 'number', display_name: 'ID', formula_type: 'number' },
      { api_name: 'id', display_name: 'ID', formula_type: 'number' },
    ];
    expect(parseFormula('{ID}', sharedDisplayName)).toEqual({ kind: 'ref', api_name: 'id' });
    // The non-canonical entry is still reachable — through its api_name.
    expect(parseFormula('{number}', sharedDisplayName)).toEqual({ kind: 'ref', api_name: 'number' });
  });
});
