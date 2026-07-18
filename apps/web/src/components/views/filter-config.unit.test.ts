import { describe, expect, it } from 'vitest';
import {
  activeFilterNode,
  buildFilterGroup,
  canMoveNodeTo,
  canTurnIntoGroup,
  duplicateNodeAt,
  filterConditions,
  filterConnector,
  flattenFilterTree,
  getNodeAt,
  measureFilterNode,
  moveNodeTo,
  pathFromId,
  removeNodeCascade,
  reorderConditions,
  turnIntoGroup,
  ungroupNodeAt,
} from './filter-config';
import type { FilterCondition, FilterNode } from './filter-config';

/**
 * MN-253: the filtering overhaul's pure logic — And/Or connector round-tripping,
 * disabled clauses dropping out of the executed query, drag-reorder, and pin/label/
 * icon surviving a round trip through the persisted FilterGroup shape.
 */

const cond = (over: Partial<FilterCondition>): FilterCondition => ({
  field: 'state',
  op: 'eq',
  value: 'done',
  ...over,
});

describe('filterConnector / filterConditions', () => {
  it('reads "and" as the connector for an {and:[...]} group', () => {
    const group = { and: [cond({})] };
    expect(filterConnector(group)).toBe('and');
    expect(filterConditions(group)).toEqual([cond({})]);
  });

  it('reads "or" as the connector for an {or:[...]} group', () => {
    const group = { or: [cond({})] };
    expect(filterConnector(group)).toBe('or');
    expect(filterConditions(group)).toEqual([cond({})]);
  });

  it('defaults to "and" and an empty list when there is no filter', () => {
    expect(filterConnector(undefined)).toBe('and');
    expect(filterConditions(undefined)).toEqual([]);
  });

  it('treats a bare, unwrapped condition as a one-element list without crashing', () => {
    // templates.service.ts (API) seeds a view's filter unwrapped when it has
    // exactly one clause — same shape queryBodyFromConfig sends for a single
    // active condition. filterConditions must not assume every filter has an
    // `and`/`or` key, or a templated workspace's first view load throws.
    const bare = cond({ field: 'assignee', op: 'has', value: ['me'] });
    expect(filterConnector(bare as never)).toBe('and');
    expect(filterConditions(bare as never)).toEqual([bare]);
  });
});

describe('buildFilterGroup — the And/Or toggle', () => {
  const conditions = [cond({ field: 'state' }), cond({ field: 'priority', value: 'high' })];

  it('switching the connector rebuilds the SAME shape the backend already supports (no second format)', () => {
    const andGroup = buildFilterGroup('and', conditions);
    expect(andGroup).toEqual({ and: conditions });

    const orGroup = buildFilterGroup('or', conditions);
    expect(orGroup).toEqual({ or: conditions });

    // Round-trips: connector + conditions survive going back through the readers.
    expect(filterConnector(orGroup)).toBe('or');
    expect(filterConditions(orGroup)).toEqual(conditions);
  });

  it('returns undefined for an empty condition list, in either connector', () => {
    expect(buildFilterGroup('and', [])).toBeUndefined();
    expect(buildFilterGroup('or', [])).toBeUndefined();
  });
});

describe('activeFilterNode — disabled clauses never reach the query', () => {
  it('drops a disabled clause entirely, keeping the rest', () => {
    const group = buildFilterGroup('and', [
      cond({ field: 'state', disabled: true }),
      cond({ field: 'priority', value: 'high' }),
    ]);
    expect(activeFilterNode(group)).toEqual({ field: 'priority', op: 'eq', value: 'high' });
  });

  it('returns undefined when every clause is disabled', () => {
    const group = buildFilterGroup('and', [cond({ disabled: true })]);
    expect(activeFilterNode(group)).toBeUndefined();
  });

  it('strips UI-only fields (pinned/label/icon/disabled) from the survivors', () => {
    const group = buildFilterGroup('and', [
      cond({ pinned: true, label: 'My filter', icon: 'set:flag', disabled: false }),
    ]);
    expect(activeFilterNode(group)).toEqual({ field: 'state', op: 'eq', value: 'done' });
  });

  it('wraps 2+ active conditions under the connector, and sends a bare condition for exactly 1', () => {
    const two = buildFilterGroup('or', [cond({ field: 'a' }), cond({ field: 'b' })]);
    expect(activeFilterNode(two)).toEqual({
      or: [
        { field: 'a', op: 'eq', value: 'done' },
        { field: 'b', op: 'eq', value: 'done' },
      ],
    });

    const one = buildFilterGroup('or', [cond({ field: 'a' })]);
    expect(activeFilterNode(one)).toEqual({ field: 'a', op: 'eq', value: 'done' });
  });

  it('returns undefined when there is no filter at all', () => {
    expect(activeFilterNode(undefined)).toBeUndefined();
  });
});

