import { activeFilter, firstStateOptionId, type FieldDef, type FilterCondition, type FilterNode } from '@storyos/schemas';

/**
 * ticket #1333 — the values a view's filter REQUIRES of a new record, so a record made with "New" on a filtered view lands inside
 * that view instead of vanishing from it (Dev Tracker's Active view filters State to the active states; a new issue used to start
 * in Triage and was gone).
 *
 * ONE place for the rule. It reads the filter AST every view, query and rollup already shares (`FilterNode`) and the live field defs;
 * it has no filter language of its own and no per-surface copy. Whether the record then MATCHES is not decided here: the service asks
 * the real evaluator (`compileFilter`) afterwards, so this file can only ever be wrong about a default, never about a verdict.
 *
 * What it derives, per field, from the conditions that are AND-ed together:
 *  - a choice field (`select` / `workflow`): `has`/`eq` give the allowed options, `category_is` the options in those state categories,
 *    `has_none`/`neq`/`category_is_not` the options left over. The pick is the FIRST allowed option in the field's own order, which for
 *    a state is the workflow order. For a field that is not a state, an exclusion alone (`Priority is not Low`) is only used when
 *    exactly one option is left: guessing between two is not "unambiguous".
 *  - a multi-select, a user field, a relation: `has` gives the first listed value, as a one-element list. `'me'` on a user field is the
 *    caller.
 *  - a checkbox, a text-like field, a number: `eq`.
 *  - `is_empty` on any field: an explicit empty (null), which also stops the generic first-state default from filling it.
 *  - an OR group only when every branch is on the SAME field (the allowed set is their union); an OR across different fields is
 *    ambiguous, as is anything nested under it.
 * It derives NOTHING for: dates and relative ranges, `contains`, `gt`/`lt`, computed fields (formula, rollup, lookup, AI), the title,
 * `not_empty`, and a field whose conditions contradict each other. Those are left to the usual defaults, and the match check reports
 * them as unmet.
 *
 * "Unconfigured is not invalid": `activeFilter` first drops the disabled and the half-written conditions a view keeps while someone is
 * mid-edit, so they constrain nothing.
 */

type Constraint = {
  /** Allowed values, best first; `null` = the condition gives no usable value (does not narrow the field, does not block it). */
  values: unknown[] | null;
  /** The condition asked for an empty field. */
  empty: boolean;
  /** A positive condition (`has`, `eq`, `category_is`): picking the first of several allowed values is then what the view asked for. */
  positive: boolean;
};

const SCALAR_TEXT_TYPES = new Set(['text', 'long_text', 'url', 'email', 'phone']);
const NOT_SETTABLE_TYPES = new Set([
  'title', 'formula', 'rollup', 'lookup', 'ai', 'id', 'created_at', 'updated_at', 'created_by', 'updated_by', 'button', 'attachment', 'rich_text',
]);

function isLeaf(node: FilterNode): node is FilterCondition {
  return !('and' in node) && !('or' in node);
}

/** An ordered list of the options a def has, empty when it is not a choice field. */
function optionsOf(def: FieldDef): string[] {
  return def.option_order ?? def.option_ids ?? [];
}

function isStateDef(def: FieldDef): boolean {
  return firstStateOptionId(def.type, def.option_order, def.option_categories) !== undefined;
}

function asList(value: unknown): unknown[] | null {
  if (Array.isArray(value)) return value;
  return value === undefined || value === null || value === '' ? null : [value];
}

/** What one leaf asks of its field, or `undefined` when the leaf says nothing we can act on. */
function constraintOf(def: FieldDef, leaf: FilterCondition, currentUserId: string): Constraint | undefined {
  const { op } = leaf;
  if (NOT_SETTABLE_TYPES.has(def.type)) return undefined;
  if (op === 'is_empty') return { values: null, empty: true, positive: true };
  if (op === 'not_empty') return undefined;

  if (def.type === 'select' || def.type === 'workflow') {
    const valid = new Set(optionsOf(def));
    const ordered = optionsOf(def);
    if (op === 'has' || op === 'eq') {
      const wanted = new Set((asList(leaf.value) ?? []).filter((v): v is string => typeof v === 'string' && valid.has(v)));
      return wanted.size ? { values: ordered.filter((id) => wanted.has(id)), empty: false, positive: true } : undefined;
    }
    if (op === 'has_none' || op === 'neq') {
      const excluded = new Set((asList(leaf.value) ?? []).filter((v): v is string => typeof v === 'string'));
      return { values: ordered.filter((id) => !excluded.has(id)), empty: false, positive: false };
    }
    if (op === 'category_is' || op === 'category_is_not') {
      const wanted = new Set((asList(leaf.value) ?? []).filter((v): v is string => typeof v === 'string'));
      if (!wanted.size) return undefined;
      const inCategory = (id: string) => {
        const category = def.option_categories?.[id];
        return category != null && wanted.has(category);
      };
      return op === 'category_is'
        ? { values: ordered.filter(inCategory), empty: false, positive: true }
        : { values: ordered.filter((id) => !inCategory(id)), empty: false, positive: false };
    }
    return undefined;
  }

  if (def.type === 'multi_select') {
    if (op !== 'has') return undefined;
    const valid = new Set(optionsOf(def));
    const wanted = new Set((asList(leaf.value) ?? []).filter((v): v is string => typeof v === 'string' && valid.has(v)));
    return wanted.size ? { values: optionsOf(def).filter((id) => wanted.has(id)), empty: false, positive: true } : undefined;
  }

  if (def.type === 'user' || def.type === 'relation') {
    if (op !== 'has' && !(op === 'eq' && def.type === 'user')) return undefined;
    const raw = (asList(leaf.value) ?? []).filter((v): v is string => typeof v === 'string');
    const values = def.type === 'user' ? raw.map((v) => (v === 'me' ? currentUserId : v)) : raw;
    return values.length ? { values, empty: false, positive: true } : undefined;
  }

  if (def.type === 'checkbox') {
    return op === 'eq' && typeof leaf.value === 'boolean' ? { values: [leaf.value], empty: false, positive: true } : undefined;
  }
  if (SCALAR_TEXT_TYPES.has(def.type)) {
    return op === 'eq' && typeof leaf.value === 'string' && leaf.value !== '' ? { values: [leaf.value], empty: false, positive: true } : undefined;
  }
  if (def.type === 'number') {
    return op === 'eq' && typeof leaf.value === 'number' ? { values: [leaf.value], empty: false, positive: true } : undefined;
  }
  return undefined;
}

