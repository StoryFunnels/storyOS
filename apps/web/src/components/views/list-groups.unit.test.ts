import { describe, expect, it } from 'vitest';
import { arrangeBoardColumns } from './board-columns';
import { canGroupListBy, listGroupDisabledReason } from './groupable-fields';
import { NO_VALUE, buildListGroups, type ListGroupField } from './list-groups';
import { noValueLabelFor } from './group-chip';

/**
 * Fixture: the REAL Team Wiki "Pages" schema and the "All pages" view config, as `team-wiki.ts` builds
 * them (every field, both relations, all three Status options), not a prefix of it. The pack stores
 * `config: { group_by_field_id: <Team field id> }` on a list view; install resolves the field ref to an id.
 * The relation field shape (cardinality/side) is what the API serialises for the "from" side of
 * `{ from: 'Pages', to: 'Teams', cardinality: 'one_to_many', from_field: 'Team' }`.
 */
const TEAM_ID = 'fld-team';
const PAGES_FIELDS: Array<ListGroupField & { id: string; relation?: { cardinality: string; side: string } | null }> = [
  { id: 'fld-owner', type: 'user', apiName: 'owner', displayName: 'Owner' },
  { id: 'fld-reviewed', type: 'date', apiName: 'last_reviewed', displayName: 'Last reviewed' },
  {
    id: 'fld-status',
    type: 'workflow',
    apiName: 'status',
    displayName: 'Status',
    options: [
      { id: 'o-draft', label: 'Draft', color: 'gray', category: 'unstarted' },
      { id: 'o-verified', label: 'Verified', color: 'green', category: 'completed' },
      { id: 'o-review', label: 'Needs review', color: 'gold', category: 'started' },
    ],
  },
  { id: TEAM_ID, type: 'relation', apiName: 'team', displayName: 'Team', relation: { cardinality: 'one_to_many', side: 'a' } },
  { id: 'fld-parent', type: 'relation', apiName: 'parent_page', displayName: 'Parent page', relation: { cardinality: 'one_to_many', side: 'a' } },
  { id: 'fld-sub', type: 'relation', apiName: 'sub_pages', displayName: 'Sub-pages', relation: { cardinality: 'one_to_many', side: 'b' } },
];
const ALL_PAGES_VIEW = { type: 'list', config: { group_by_field_id: TEAM_ID } };
const team = PAGES_FIELDS.find((f) => f.id === ALL_PAGES_VIEW.config.group_by_field_id)!;
const status = PAGES_FIELDS.find((f) => f.id === 'fld-status')!;

const EVERYONE = { id: 't-everyone', title: 'Everyone' };
const page = (title: string, teamChips: Array<{ id: string; title: string }>, st?: string) => ({
  title,
  values: { team: teamChips, ...(st ? { status: st } : {}) },
});
const SAMPLE = [
  page('Home', [EVERYONE], 'o-draft'),
  page('Onboarding', [EVERYONE], 'o-draft'),
  page('How we work', [EVERYONE], 'o-draft'),
  page('Tools & accounts', [EVERYONE], 'o-draft'),
];
type Row = { title: string; values: Record<string, unknown> };
const build = (field: ListGroupField, rows: Row[], targets?: Array<{ id: string; title: string }>) =>
  buildListGroups({ field, rows, targets, neutralColor: 'grey', optionColor: (n) => `c:${n}` });

describe('the real All pages view is groupable (ticket #1147)', () => {
  it('the pack stores a list grouped by Team, and the list picker accepts exactly that field', () => {
    expect(ALL_PAGES_VIEW.type).toBe('list');
    expect(canGroupListBy(team)).toBe(true);
    expect(listGroupDisabledReason(team)).toBeNull();
  });

  it('offers Status, Team and Parent page, and refuses the many side (Sub-pages), Owner and dates', () => {
    expect(PAGES_FIELDS.filter(canGroupListBy).map((f) => f.displayName)).toEqual(['Status', 'Team', 'Parent page']);
  });
});

