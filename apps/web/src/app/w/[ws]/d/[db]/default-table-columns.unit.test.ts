import { describe, expect, it } from 'vitest';
import { defaultTableHiddenFieldIds } from './default-table-columns';
import type { Field } from '@/components/table-view/use-table-data';

function field(apiName: string, type = 'text'): Field {
  return { id: `f_${apiName}`, apiName, displayName: apiName, type, config: {}, isSystem: false };
}

describe('defaultTableHiddenFieldIds — #739 AC1/T1, corrected: derived by type + schema order, never by name', () => {
  it('storyos/issues\' REAL schema: picks workflow/select/select/user, not the relation named "Next" — the exact case that broke the hardcoded list', () => {
    // THE WHOLE SCHEMA, all 27 fields, in order — not a prefix of it.
    //
    // This fixture previously stopped at `agents` (8 fields) and called itself
    // "REAL". It was green while the product was wrong: the truncation cut the
    // list off BEFORE `verdict` at position 20, and verdict is a select. Under
    // the shipped rule every select was taken before any user field, so the
    // real database produced state/priority/type/VERDICT while this test
    // asserted assignee. A fixture that is a prefix of reality passes for
    // exactly the cases it omits.
    const fields = [
      field('name', 'title'),
      field('human', 'checkbox'),
      field('state', 'workflow'),
      field('priority', 'select'),
      field('assignee', 'user'),
      field('type', 'select'),
      field('epic', 'relation'),
      field('agents', 'relation'), // display name "Next", api_name unrelated
      field('details', 'rich_text'),
      field('acceptance_criteria', 'rich_text'),
      field('source', 'text'),
      field('done', 'button'),
      field('user_story', 'rich_text'),
      field('expected_vs_actual', 'text'),
      field('website_tasks', 'relation'),
      field('pull_requests', 'relation'),
      field('docs_tasks', 'relation'),
      field('parent', 'relation'),
      field('sub_items', 'relation'),
      field('verdict', 'select'), // position 20 — the field the old fixture cut off
      field('memory_from_this_issue', 'relation'),
      field('number', 'id'),
      field('id', 'id'),
      field('created_at', 'created_at'),
      field('updated_at', 'updated_at'),
      field('created_by', 'created_by'),
      field('updated_by', 'updated_by'),
    ];
    const hidden = new Set(defaultTableHiddenFieldIds(fields));
    expect(hidden.has('f_state')).toBe(false);
    expect(hidden.has('f_priority')).toBe(false);
    expect(hidden.has('f_type')).toBe(false);
    expect(hidden.has('f_assignee')).toBe(false);
    // The regression guard: verdict is a select at position 20. Under the old
    // type-grouped rule it displaced assignee here.
    expect(hidden.has('f_verdict')).toBe(true);
    expect(hidden.has('f_updated_by')).toBe(true);
    expect(hidden.has('f_human')).toBe(true);
    expect(hidden.has('f_epic')).toBe(true);
    expect(hidden.has('f_agents')).toBe(true);
  });

  it('title is never hidden regardless of its api_name', () => {
    const fields = [field('name', 'title')];
    expect(defaultTableHiddenFieldIds(fields)).toEqual([]);
  });

  it('preferred TYPES are an eligibility tier; schema order decides within it', () => {
    // Two select fields and one workflow, deliberately out of preference
    // order in the array, to prove type preference beats raw position.
    const fields = [
      field('name', 'title'),
      field('a_select', 'select'), // schema pos 1 among non-title
      field('b_workflow', 'workflow'), // schema pos 2, but higher-preference type
      field('c_select', 'select'), // schema pos 3
      field('d_user', 'user'), // schema pos 4
      field('e_relation', 'relation'), // schema pos 5 — 5th preferred-type field, doesn't fit in 4
    ];
    const hidden = new Set(defaultTableHiddenFieldIds(fields));
    const visible = new Set(fields.map((f) => f.id).filter((id) => !hidden.has(id)));
    // All five are preferred-type fields, so the tier admits all of them and
    // schema order picks the first four — the relation at position 5 is cut.
    // The SET is the same either way here; what changed is why. Type rank no
    // longer reorders fields inside the tier, because doing so let three
    // selects crowd out a user field on the real storyos/issues schema.
    expect(visible).toEqual(new Set(['f_name', 'f_b_workflow', 'f_a_select', 'f_c_select', 'f_d_user']));
  });

  it(
    'THE REGRESSION CASE — a database with none of state/priority/type/assignee (no workflow/select/user/relation at ' +
      'all) still gets a sensible six-column default, filling from other eligible fields in schema order rather than ' +
      'degrading to ID + Name alone',
    () => {
      const fields = [
        field('name', 'title'),
        field('email', 'email'),
        field('phone', 'text'),
        field('fax', 'text'),
        field('website', 'url'),
        field('notes', 'text'),
      ];
      const hidden = defaultTableHiddenFieldIds(fields);
      // First four eligible fields in schema order are visible; the fifth
      // (notes) is the one left over once the four-column cap is reached.
      expect(hidden).toEqual(['f_notes']);
    },
  );

  it('fills remaining slots from other eligible fields when fewer than four preferred-type fields exist', () => {
    const fields = [
      field('name', 'title'),
      field('status', 'select'), // 1 preferred-type field
      field('owner_note', 'text'), // fallback fill, schema order
      field('channel', 'text'),
      field('region', 'text'),
      field('archived_reason', 'text'), // 5th fallback candidate — cut by the cap
    ];
    const hidden = defaultTableHiddenFieldIds(fields);
    expect(hidden).toEqual(['f_archived_reason']);
  });

  it('never promotes rich_text, HIDDEN_TYPES (id/created_by), system dates, or button into the default set', () => {
    const fields = [
      field('name', 'title'),
      field('brief', 'rich_text'),
      field('raw_id', 'id'),
      field('creator', 'created_by'),
      field('created', 'created_at'),
      field('updated', 'updated_at'),
      field('mark_done', 'button'),
      field('status', 'select'), // the one real candidate
    ];
    const hidden = new Set(defaultTableHiddenFieldIds(fields));
    for (const excluded of ['f_brief', 'f_raw_id', 'f_creator', 'f_created', 'f_updated', 'f_mark_done']) {
      expect(hidden.has(excluded), `${excluded} must stay hidden by default`).toBe(true);
    }
    expect(hidden.has('f_status')).toBe(false);
  });
});