describe('reorderConditions — drag-reorder state', () => {
  it('moves a condition from one index to another, keeping the rest in place', () => {
    const conditions = [cond({ field: 'a' }), cond({ field: 'b' }), cond({ field: 'c' })];
    const reordered = reorderConditions(conditions, 0, 2);
    expect(reordered.map((c) => c.field)).toEqual(['b', 'c', 'a']);
  });

  it('is a no-op when from === to', () => {
    const conditions = [cond({ field: 'a' }), cond({ field: 'b' })];
    expect(reorderConditions(conditions, 1, 1).map((c) => c.field)).toEqual(['a', 'b']);
  });

  it('does not mutate the input array', () => {
    const conditions = [cond({ field: 'a' }), cond({ field: 'b' })];
    reorderConditions(conditions, 0, 1);
    expect(conditions.map((c) => c.field)).toEqual(['a', 'b']);
  });
});

describe('pin / label / icon round-trip (the formalized ad-hoc chip pattern)', () => {
  it('a pinned condition keeps its custom label and icon through the group shape', () => {
    const pinned = cond({ pinned: true, label: 'State is none of Done', icon: 'set:flag', op: 'has_none' });
    const group = buildFilterGroup('and', [pinned]);
    const [restored] = filterConditions(group) as [FilterCondition | undefined];
    expect(restored).toEqual(pinned);
    expect(restored?.pinned).toBe(true);
    expect(restored?.label).toBe('State is none of Done');
    expect(restored?.icon).toBe('set:flag');
  });

  it('unpinning clears only the pinned flag, leaving label/icon/disabled untouched', () => {
    const pinned = cond({ pinned: true, label: 'Custom name', icon: 'set:flag', disabled: true });
    const conditions = filterConditions(buildFilterGroup('and', [pinned]));
    const unpinned = conditions.map((c) => ({ ...c, pinned: false }));
    expect(unpinned[0]).toEqual({ ...pinned, pinned: false });
  });
});

/**
 * MN-258: nested groups. "Turn into Group" / ungroup / duplicate / remove / drag
 * across boundaries — every op is a pure function over `FilterNode[]`, addressed
 * by `path: number[]` (indices from the top level down through nested group
 * children), so each can be tested against the exact tree shape the backend's
 * recursive FilterNode AST already accepts (packages/schemas query.ts).
 */

const A = cond({ field: 'a' });
const B = cond({ field: 'b' });
const C = cond({ field: 'c' });
const D = cond({ field: 'd' });

describe('turnIntoGroup — "Turn into Group"', () => {
  it('wraps the single node at path in a new group with its own connector', () => {
    const next = turnIntoGroup([A, B, C], [0], 'or');
    expect(next).toEqual([{ or: [A] }, B, C]);
  });

  it('produces a schema-legal lone-child group (min 1 child) rather than requiring a second row', () => {
    const next = turnIntoGroup([A], [0], 'and');
    expect(next).toEqual([{ and: [A] }]);
    expect(measureFilterNode({ and: next })).toEqual({ depth: 2, conditions: 1 });
  });

  it('can wrap a node that is already nested inside another group, adding one more level', () => {
    const oneLevel = turnIntoGroup([A, B], [0], 'and'); // [{and:[A]}, B]
    const twoLevels = turnIntoGroup(oneLevel, [0, 0], 'or'); // [{and:[{or:[A]}]}, B]
    expect(twoLevels).toEqual([{ and: [{ or: [A] }] }, B]);
  });

  it('leaves sibling nodes untouched', () => {
    const next = turnIntoGroup([A, B, C], [1], 'and');
    expect(next).toEqual([A, { and: [B] }, C]);
  });
});

