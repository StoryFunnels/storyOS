/**
 * #968 — the pure half of the Inbox-shaped My Work: which field is the "state", "priority" and "due" of a row,
 * how a due date reads (overdue / today / later), the one merged list and its sort, and the filter chips.
 *
 * Kept out of the components so it can be tested (JSX-free harness), and because every one of these is a
 * place the old per-database layout and the new merged one could disagree: the same stored per-database
 * preferences (`MyWorkDbConfig`) feed both.
 */
import { inferStateCategory, isFinishedStateCategory } from '@storyos/schemas';
import { isIncompleteCondition } from '@storyos/schemas';
import { filterConditions, flattenFilterTree, isFilterGroup } from '../views/filter-config';
import type { FilterCondition, FilterGroup } from '../views/filter-config';
import { matchesFilters } from './filter-my-work';
import type { DenseField, MyWorkDbConfig } from './group-config';

export interface MyWorkRecord {
  id: string;
  title: string;
  number: number | null;
  updated_at: string;
  values: Record<string, unknown>;
  /**
   * #979 — who last put the caller into one of the record's person fields, and when. Both null (or absent, from an
   * older server) when NO change ever did: the record was created with the caller already set, imported that way, or
   * the activity trail does not hold the change. Never a guess and never the record's creator.
   */
  assigned_by?: { id: string; name: string; kind: 'user' | 'agent' } | null;
  assigned_at?: string | null;
}
export interface MyWorkGroup {
  database: { id: string; name: string; icon: string | null; color: string | null };
  fields: DenseField[];
  records: MyWorkRecord[];
}

/** A resolved option value: its label and the option's colour KEY (the component resolves it to a colour). */
export interface FacetOption {
  label: string;
  color: string | null;
}
export interface Facets {
  stateField: DenseField | null;
  priorityField: DenseField | null;
  dueField: DenseField | null;
  state: FacetOption | null;
  priority: FacetOption | null;
  /** The raw date as stored, or null. */
  due: string | null;
  /** #1002 — the state is a finished one (see `isCompletedState`). A finished record is never "overdue" and sorts after open ones. */
  completed: boolean;
}

const DUE_NAME = /(^|\W)(due|deadline)(\W|$)|due.?date|target.?date/i;

/**
 * Which of a database's fields play State / Priority / Due on a My Work row.
 *
 * By TYPE for state (a workflow field is the state by construction), by NAME for the rest, and never by
 * guessing: a database with no field named like a due date has no due date here, rather than showing
 * "Due" for an arbitrary date column (a created-at stamp is not a deadline).
 */
export function pickFacetFields(fields: DenseField[]): Pick<Facets, 'stateField' | 'priorityField' | 'dueField'> {
  const stateField =
    fields.find((f) => f.type === 'workflow') ??
    fields.find((f) => f.type === 'select' && /^(state|status)$/i.test(f.display_name.trim())) ??
    null;
  const priorityField =
    fields.find((f) => (f.type === 'select' || f.type === 'workflow') && /priorit/i.test(f.display_name) && f !== stateField) ??
    null;
  const dueField = fields.find((f) => f.type.startsWith('date') && DUE_NAME.test(f.display_name)) ?? null;
  return { stateField, priorityField, dueField };
}

/**
 * #1002 / #1017 — is this state a finished one?
 *
 * Read from the option's STATE CATEGORY (ticket #1014): `completed` and `canceled` are finished. A workflow option always
 * has one; a plain select named State/Status may never have been given one, and for that option alone the category is
 * inferred from its label by the same `inferStateCategory` the API's backfill uses — one rule, not a second copy of it
 * here. (The old read-time guess also promoted the LAST workflow option; the category replaces that, and a workflow's
 * last option is `completed` by the backfill whenever it was.) A record with no state is open.
 */
export function isCompletedState(field: DenseField | null, raw: unknown): boolean {
  if (!field) return false;
  const v = Array.isArray(raw) ? raw[0] : raw;
  if (v == null || v === '') return false;
  const options = field.options ?? [];
  const opt = options.find((o) => o.id === v);
  if (!opt) return false;
  return isFinishedStateCategory(opt.category ?? inferStateCategory(opt.label));
}

function optionOf(field: DenseField | null, raw: unknown): FacetOption | null {
  if (!field) return null;
  const v = Array.isArray(raw) ? raw[0] : raw;
  if (v == null || v === '') return null;
  const opt = field.options?.find((o) => o.id === v);
  return opt ? { label: opt.label, color: opt.color } : { label: String(v), color: null };
}

export function facetsFor(fields: DenseField[], values: Record<string, unknown>): Facets {
  const { stateField, priorityField, dueField } = pickFacetFields(fields);
  const rawDue = dueField ? values[dueField.api_name] : null;
  return {
    stateField,
    priorityField,
    dueField,
    state: optionOf(stateField, stateField ? values[stateField.api_name] : null),
    priority: optionOf(priorityField, priorityField ? values[priorityField.api_name] : null),
    due: typeof rawDue === 'string' && rawDue !== '' ? rawDue : null,
    completed: isCompletedState(stateField, stateField ? values[stateField.api_name] : null),
  };
}

