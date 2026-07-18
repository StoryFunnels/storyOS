'use client';

import { Check, Group, SlidersHorizontal } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ColorByButton, FiltersSection, SortButton } from '@/components/views/view-toolbar';
import { isFilterGroup, nodeChildren, nodeConnector } from '@/components/views/filter-config';
import type { FilterCondition, FilterGroup, FilterNode } from '@/components/views/filter-config';
import type { NullsPlacement, SortSpec } from '@/components/views/sort-config';
import { OPTION_COLORS } from '@/components/table-view/cells';
import type { Field } from '@/components/table-view/use-table-data';
import { cn } from '@/lib/utils';
// MN-252: sortMyWorkRecords lives in a plain .ts sibling module (not here), so
// the *.unit.test.ts harness (JSX-free, see apps/web/vitest.config.ts) can
// import it without pulling this file's JSX into the test's module graph.
import { sortMyWorkRecords } from './sort-my-work';

export { sortMyWorkRecords };

export interface DenseField {
  id: string;
  api_name: string;
  display_name: string;
  type: string;
  options?: Array<{ id: string; label: string; color: string }>;
}
export type { FilterCondition };
/** Per-database My Work config (mirrors the API's MyWorkDbConfig). Uses the SAME
 * filter builder + persisted shape as saved views (MN-253): a flat And/Or list with
 * non-destructive disable/pin/label/icon, applied client-side to the returned rows.
 * MN-252 adds the same sort spec, also applied client-side (sortMyWorkRecords below) —
 * My Work is a bounded, already-fetched set, so there's no query layer to delegate to. */
export interface MyWorkDbConfig {
  group_by_field_id?: string;
  color_by_field_id?: string;
  hidden_field_ids?: string[];
  filters?: FilterGroup;
  sorts?: SortSpec[];
  sorts_nulls?: NullsPlacement;
}

export const EMPTY_MYWORK: MyWorkDbConfig = {};

/** Adapt a My Work dense field to the table-view Field shape the toolbar/cells expect. */
export function toField(f: DenseField): Field {
  return {
    id: f.id,
    apiName: f.api_name,
    displayName: f.display_name,
    type: f.type,
    config: {},
    isSystem: false,
    options: f.options,
  };
}

const CHIP_ORDER = ['select', 'multi_select', 'user', 'relation', 'date', 'checkbox'];

/** Which dense fields render as chips: explicit visibility if configured, else the
 * top-4 by priority (the part-1 default). */
export function visibleFields(fields: DenseField[], config: MyWorkDbConfig): DenseField[] {
  if (config.hidden_field_ids) {
    const hidden = new Set(config.hidden_field_ids);
    return fields.filter((f) => !hidden.has(f.id)).slice(0, 6);
  }
  return [...fields].sort((a, b) => CHIP_ORDER.indexOf(a.type) - CHIP_ORDER.indexOf(b.type)).slice(0, 4);
}

function isEmpty(v: unknown): boolean {
  return v == null || v === '' || (Array.isArray(v) && v.length === 0);
}
function matchOne(value: unknown, op: string, target: unknown): boolean {
  const s = (x: unknown) => String(x ?? '').toLowerCase();
  const has = (x: unknown) => Array.isArray(value) && value.map(String).includes(String(x));
  switch (op) {
    case 'is_empty':
      return isEmpty(value);
    case 'is_not_empty':
      return !isEmpty(value);
    case 'eq':
    case 'is':
      return s(value) === s(target) || has(target);
    case 'neq':
    case 'is_not':
      return !(s(value) === s(target) || has(target));
    case 'contains':
      return s(value).includes(s(target)) || has(target);
    case 'not_contains':
      return !(s(value).includes(s(target)) || has(target));
    case 'gt':
      return Number(value) > Number(target);
    case 'gte':
      return Number(value) >= Number(target);
    case 'lt':
      return Number(value) < Number(target);
    case 'lte':
      return Number(value) <= Number(target);
    case 'before':
      return String(value) < String(target);
    case 'after':
      return String(value) > String(target);
    case 'on':
      return String(value).slice(0, 10) === String(target).slice(0, 10);
    default:
      return true; // unknown op → don't filter anything out
  }
}
/** Recursively evaluates one node of the filter tree against a record's values.
 * Mirrors the API's compileFilter/activeFilter recursion (MN-258): a group's
 * result is its children's results combined by its OWN connector; a disabled
 * leaf (MN-253 UI) contributes no opinion (`undefined`), same as it dropping out
 * of activeFilterNode for saved views. `undefined` propagates up through an empty
 * group exactly like an empty filter — "no verdict" reads as "don't exclude". */