describe('measureFilterNode / canTurnIntoGroup — the depth-3, 50-condition caps', () => {
  it('mirrors packages/schemas filterSchema measure(): a flat list is depth 1 wrapped as a group', () => {
    expect(measureFilterNode({ and: [A, B, C] })).toEqual({ depth: 1, conditions: 3 });
  });

  it('one level of nesting is depth 2, two levels is depth 3 — both within the cap', () => {
    const oneLevel = { and: [{ or: [A, B] }, C] };
    expect(measureFilterNode(oneLevel)).toEqual({ depth: 2, conditions: 3 });

    const twoLevels = { and: [{ or: [{ and: [A, B] }, C] }, D] };
    expect(measureFilterNode(twoLevels)).toEqual({ depth: 3, conditions: 4 });
  });

  it('three levels of nesting is depth 4 — over the cap', () => {
    const threeLevels = { and: [{ or: [{ and: [{ or: [A] }] }] }] };
    expect(measureFilterNode(threeLevels).depth).toBe(4);
  });

  it('allows turning a row into a group up to exactly depth 3, blocks the level that would make depth 4', () => {
    let list: FilterNode[] = [A];
    list = turnIntoGroup(list, [0], 'and'); // depth 2
    expect(canTurnIntoGroup(list, [0, 0])).toBe(true);
    list = turnIntoGroup(list, [0, 0], 'or'); // depth 3 — still legal
    expect(measureFilterNode({ and: list }).depth).toBe(3);
    // One more wrap would push depth to 4 — must be blocked.
    expect(canTurnIntoGroup(list, [0, 0, 0])).toBe(false);
  });

  it('MUTATION CHECK — a cap that always returned true would let a 422 through: confirm the boundary is exact, not "always allow"', () => {
    // Sanity-checks the test above actually distinguishes allowed vs blocked,
    // rather than canTurnIntoGroup vacuously returning the same value always.
    expect(canTurnIntoGroup([A], [0])).toBe(true);
    const atCap = turnIntoGroup(turnIntoGroup([A], [0], 'and'), [0, 0], 'or');
    expect(canTurnIntoGroup(atCap, [0, 0, 0])).toBe(false);
  });
});

describe('ungroupNodeAt — flattens a group back into its parent level', () => {
  it('replaces the group with its children, in place', () => {
    const list = [A, { and: [B, C] }, D];
    expect(ungroupNodeAt(list, [1])).toEqual([A, B, C, D]);
  });

  it('ungrouping a lone-child group still produces a valid (non-empty) parent list', () => {
    const list = [{ and: [A] }, B];
    expect(ungroupNodeAt(list, [0])).toEqual([A, B]);
  });

  it('ungroups a nested group one level at a time (inner group stays intact)', () => {
    const list = [{ and: [{ or: [A, B] }, C] }];
    expect(ungroupNodeAt(list, [0])).toEqual([{ or: [A, B] }, C]);
  });
});

describe('duplicateNodeAt — deep-copies a condition or a whole group', () => {
  it('duplicates a leaf condition immediately after the original, unpinned', () => {
    const pinned = cond({ field: 'a', pinned: true });
    const next = duplicateNodeAt([pinned, B], [0]);
    expect(next).toEqual([pinned, { ...pinned, pinned: false }, B]);
  });

  it('deep-copies a whole group, including nested subgroups, unpinning every condition inside', () => {
    const pinnedA = cond({ field: 'a', pinned: true });
    const list = [{ and: [pinnedA, { or: [B] }] }, C];
    const next = duplicateNodeAt(list, [0]);
    // The clone unpins every leaf it copies (same "duplicate always lands unpinned"
    // convention the flat builder used), including B, which wasn't pinned to begin
    // with — so its copy explicitly carries `pinned: false` where the original had
    // no `pinned` key at all. The ORIGINAL subtree (list[0]) is untouched.
    expect(next[0]).toEqual({ and: [pinnedA, { or: [B] }] });
    expect(next[1]).toEqual({ and: [{ ...pinnedA, pinned: false }, { or: [{ ...B, pinned: false }] }] });
    expect(next[2]).toEqual(C);
  });

  it('the duplicate is a structurally independent copy — mutating one array does not affect the other', () => {
    const list = [{ and: [A, B] }, C];
    const next = duplicateNodeAt(list, [0]) as [{ and: FilterNode[] }, { and: FilterNode[] }, FilterNode];
    expect(next[0]).not.toBe(next[1]);
    expect((next[0] as { and: FilterNode[] }).and).not.toBe((next[1] as { and: FilterNode[] }).and);
  });
});

