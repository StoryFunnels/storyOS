import { arrayMove } from '@dnd-kit/sortable';

/**
 * The UI filter model (MN-253 flat And/Or, MN-258 nested groups): a tree of
 * conditions and groups, each group carrying its own And/Or connector. This is
 * the SAME shape the backend's FilterNode AST already supports end to end —
 * {and:[...]} / {or:[...]} nesting ≤3 deep, ≤50 conditions total (packages/schemas
 * query.ts's filterSchema) — so persistence never forks a second format; the UI
 * just didn't expose nesting until MN-258. See docs/architecture (ADR-0003) + the
 * MN-253 spike report + the MN-258 ticket (backend already proven end to end via
 * calendar-view.tsx's date-window wrapper).
 */
export interface FilterCondition {
  field: string; // api_name
  op: string;
  value?: unknown;
  /** Non-destructive toggle: stays in the builder, excluded from the query. */
  disabled?: boolean;
  /** Also renders as a standalone chip in the toolbar, outside the builder. */
  pinned?: boolean;
  /** Custom display name — for the condition row and its pinned chip. */
  label?: string;
  /** Icon key (curated set name or emoji) — defaults to the field's type icon. */
  icon?: string;
}

export type FilterConnector = 'and' | 'or';

/** A node in the filter tree: either a leaf condition or a nested group. */
export type FilterNode = FilterCondition | FilterGroup;
export type FilterGroup = { and: FilterNode[] } | { or: FilterNode[] };

/** Mirrors packages/schemas' filterSchema caps exactly — the UI enforces the SAME
 * limits the server would 422 on, so "Turn into Group" / drag-into-group can never
 * produce a shape that fails to save (MN-258 AC: no 422-on-save UX). */
export const MAX_FILTER_DEPTH = 3;
export const MAX_FILTER_CONDITIONS = 50;

export function isFilterGroup(node: FilterNode): node is FilterGroup {
  return typeof node === 'object' && node !== null && ('and' in node || 'or' in node);
}

export function nodeConnector(node: FilterGroup): FilterConnector {
  return 'or' in node ? 'or' : 'and';
}

export function nodeChildren(node: FilterGroup): FilterNode[] {
  return 'or' in node ? node.or : node.and;
}

function withChildren(node: FilterGroup, children: FilterNode[]): FilterGroup {
  return 'or' in node ? { or: children } : { and: children };
}

export function filterConnector(filters: FilterGroup | undefined): FilterConnector {
  return filters && 'or' in filters ? 'or' : 'and';
}

/**
 * Reads the top-level node list out of a persisted filter. Defensive against a bare
 * single condition (no `and`/`or` wrapper): templates.service.ts (API) seeds a
 * view's filter unwrapped when it has exactly one clause, same as
 * queryBodyFromConfig sends for a single active condition — treat it as a
 * one-element list rather than crashing on `.and`/`.or` being undefined. Items in
 * the list may themselves be nested groups (MN-258) — callers that only ever deal
 * with flat conditions (the header-cell quick filter, e.g.) still work: they just
 * treat any nested group as an opaque sibling they append alongside.
 */
export function filterConditions(filters: FilterGroup | undefined): FilterNode[] {
  if (!filters) return [];
  if ('or' in filters) return filters.or;
  if ('and' in filters) return filters.and;
  return [filters as unknown as FilterCondition];
}

export function buildFilterGroup(
  connector: FilterConnector,
  nodes: FilterNode[],
): FilterGroup | undefined {
  if (nodes.length === 0) return undefined;
  return connector === 'or' ? { or: nodes } : { and: nodes };
}

/** Drag-to-reorder: pure array move, so the row order logic is testable without dnd-kit's DOM events. */
export function reorderConditions<T>(items: T[], from: number, to: number): T[] {
  return arrayMove(items, from, to);
}

/**
 * What the query actually runs: disabled clauses drop out (at any depth), UI-only
 * fields (disabled/pinned/label/icon) don't ride along to /records/query. Mirrors
 * packages/schemas' `activeFilter`/`pruneFilterNode` walk, kept separately here
 * since the web's FilterCondition is intentionally looser (op: string, mid-edit
 * values) than the API's typed FilterNode. A group that prunes down to a single
 * surviving child collapses to that child, and an empty group disappears entirely
 * — same collapsing rules as the backend, so what you see nested in the builder is
 * exactly what compiles to SQL (MN-258 AC).
 */
export function activeFilterNode(filters: FilterGroup | undefined): unknown {
  if (!filters) return undefined;
  return pruneNode(filters as FilterNode);
}

/**
 * ANDs any number of already-active filter nodes into one, for composing a
 * shared view's filter with a personal override (#259) — the exact
 * top-level-AND-wrap pattern calendar-view.tsx's date-window filter already
 * uses to nest an active filter alongside its own range conditions: a single
 * surviving node is returned bare (no redundant wrapper), two or more nest
 * under one `{and:[...]}`. Never invents a second composition rule.
 */