function evaluateNode(node: FilterNode, values: Record<string, unknown>): boolean | undefined {
  if (isFilterGroup(node)) {
    const results = nodeChildren(node)
      .map((child) => evaluateNode(child, values))
      .filter((r): r is boolean => r !== undefined);
    if (results.length === 0) return undefined;
    return nodeConnector(node) === 'or' ? results.some(Boolean) : results.every(Boolean);
  }
  if (node.disabled) return undefined;
  return matchOne(values[node.field], node.op, node.value);
}

/** Client-side And/Or filter over the returned records (My Work is a bounded set),
 * now supporting nested groups (MN-258) — My Work shares the SAME `FiltersSection`
 * builder + persisted `FilterGroup` shape as saved views, so a group built here
 * must be evaluated with the same and/or nesting the server would apply. */
export function matchesFilters(
  values: Record<string, unknown>,
  config: MyWorkDbConfig,
): boolean {
  if (!config.filters) return true;
  return evaluateNode(config.filters, values) ?? true;
}

export interface RecordGroup<T> {
  key: string;
  label: string;
  color: string | null;
  records: T[];
}
/** Group records within a database by the chosen field's scalar value (MN-072 pt2). */
export function groupRecords<T extends { values: Record<string, unknown> }>(
  records: T[],
  fields: DenseField[],
  config: MyWorkDbConfig,
  memberNames: Map<string, string>,
): RecordGroup<T>[] {
  const field = config.group_by_field_id
    ? fields.find((f) => f.id === config.group_by_field_id)
    : undefined;
  if (!field) return [{ key: '_all', label: '', color: null, records }];

  const buckets = new Map<string, RecordGroup<T>>();
  const order: string[] = [];
  const push = (key: string, label: string, color: string | null, r: T) => {
    if (!buckets.has(key)) {
      buckets.set(key, { key, label, color, records: [] });
      order.push(key);
    }
    buckets.get(key)!.records.push(r);
  };
  for (const r of records) {
    const raw = r.values[field.api_name];
    const v = Array.isArray(raw) ? raw[0] : raw;
    if (v == null || v === '') {
      push('_none', `No ${field.display_name}`, null, r);
      continue;
    }
    if (field.type === 'select' || field.type === 'multi_select') {
      const opt = field.options?.find((o) => o.id === v);
      push(String(v), opt?.label ?? String(v), opt ? OPTION_COLORS[opt.color] ?? null : null, r);
    } else if (field.type === 'user') {
      push(String(v), memberNames.get(String(v)) ?? 'Someone', null, r);
    } else {
      push(String(v), String(v), null, r);
    }
  }
  // Options in their defined order first, then "No …" last.
  const ordered = order.filter((k) => k !== '_none').sort((a, b) => {
    if (field.options) {
      return (
        field.options.findIndex((o) => o.id === a) - field.options.findIndex((o) => o.id === b)
      );
    }
    return 0;
  });
  if (order.includes('_none')) ordered.push('_none');
  return ordered.map((k) => buckets.get(k)!);
}

/** Colour for a record's row from the color-by select field, or null. */
export function rowColor(
  values: Record<string, unknown>,
  fields: DenseField[],
  config: MyWorkDbConfig,
): string | null {
  const field = config.color_by_field_id
    ? fields.find((f) => f.id === config.color_by_field_id)
    : undefined;
  if (!field || (field.type !== 'select' && field.type !== 'multi_select')) return null;
  const raw = values[field.api_name];
  const v = Array.isArray(raw) ? raw[0] : raw;
  const opt = field.options?.find((o) => o.id === v);
  return opt ? OPTION_COLORS[opt.color] ?? null : null;
}