/** Local calendar day as YYYY-MM-DD. */
function dayKey(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

/**
 * Where a due date sits relative to today, in the viewer's local calendar. A bare `YYYY-MM-DD` is a CALENDAR
 * day (no time zone), so it is compared as text; a full timestamp is read in local time.
 */
export type DueBucket = 'overdue' | 'today' | 'later' | 'none' | 'done';
export function dueBucket(due: string | null, now: Date, completed = false): DueBucket {
  if (!due) return 'none';
  // #1002 — a finished record has no deadline left to miss: its date is history, shown plain, never red.
  if (completed) return 'done';
  const day = /^\d{4}-\d{2}-\d{2}$/.test(due) ? due : (() => {
    const d = new Date(due);
    return Number.isNaN(d.getTime()) ? null : dayKey(d);
  })();
  if (!day) return 'none';
  const today = dayKey(now);
  if (day < today) return 'overdue';
  return day === today ? 'today' : 'later';
}

export interface MyWorkRow {
  dbId: string;
  database: MyWorkGroup['database'];
  fields: DenseField[];
  config: MyWorkDbConfig;
  record: MyWorkRecord;
  facets: Facets;
}

/** Every record the saved per-database filters let through, as rows with their facets. */
export function buildRows(groups: MyWorkGroup[], configs: Record<string, MyWorkDbConfig | undefined>): MyWorkRow[] {
  const rows: MyWorkRow[] = [];
  for (const group of groups) {
    const config = configs[group.database.id] ?? {};
    for (const record of group.records) {
      if (!matchesFilters(record.values, config)) continue;
      rows.push({
        dbId: group.database.id,
        database: group.database,
        fields: group.fields,
        config,
        record,
        facets: facetsFor(group.fields, record.values),
      });
    }
  }
  return rows;
}

export type MyWorkSortKey = 'due' | 'updated' | 'title';
export const SORT_LABELS: Record<MyWorkSortKey, string> = { due: 'Due date', updated: 'Last updated', title: 'Title' };

function dueStamp(due: string | null): number | null {
  if (!due) return null;
  const t = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(due) ? `${due}T00:00:00` : due);
  return Number.isNaN(t) ? null : t;
}

/** The merged list's order. Due date: open records first, earliest due first, rows with no due date after every dated one, newest-updated first among ties; finished records follow, ordered the same way. */
export function sortRows<T extends { record: MyWorkRecord; facets: Facets }>(rows: T[], key: MyWorkSortKey): T[] {
  const byUpdated = (a: T, b: T) => Date.parse(b.record.updated_at) - Date.parse(a.record.updated_at);
  return [...rows].sort((a, b) => {
    if (key === 'title') return (a.record.title || '').localeCompare(b.record.title || '') || byUpdated(a, b);
    if (key === 'updated') return byUpdated(a, b);
    // #1002 — finished records go AFTER every open one (never first), each group in the order below.
    if (a.facets.completed !== b.facets.completed) return a.facets.completed ? 1 : -1;
    const da = dueStamp(a.facets.due);
    const db = dueStamp(b.facets.due);
    if (da !== null && db !== null) return da - db || byUpdated(a, b);
    if (da !== null) return -1;
    if (db !== null) return 1;
    return byUpdated(a, b);
  });
}

/** How many conditions of a saved filter actually APPLY: not switched off, not unfinished (#345). */
export function appliedConditionCount(filters: FilterGroup | undefined): number {
  const leaves = flattenFilterTree(filterConditions(filters)).filter((f) => !isFilterGroup(f.node));
  return leaves.filter((f) => {
    const c = f.node as FilterCondition;
    return !c.disabled && !isIncompleteCondition(c);
  }).length;
}

export interface FilterChip {
  dbId: string;
  label: string;
  count: number;
}
/**
 * One chip per database whose saved filter applies — Otto's rule: nothing is ever hidden without a visible
 * chip, so a saved per-database filter that narrows the list always names itself ("Issues · 2 filters").
 */
export function filterChips(groups: MyWorkGroup[], configs: Record<string, MyWorkDbConfig | undefined>): FilterChip[] {
  const chips: FilterChip[] = [];
  for (const g of groups) {
    const count = appliedConditionCount(configs[g.database.id]?.filters);
    if (count > 0) chips.push({ dbId: g.database.id, label: `${g.database.name} · ${count} filter${count === 1 ? '' : 's'}`, count });
  }
  return chips;
}

/**
 * #968 follow-up — the preview's "Assigned by" row, per #979's rule for `null`.
 * - `created` tab: the row does not apply (nothing was assigned to you; you made it), so it is not drawn.
 * - `assigned` tab with a value: the person (or agent) and when.
 * - `assigned` tab with null: say so and say what null means, rather than leave a blank or invent a name.
 */
export type AssignedByLine =
  | { kind: 'hidden' }
  | { kind: 'set'; name: string; byAgent: boolean; at: string | null }
  | { kind: 'unrecorded'; explanation: string };

export const ASSIGNED_BY_UNRECORDED =
  'Not recorded. You were set on this record when it was created or imported, or the change is not in its history.';

export function assignedByLine(
  record: Pick<MyWorkRecord, 'assigned_by' | 'assigned_at'>,
  tab: 'assigned' | 'created',
): AssignedByLine {
  if (tab !== 'assigned') return { kind: 'hidden' };
  if (record.assigned_by) {
    return {
      kind: 'set',
      name: record.assigned_by.name,
      byAgent: record.assigned_by.kind === 'agent',
      at: record.assigned_at ?? null,
    };
  }
  return { kind: 'unrecorded', explanation: ASSIGNED_BY_UNRECORDED };
}
