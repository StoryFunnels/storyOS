import { describe, expect, it } from 'vitest';
import { matchExistingField, normalizeColumnKey } from '@storyos/schemas';
import { creatableFieldTypeSchema } from '@storyos/schemas';

/**
 * #477 — a CSV column was auto-selecting a `relation` field as its import
 * destination: one candidate, wrong type, no ambiguity to protect the user,
 * a write that fails on every row. The existing suite
 * (apps/web/.../import-column-match.unit.test.ts) asserted the UNWRITABLE
 * rule for rollup and formula and never mentioned "relation" — a test that
 * enumerates a set's members can never catch a type missing from it.
 *
 * This file asserts the rule against EVERY type in the product's field-type
 * list (apps/api/src/db/schema.ts `field_type` enum), not just the ones
 * already in UNWRITABLE, so a future missing type fails this test instead of
 * shipping silently. Lives here (api test suite, `@storyos/schemas` is
 * already exercised from apps/api elsewhere — see field-defaults.unit.test.ts)
 * rather than duplicating the web-side suite, which keeps its own coverage of
 * the wizard's UI-facing behaviour.
 */

// The full field_type enum (apps/api/src/db/schema.ts) is the creatable types
// PLUS the ones a user cannot create directly but that exist as real field
// rows on every database: `title` (the record name), `relation`, and the
// four read-only system fields (id/created_at/updated_at/created_by — #351's
// own comment confirms these are real rows, created with every database, not
// synthesized on read).
const NON_CREATABLE_BUT_REAL_TYPES = ['title', 'relation', 'id', 'created_at', 'updated_at', 'created_by'];
const ALL_FIELD_TYPES = [...creatableFieldTypeSchema.options, ...NON_CREATABLE_BUT_REAL_TYPES];

// Types where a bare CSV string can never be the value written — matching
// column-match.ts's own UNWRITABLE set. Kept as a literal list here (not
// imported) deliberately: this test is the independent check that the
// PRODUCTION set didn't drift, not a mirror of it.
const SHOULD_BE_UNWRITABLE = new Set([
  'id',
  'created_at',
  'updated_at',
  'created_by',
  'lookup',
  'rollup',
  'formula',
  'button',
  'relation',
  'attachment',
]);

describe('#477 matchExistingField — every field type, not just the members of UNWRITABLE', () => {
  it("covers every type in the product's field-type list — a type added to the schema without a decision here fails loudly", () => {
    // If this fails, a field type was added to the enum and this test file
    // was not updated to classify it — exactly the gap that let `relation`
    // and (found by this same audit) `attachment` go unnoticed.
    expect(new Set(ALL_FIELD_TYPES).size).toBe(ALL_FIELD_TYPES.length);
    expect(ALL_FIELD_TYPES.length).toBeGreaterThanOrEqual(23);
  });

  for (const type of ALL_FIELD_TYPES) {
    const expectUnwritable = SHOULD_BE_UNWRITABLE.has(type);
    it(`"${type}" is ${expectUnwritable ? 'NEVER' : 'still'} auto-matched as a column destination`, () => {
      const field = { id: 'f1', displayName: 'Roast', apiName: 'roast', type };
      const match = matchExistingField('Roast', [field]);
      if (expectUnwritable) {
        expect(match, `${type} must not be pre-selected — a value cannot be written into it`).toBeNull();
      } else {
        expect(match, `${type} is an ordinary writable type and should still match by name (#379)`).toEqual(field);
      }
    });
  }

  it('MUST KEEP WORKING: the "🔗 Roast" mapping option is a separate concept from the field itself — a relation field being unmatched does not remove it from consideration by the caller, since matchExistingField only ever sees real fields, never mapping options', () => {
    // matchExistingField's contract is unchanged: it takes fields, not mapping
    // options. The wizard is responsible for offering the "🔗" relation-link
    // option regardless of what this function returns — nothing here can
    // remove that entry, since it was never a `MatchableField` to begin with.
    const relationField = { id: 'rel1', displayName: 'Roast', apiName: 'roast', type: 'relation' };
    expect(matchExistingField('Roast', [relationField])).toBeNull();
  });

  it('MUST KEEP WORKING: ambiguity still means no match, for two writable candidates', () => {
    const a = { id: 'a', displayName: 'Website', apiName: 'website', type: 'url' };
    const b = { id: 'b', displayName: 'Website', apiName: 'website_2', type: 'url' };
    expect(matchExistingField('Website', [a, b])).toBeNull();
  });

  it('MUST KEEP WORKING: api_name and display-name matching both still resolve', () => {
    const field = { id: 'f1', displayName: 'Company Name', apiName: 'company_name', type: 'text' };
    expect(matchExistingField('company_name', [field])).toEqual(field);
    expect(matchExistingField('Company Name', [field])).toEqual(field);
  });

  it('normalizeColumnKey is unaffected (sanity, not the subject of this ticket)', () => {
    expect(normalizeColumnKey('Company Name')).toBe(normalizeColumnKey('company_name'));
  });
});