/** The per-group toolbar: group-by, visible fields, color-by, filters, and sort
 * (MN-252 — the same SortButton saved views use, applied client-side here). */
export function MyWorkGroupToolbar({
  fields,
  config,
  members,
  onChange,
}: {
  fields: DenseField[];
  config: MyWorkDbConfig;
  members: Array<{ id: string; name: string }>;
  onChange: (next: MyWorkDbConfig) => void;
}) {
  const adapted = fields.map(toField);
  const groupable = fields.filter((f) => f.type === 'select' || f.type === 'user');
  const colorable = adapted.filter((f) => f.type === 'select' || f.type === 'multi_select');
  const currentVisible = new Set(visibleFields(fields, config).map((f) => f.id));

  return (
    <div className="mb-1.5 flex flex-wrap items-center gap-1.5 text-[12px]">
      {/* Group by */}
      <div className="flex items-center gap-1 rounded px-1.5 py-1 text-muted">
        <Group className="h-3.5 w-3.5" />
        <select
          className="bg-transparent text-muted outline-none hover:text-ink"
          value={config.group_by_field_id ?? ''}
          onChange={(e) => onChange({ ...config, group_by_field_id: e.target.value || undefined })}
        >
          <option value="">No grouping</option>
          {groupable.map((f) => (
            <option key={f.id} value={f.id}>
              Group: {f.display_name}
            </option>
          ))}
        </select>
      </div>

      {/* Visible fields */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button className="flex items-center gap-1 rounded px-1.5 py-1 text-muted hover:bg-hover hover:text-ink">
            <SlidersHorizontal className="h-3.5 w-3.5" /> Fields
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent className="min-w-44">
          {fields.map((f) => {
            const on = currentVisible.has(f.id);
            return (
              <button
                key={f.id}
                className="flex w-full items-center justify-between rounded px-2 py-1.5 text-[13px] text-ink hover:bg-hover"
                onClick={() => {
                  const base = fields.filter((x) => currentVisible.has(x.id)).map((x) => x.id);
                  const nextVisible = on ? base.filter((id) => id !== f.id) : [...base, f.id];
                  const hidden = fields.filter((x) => !nextVisible.includes(x.id)).map((x) => x.id);
                  onChange({ ...config, hidden_field_ids: hidden });
                }}
              >
                {f.display_name}
                {on && <Check className="h-3.5 w-3.5 text-accent" />}
              </button>
            );
          })}
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Color by */}
      <ColorByButton
        fields={colorable}
        value={config.color_by_field_id}
        onChange={(fieldId) => onChange({ ...config, color_by_field_id: fieldId })}
      />

      {/* Filters (MN-253): the same builder + persisted shape as saved views. */}
      <FiltersSection
        fields={adapted}
        members={members}
        filters={config.filters}
        onChange={(filters) => onChange({ ...config, filters })}
      />

      {/* Sort (MN-252): the same builder as saved views; applied client-side via
          sortMyWorkRecords since My Work has no per-group query round trip. */}
      <SortButton
        fields={adapted}
        sorts={config.sorts ?? []}
        nulls={config.sorts_nulls}
        onChange={(sorts) => onChange({ ...config, sorts })}
        onNullsChange={(sorts_nulls) => onChange({ ...config, sorts_nulls })}
      />
    </div>
  );
}

/** A sub-group header inside a database group (label + count + optional colour dot). */
export function GroupHeader({ label, color, count }: { label: string; color: string | null; count: number }) {
  return (
    <div className="flex items-center gap-1.5 border-b border-border-default bg-hover/40 px-4 py-1.5 text-[11px] font-medium uppercase tracking-wider text-faint">
      {color && <span className="h-2 w-2 rounded-full" style={{ backgroundColor: color }} />}
      <span className={cn(!color && 'text-faint')}>{label}</span>
      <span>{count}</span>
    </div>
  );
}