describe('buildListGroups - relation', () => {
  it('draws a heading per related record, titled by the record, with its rows and count', () => {
    const groups = build(team, SAMPLE, [EVERYONE]);
    const everyone = groups.find((g) => g.id === 't-everyone')!;
    expect(everyone.label).toBe('Everyone');
    expect(everyone.rows.map((r) => r.title)).toEqual(['Home', 'Onboarding', 'How we work', 'Tools & accounts']);
  });

  it('always has a "No Team" bucket, empty here, last', () => {
    const groups = build(team, SAMPLE, [EVERYONE]);
    expect(groups.at(-1)).toMatchObject({ id: NO_VALUE, label: 'No Team' });
    expect(groups.at(-1)!.rows).toEqual([]);
  });

  it('puts a page with no team, and a page whose chip is empty, in "No Team"', () => {
    const rows = [...SAMPLE, page('Orphan', []), { title: 'NoKey', values: {} }];
    const none = build(team, rows, [EVERYONE]).find((g) => g.id === NO_VALUE)!;
    expect(none.rows.map((r) => r.title)).toEqual(['Orphan', 'NoKey']);
  });

  it('keeps the target database order, and lists a team that has no pages yet (count 0)', () => {
    const design = { id: 't-design', title: 'Design' };
    const groups = build(team, SAMPLE, [design, EVERYONE]);
    expect(groups.map((g) => [g.label, g.rows.length])).toEqual([['Design', 0], ['Everyone', 4], ['No Team', 0]]);
  });

  it('an untitled related record is headed "Untitled", never blank', () => {
    expect(build(team, SAMPLE, [{ id: 't-everyone', title: '' }])[0]!.label).toBe('Untitled');
  });

  it('a chip beyond the loaded targets page still gets its own heading, not "No Team"', () => {
    const far = { id: 't-far', title: 'Far team' };
    const groups = build(team, [...SAMPLE, page('Far page', [far])], [EVERYONE]);
    expect(groups.find((g) => g.id === 't-far')).toMatchObject({ label: 'Far team' });
    expect(groups.find((g) => g.id === NO_VALUE)!.rows).toEqual([]);
  });

  it('with the targets query still loading, groups come from the rows alone', () => {
    const groups = build(team, SAMPLE, undefined);
    expect(groups.map((g) => g.label)).toEqual(['Everyone', 'No Team']);
  });

  it('a row with two chips sits under the FIRST only (never twice)', () => {
    const other = { id: 't-other', title: 'Other' };
    const groups = build(team, [page('Both', [EVERYONE, other])], [EVERYONE, other]);
    expect(groups.flatMap((g) => g.rows).length).toBe(1);
    expect(groups.find((g) => g.id === 't-everyone')!.rows.length).toBe(1);
  });

  it('a hide-empty-groups view drops empty teams and the empty No Team bucket through the shared arranger', () => {
    const design = { id: 't-design', title: 'Design' };
    const arranged = arrangeBoardColumns(
      build(team, SAMPLE, [design, EVERYONE]),
      { hide_empty_groups: true },
      { groupType: 'relation', hasMore: false },
    ).filter((g) => g.rows.length > 0 || g.id !== NO_VALUE);
    expect(arranged.map((g) => g.label)).toEqual(['Everyone']);
  });

  it('names the no-value switch after the same bucket the list draws', () => {
    expect(noValueLabelFor('relation', { viewType: 'list', fieldName: 'Team' })).toBe('No Team');
    expect(noValueLabelFor('relation', { viewType: 'board', fieldName: 'Team' })).toBe('Unassigned');
  });
});

describe('buildListGroups - Status grouping is unchanged', () => {
  it('one heading per option in option order with colour and state category, then No value', () => {
    const groups = build(status, SAMPLE);
    expect(groups.map((g) => [g.label, g.rows.length, g.category])).toEqual([
      ['Draft', 4, 'unstarted'],
      ['Verified', 0, 'completed'],
      ['Needs review', 0, 'started'],
      ['No value', 0, null],
    ]);
    expect(groups[0]!.color).toBe('c:gray');
    expect(groups.at(-1)!.color).toBe('grey');
  });

  it('a row with no status, or an unknown option id, falls to No value', () => {
    const rows = [page('A', []), page('B', [], 'o-gone')];
    expect(build(status, rows).find((g) => g.id === NO_VALUE)!.rows.map((r) => r.title)).toEqual(['A', 'B']);
  });
});