/** Union of OR-branches that are all on one field, best-ordered like the field's own options; `undefined` when any branch gives nothing. */
function orConstraint(def: FieldDef, leaves: FilterCondition[], currentUserId: string): Constraint | undefined {
  const parts = leaves.map((leaf) => constraintOf(def, leaf, currentUserId));
  if (parts.some((p) => p === undefined)) return undefined;
  const all = parts as Constraint[];
  if (all.some((p) => p.empty)) return all.every((p) => p.empty) ? all[0] : undefined;
  if (all.some((p) => p.values === null)) return undefined;
  const union: unknown[] = [];
  for (const p of all) for (const v of p.values!) if (!union.some((u) => u === v)) union.push(v);
  const order = optionsOf(def);
  if (order.length) union.sort((a, b) => order.indexOf(a as string) - order.indexOf(b as string));
  return { values: union, empty: false, positive: all.every((p) => p.positive) };
}

/** The AND-ed units of a filter: its leaves, and its OR groups that are on a single field. Anything else contributes nothing. */
function collect(node: FilterNode, out: Array<FilterCondition | FilterCondition[]>): void {
  if ('and' in node) {
    for (const child of node.and) collect(child, out);
    return;
  }
  if ('or' in node) {
    const branches = node.or;
    if (branches.every(isLeaf)) {
      const leaves = branches as FilterCondition[];
      if (new Set(leaves.map((l) => l.field)).size === 1) out.push(leaves);
    }
    return;
  }
  out.push(node);
}

/**
 * The values a view's filter requires of a new record, keyed by field api_name. Only fields it can set unambiguously appear; an
 * explicit empty is `null`. The caller applies these UNDER whatever the request itself supplied.
 */
export function deriveViewDefaults(filter: FilterNode | undefined, defs: FieldDef[], currentUserId: string): Record<string, unknown> {
  const active = activeFilter(filter);
  if (!active) return {};
  const byName = new Map(defs.map((d) => [d.api_name, d]));
  const units: Array<FilterCondition | FilterCondition[]> = [];
  collect(active, units);

  const byField = new Map<string, Constraint[]>();
  for (const unit of units) {
    const leaves = Array.isArray(unit) ? unit : [unit];
    const def = byName.get(leaves[0]!.field);
    if (!def) continue;
    const constraint = Array.isArray(unit) ? orConstraint(def, unit, currentUserId) : constraintOf(def, unit, currentUserId);
    if (!constraint) continue;
    byField.set(def.api_name, [...(byField.get(def.api_name) ?? []), constraint]);
  }

  const out: Record<string, unknown> = {};
  for (const [apiName, constraints] of byField) {
    const def = byName.get(apiName)!;
    const wantsEmpty = constraints.some((c) => c.empty);
    const wantsValue = constraints.some((c) => c.values !== null);
    if (wantsEmpty) {
      if (!wantsValue) out[apiName] = null; // "is empty" and nothing else: say so, so the first-state default does not fill it
      continue; // empty AND a value: contradictory, derive nothing
    }
    let allowed: unknown[] | undefined;
    for (const c of constraints) {
      if (c.values === null) continue;
      allowed = allowed === undefined ? c.values : allowed.filter((v) => c.values!.includes(v));
    }
    if (!allowed || allowed.length === 0) continue; // contradictory, or nothing left: derive nothing
    const positive = constraints.some((c) => c.positive);
    // First allowed is the answer for a positive condition and for a state (workflow order). A bare exclusion on any other field is
    // only unambiguous when a single option is left.
    if (!positive && !isStateDef(def) && allowed.length !== 1) continue;
    const first = allowed[0];
    const many = def.type === 'multi_select' || def.type === 'relation' || (def.type === 'user' && def.config['multi'] === true);
    out[apiName] = many ? [first] : first;
  }
  return out;
}

/**
 * The checkable units of a filter for the "which conditions are unmet" report: each AND-ed leaf, and each OR group as a whole (a group is
 * met or not as one thing). Same shape the evaluator then runs on, so a unit's verdict is the real one.
 */
export function filterUnits(filter: FilterNode | undefined): FilterNode[] {
  const active = activeFilter(filter);
  if (!active) return [];
  const out: FilterNode[] = [];
  const walk = (node: FilterNode) => {
    if ('and' in node) node.and.forEach(walk);
    else out.push(node);
  };
  walk(active);
  return out;
}