describe('removeNodeCascade — remove never leaves an empty (schema-illegal) group behind', () => {
  it('removes a plain top-level condition like a normal remove', () => {
    expect(removeNodeCascade([A, B, C], [1])).toEqual([A, C]);
  });

  it('removing a group’s only child removes the now-empty group too', () => {
    const list = [A, { and: [B] }, C];
    expect(removeNodeCascade(list, [1, 0])).toEqual([A, C]);
  });

  it('removing a group’s only child cascades through MULTIPLE emptied ancestors', () => {
    const list = [A, { and: [{ or: [B] }] }, C];
    // Removing B empties the inner {or:[B]}, which empties the outer {and:[...]} too.
    expect(removeNodeCascade(list, [1, 0, 0])).toEqual([A, C]);
  });

  it('does not cascade when the group still has other children left', () => {
    const list = [{ and: [A, B] }, C];
    expect(removeNodeCascade(list, [0, 0])).toEqual([{ and: [B] }, C]);
  });

  it('removes a group directly (with its contents) without touching siblings', () => {
    const list = [A, { and: [B, C] }, D];
    expect(removeNodeCascade(list, [1])).toEqual([A, D]);
  });
});

describe('moveNodeTo — drag-and-drop across group boundaries (the reorderConditions-equivalent for a tree)', () => {
  it('reorders within the same (flat) level exactly like arrayMove/reorderConditions', () => {
    const flat = [A, B, C, D];
    expect(moveNodeTo(flat, [0], [2])).toEqual(reorderConditions(flat, 0, 2));
    expect(moveNodeTo(flat, [3], [1])).toEqual(reorderConditions(flat, 3, 1));
  });

  it('drags a top-level condition INTO an existing group', () => {
    const list = [A, { and: [B] }, C];
    // Move C (path [2]) to become the second child of the group at [1] (index 1).
    expect(moveNodeTo(list, [2], [1, 1])).toEqual([A, { and: [B, C] }]);
  });

  it('drags a condition OUT of a group, back to the top level', () => {
    const list = [A, { and: [B, C] }];
    // Move C (path [1,1]) out to top-level index 2 (end).
    expect(moveNodeTo(list, [1, 1], [2])).toEqual([A, { and: [B] }, C]);
  });

  it('reorders within a group, leaving the top level untouched', () => {
    const list = [{ and: [A, B, C] }, D];
    expect(moveNodeTo(list, [0, 0], [0, 2])).toEqual([{ and: [B, C, A] }, D]);
  });

  it('moves a node from one group directly into a sibling group', () => {
    const list = [{ and: [A, B] }, { or: [C] }];
    expect(moveNodeTo(list, [0, 1], [1, 1])).toEqual([{ and: [A] }, { or: [C, B] }]);
  });

  it('is a no-op when from and to name the same slot', () => {
    const list = [A, { and: [B] }, C];
    expect(moveNodeTo(list, [1, 0], [1, 0])).toEqual(list);
  });

  it('refuses to drop a group into its own subtree (would orphan or no-op, not corrupt the tree)', () => {
    const list = [{ and: [A, B] }, C];
    // Path [0] is the group itself; [0, 0] is inside it — dropping the group inside its own contents.
    expect(moveNodeTo(list, [0], [0, 0])).toEqual(list);
  });

  it('MUTATION CHECK — canMoveNodeTo actually blocks a boundary-crossing move that would exceed depth 3, not just the same-level case turnIntoGroup already covers', () => {
    // Build a group already at depth 3 nested inside another branch, then try to
    // drag a WHOLE SUBTREE (not a single condition) into it — this is the case a
    // "flatten and only check the moved node's own depth" implementation would
    // miss, since the moved subtree's own internal depth also has to fit.
    const deepGroup = { and: [{ or: [{ and: [A] } as FilterNode] }] }; // depth 3 already
    const movedSubtree = { or: [B, C] }; // depth 1 on its own
    const list: FilterNode[] = [deepGroup, movedSubtree];
    // Dropping movedSubtree's contents into deepGroup's innermost {and:[A]} would push depth to 5.
    expect(canMoveNodeTo(list, [1], [0, 0, 0, 1])).toBe(false);
    // Sanity: the same move target is fine when the destination ISN'T already deep.
    const shallow: FilterNode[] = [{ and: [A] }, movedSubtree];
    expect(canMoveNodeTo(shallow, [1], [0, 1])).toBe(true);
  });
});