export function andFilterNodes(...nodes: Array<unknown | undefined>): unknown {
  const present = nodes.filter((n) => n !== undefined);
  if (present.length === 0) return undefined;
  return present.length === 1 ? present[0] : { and: present };
}

function pruneNode(node: FilterNode): unknown {
  if (isFilterGroup(node)) {
    const connector = nodeConnector(node);
    const children = nodeChildren(node)
      .map(pruneNode)
      .filter((n) => n !== undefined);
    if (children.length === 0) return undefined;
    return children.length === 1 ? children[0] : { [connector]: children };
  }
  if (node.disabled) return undefined;
  return { field: node.field, op: node.op, value: node.value };
}

/* ------------------------------------------------------------------------- *
 * Tree editing primitives (MN-258): every op below is expressed in terms of a
 * `path: number[]` — indices from the top-level node list down through nested
 * group children, e.g. [2, 0] = the first child of the group at top-level index 2.
 * `spliceAt` is the one primitive that actually walks the tree; every other op
 * (remove/update/turn-into-group/ungroup/duplicate) is just a different `expand`
 * callback over it, so the recursive-descent bug surface stays in one place.
 * ------------------------------------------------------------------------- */

function spliceAt(
  list: FilterNode[],
  parentPath: number[],
  index: number,
  expand: (node: FilterNode) => FilterNode[],
): FilterNode[] {
  if (parentPath.length === 0) {
    return list.flatMap((node, i) => (i === index ? expand(node) : [node]));
  }
  const [head, ...rest] = parentPath;
  return list.map((node, i) => {
    if (i !== head || !isFilterGroup(node)) return node;
    return withChildren(node, spliceAt(nodeChildren(node), rest, index, expand));
  });
}

function insertAt(list: FilterNode[], parentPath: number[], index: number, node: FilterNode): FilterNode[] {
  if (parentPath.length === 0) {
    const clamped = Math.max(0, Math.min(index, list.length));
    return [...list.slice(0, clamped), node, ...list.slice(clamped)];
  }
  const [head, ...rest] = parentPath;
  return list.map((n, i) => {
    if (i !== head || !isFilterGroup(n)) return n;
    return withChildren(n, insertAt(nodeChildren(n), rest, index, node));
  });
}

export function getNodeAt(list: FilterNode[], path: number[]): FilterNode | undefined {
  if (path.length === 0) return undefined;
  const [head, ...rest] = path;
  const node = list[head!];
  if (node === undefined) return undefined;
  if (rest.length === 0) return node;
  if (!isFilterGroup(node)) return undefined;
  return getNodeAt(nodeChildren(node), rest);
}

function parentAndIndex(path: number[]): { parent: number[]; index: number } {
  return { parent: path.slice(0, -1), index: path[path.length - 1]! };
}

export function removeNodeAt(list: FilterNode[], path: number[]): FilterNode[] {
  const { parent, index } = parentAndIndex(path);
  return spliceAt(list, parent, index, () => []);
}

/** Removes the node at `path`, then cascades upward: a group schema requires
 * ≥1 child (query.ts), so if removal leaves an ancestor group empty, that group
 * is removed too (repeating until a non-empty ancestor or the root is reached).
 * Used for every "Remove" action (condition or group) so an empty group can
 * never linger in the tree or get persisted. */
export function removeNodeCascade(list: FilterNode[], path: number[]): FilterNode[] {
  let next = removeNodeAt(list, path);
  let parentPath = path.slice(0, -1);
  while (parentPath.length > 0) {
    const parent = getNodeAt(next, parentPath);
    if (parent && isFilterGroup(parent) && nodeChildren(parent).length === 0) {
      next = removeNodeAt(next, parentPath);
      parentPath = parentPath.slice(0, -1);
    } else {
      break;
    }
  }
  return next;
}

export function updateNodeAt(
  list: FilterNode[],
  path: number[],
  updater: (node: FilterNode) => FilterNode,
): FilterNode[] {
  const { parent, index } = parentAndIndex(path);
  return spliceAt(list, parent, index, (node) => [updater(node)]);
}

/** Wraps the single node at `path` in a new group with its own connector —
 * "Turn into Group" (MN-258). A lone-child group is a valid, schema-legal shape
 * (min 1), so this never needs a second row to seed the group. */
export function turnIntoGroup(
  list: FilterNode[],
  path: number[],
  connector: FilterConnector = 'and',
): FilterNode[] {
  return updateNodeAt(list, path, (node) => buildFilterGroup(connector, [node])!);
}

/** Flattens a group back into its parent level, in place of the group (MN-258
 * "Ungroup"). Removing the group's own wrapper is the entire operation — its
 * children already have depth-1 addresses relative to the new parent. */
export function ungroupNodeAt(list: FilterNode[], path: number[]): FilterNode[] {
  const { parent, index } = parentAndIndex(path);
  return spliceAt(list, parent, index, (node) => (isFilterGroup(node) ? nodeChildren(node) : [node]));
}

