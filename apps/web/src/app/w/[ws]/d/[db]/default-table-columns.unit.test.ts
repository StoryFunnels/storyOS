import { describe, expect, it } from 'vitest';
import { defaultTableHiddenFieldIds } from './default-table-columns';
import type { Field } from '@/components/table-view/use-table-data';

function field(apiName: string, type = 'text'): Field {
  return { id: `f_${apiName}`, apiName, displayName: apiName, type, config: {}, isSystem: false };
}

describe('defaultTableHiddenFieldIds — #739 AC1/T1, corrected: derived by type + schema order, never by name', () => {
  it('storyos/issues\' REAL schema: picks workflow/select/select/user, not the relation named "Next" — the exact case that broke the hardcoded list', () => {
    // Real field order from storyos/issues: name, human, state, priority,
    // assignee, type, epic, agents("Next"). Otto's own corrected expectation:
    // ID/Name/State/Priority/Type/Assignee — Assignee (user, schema position
    // 5) outranks the "Next" relation (schema position 8) under the rule,
    // and that is the RULE working, not a bug — a hand-picked "Next" encoded
    // this workspace's own agent fleet as if it were universal.
    const fields = [
      field('name', 'title'),
      field('human', 'checkbox'),
      field('state', 'workflow'),
      field('priority', 'select'),
      field('assignee', 'user'),
      field('type', 'select'),
      field('epic', 'relation'),
      field('agents', 'relation'), // display name "Next", api_name unrelated
    ];
    const hidden = new Set(defaultTableHiddenFieldIds(fields));
    expect(hidden.has('f_state')).toBe(false);
    expect(hidden.has('f_priority')).toBe(false);
    expect(hidden.has('f_type')).toBe(false);
    expect(hidden.has('f_assignee')).toBe(false);
    expect(hidden.has('f_human')).toBe(true);
    expect(hidden.has('f_epic')).toBe(true);
    expect(hidden.has('f_agents')).toBe(true);
  });

  it('title is never hidden regardless of its api_name', () => {
    const fields = [field('name', 'title')];
    expect(defaultTableHiddenFieldIds(fields)).toEqual([]);
  });

  it('prefers types in order — workflow, then select, then user, then relation — within a type, schema order', () => {
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
    // workflow first despite later schema position, then selects in schema
    // order, then user — that's exactly 4, so the relation field is cut.
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