describe('flattenFilterTree / pathFromId — dnd-kit id ↔ tree-path round trip', () => {
  it('flattens in pre-order, including group nodes themselves alongside their contents', () => {
    const list = [A, { and: [B, C] }, D];
    const flat = flattenFilterTree(list);
    expect(flat.map((f) => f.id)).toEqual(['0', '1', '1.0', '1.1', '2']);
    expect(flat.map((f) => f.depth)).toEqual([0, 0, 1, 1, 0]);
  });

  it('every id round-trips back to the path that produced it', () => {
    const list = [A, { and: [{ or: [B] }, C] }];
    for (const entry of flattenFilterTree(list)) {
      expect(pathFromId(entry.id)).toEqual(entry.path);
      expect(getNodeAt(list, pathFromId(entry.id))).toEqual(entry.node);
    }
  });
});

describe('activeFilterNode — recursive pruning through nested groups (MN-258)', () => {
  it('keeps nested and/or structure intact when nothing is disabled', () => {
    const filters = buildFilterGroup('and', [A, { or: [B, C] }]);
    expect(activeFilterNode(filters)).toEqual({ and: [A, { or: [B, C] }] });
  });

  it('drops a disabled leaf from inside a nested group, keeping its siblings', () => {
    const filters = buildFilterGroup('and', [A, { or: [{ ...B, disabled: true }, C] }]);
    expect(activeFilterNode(filters)).toEqual({ and: [A, C] });
  });

  it('collapses a group that prunes down to exactly one surviving child', () => {
    const filters = buildFilterGroup('and', [A, { or: [{ ...B, disabled: true }, C] }]);
    // The {or:[B,C]} group prunes to just C (B disabled) — a single child collapses
    // to that child rather than staying wrapped in a redundant {or:[C]}.
    const result = activeFilterNode(filters) as { and: unknown[] };
    expect(result.and).toContainEqual({ field: 'c', op: 'eq', value: 'done' });
    expect(result.and).not.toContainEqual({ or: [{ field: 'c', op: 'eq', value: 'done' }] });
  });

  it('drops a group entirely when every child inside it is disabled', () => {
    const filters = buildFilterGroup('and', [
      A,
      { or: [{ ...B, disabled: true }, { ...C, disabled: true }] },
    ]);
    expect(activeFilterNode(filters)).toEqual({ field: 'a', op: 'eq', value: 'done' });
  });

  it('strips UI-only fields (pinned/label/icon) from conditions at every depth', () => {
    const decorated = cond({ field: 'b', pinned: true, label: 'Custom', icon: 'set:flag' });
    const filters = buildFilterGroup('and', [A, { or: [decorated] }]);
    // The nested group has a single surviving child, so it collapses to that
    // child directly rather than staying wrapped in a redundant {or:[...]}.
    expect(activeFilterNode(filters)).toEqual({
      and: [{ field: 'a', op: 'eq', value: 'done' }, { field: 'b', op: 'eq', value: 'done' }],
    });
  });
});