/** Deep-copies the node at `path` (condition or whole group + contents) and
 * inserts the copy immediately after the original — same "duplicate lands right
 * next to the original, unpinned" convention the flat builder already used. */
export function duplicateNodeAt(list: FilterNode[], path: number[]): FilterNode[] {
  const { parent, index } = parentAndIndex(path);
  return spliceAt(list, parent, index, (node) => [node, cloneUnpinned(node)]);
}

function cloneUnpinned(node: FilterNode): FilterNode {
  if (isFilterGroup(node)) return withChildren(node, nodeChildren(node).map(cloneUnpinned));
  return { ...node, pinned: false };
}

/** Mirrors packages/schemas' filterSchema `measure()` walk exactly (query.ts):
 * a leaf condition is depth 0; a group is 1 + its deepest child. Pass the WHOLE
 * top-level list wrapped as a group (what actually gets persisted/validated),
 * not a bare list, to get the number the server would compute. */
export function measureFilterNode(node: FilterNode): { depth: number; conditions: number } {
  if (isFilterGroup(node)) {
    const children = nodeChildren(node);
    let depth = 0;
    let conditions = 0;
    for (const child of children) {
      const m = measureFilterNode(child);
      depth = Math.max(depth, m.depth);
      conditions += m.conditions;
    }
    return { depth: depth + 1, conditions };
  }
  return { depth: 0, conditions: 1 };
}

/** True if applying `mutate` to the top-level list would exceed the schema's
 * depth/condition caps — the client-side gate that keeps "Turn into Group" and
 * drag-into-group from ever producing a shape the server 422s on save. */
function wouldExceedCaps(list: FilterNode[], mutate: (list: FilterNode[]) => FilterNode[]): boolean {
  const next = mutate(list);
  if (next.length === 0) return false;
  const measured = measureFilterNode({ and: next });
  return measured.depth > MAX_FILTER_DEPTH || measured.conditions > MAX_FILTER_CONDITIONS;
}

export function canTurnIntoGroup(list: FilterNode[], path: number[]): boolean {
  return !wouldExceedCaps(list, (l) => turnIntoGroup(l, path, 'and'));
}

function pathsEqual(a: number[], b: number[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** True if `maybeDescendant` is `ancestor` itself or lies inside its subtree —
 * used to block a drag from dropping a group into its own contents. */
function isAtOrBelow(ancestor: number[], maybeDescendant: number[]): boolean {
  return maybeDescendant.length >= ancestor.length && ancestor.every((v, i) => maybeDescendant[i] === v);
}

/**
 * Drag-and-drop across group boundaries (MN-258): the nested equivalent of
 * `reorderConditions`. Same two-step algorithm as `arrayMove` itself (splice the
 * node out, then splice it in at `to[last]`'s index) generalized across nesting
 * levels: `to` names the target slot's index the way `arrayMove`'s `to` does —
 * directly usable as the insertion index into the post-removal array, same-parent
 * or not, with NO extra shift-by-one for "removed from earlier in the same list".
 * (`arrayMove([A,B,C], 0, 2)` → `[B,C,A]`, not `[B,A,C]` — the target index is a
 * position in the array *after* the removal, not a stand-in for "insert before the
 * node currently at that index in the original array".) A no-op if `from` and `to`
 * name the same slot, or if `to` would drop the node into its own subtree (which
 * would either no-op or orphan it).
 */
export function moveNodeTo(list: FilterNode[], from: number[], to: number[]): FilterNode[] {
  if (pathsEqual(from, to)) return list;
  const node = getNodeAt(list, from);
  if (!node) return list;
  const toParent = to.slice(0, -1);
  if (isAtOrBelow(from, toParent)) return list;

  const toIndex = to[to.length - 1]!;
  const without = removeNodeAt(list, from);
  return insertAt(without, toParent, toIndex, node);
}

/** Same depth/condition-cap gate as `canTurnIntoGroup`, for a cross-boundary
 * drag — dropping a subtree into a deeply nested group can blow the cap even
 * though neither endpoint alone would. */
export function canMoveNodeTo(list: FilterNode[], from: number[], to: number[]): boolean {
  return !wouldExceedCaps(list, (l) => moveNodeTo(l, from, to));
}

/** Pre-order flattening of the whole tree (groups AND their contents), used to
 * build dnd-kit's single flat `SortableContext` items list across nesting levels
 * — one DndContext, one sortable list, path-addressed ids ("2.0.1"), rather than
 * a second drag pattern per level. */
export interface FlatFilterNode {
  id: string;
  path: number[];
  node: FilterNode;
  depth: number;
}
export function flattenFilterTree(list: FilterNode[], path: number[] = [], depth = 0): FlatFilterNode[] {
  return list.flatMap((node, i) => {
    const p = [...path, i];
    const entry: FlatFilterNode = { id: p.join('.'), path: p, node, depth };
    if (isFilterGroup(node)) return [entry, ...flattenFilterTree(nodeChildren(node), p, depth + 1)];
    return [entry];
  });
}

export function pathFromId(id: string): number[] {
  return id.split('.').map(Number);
}
