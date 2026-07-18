'use client';

import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowUpDown,
  Check,
  CircleHelp,
  Clock,
  Copy,
  Download,
  Eye,
  EyeOff,
  Group,
  GripVertical,
  Hash,
  ListFilter,
  MoreHorizontal,
  Palette,
  PenLine,
  Pin,
  PinOff,
  Plus,
  Trash2,
  Type,
  UserRound,
  X,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { DndContext, PointerSensor, closestCenter, useSensor, useSensors } from '@dnd-kit/core';
import type { DragEndEvent } from '@dnd-kit/core';
import { SortableContext, arrayMove, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { EntityIcon, IconColorPicker } from '@/components/ui/icon-picker';
import { API_URL, api } from '@/lib/api';
import { cn } from '@/lib/utils';
import type { Field } from '../table-view/use-table-data';
import { FIELD_TYPES } from '../table-view/field-dialog-shared';
import type { FilterCondition, SortSpec, ViewConfig } from './use-view-state';
import {
  buildFilterGroup,
  filterConditions,
  filterConnector,
  reorderConditions,
} from './filter-config';
import type { FilterConnector, FilterGroup } from './filter-config';

/** Op menu per field type — mirrors the API op×type matrix. */
export const OPS_BY_TYPE: Record<string, Array<{ op: string; label: string; input: 'text' | 'number' | 'date' | 'options' | 'relative' | 'boolean' | 'records' | 'none' }>> = {
  title: [
    { op: 'contains', label: 'contains', input: 'text' },
    { op: 'eq', label: 'is', input: 'text' },
    { op: 'is_empty', label: 'is empty', input: 'none' },
    { op: 'not_empty', label: 'is not empty', input: 'none' },
  ],
  text: [
    { op: 'contains', label: 'contains', input: 'text' },
    { op: 'eq', label: 'is', input: 'text' },
    { op: 'is_empty', label: 'is empty', input: 'none' },
    { op: 'not_empty', label: 'is not empty', input: 'none' },
  ],
  url: [
    { op: 'contains', label: 'contains', input: 'text' },
    { op: 'is_empty', label: 'is empty', input: 'none' },
  ],
  email: [
    { op: 'contains', label: 'contains', input: 'text' },
    { op: 'is_empty', label: 'is empty', input: 'none' },
  ],
  number: [
    { op: 'eq', label: '=', input: 'number' },
    { op: 'neq', label: '≠', input: 'number' },
    { op: 'gt', label: '>', input: 'number' },
    { op: 'gte', label: '≥', input: 'number' },
    { op: 'lt', label: '<', input: 'number' },
    { op: 'lte', label: '≤', input: 'number' },
    { op: 'is_empty', label: 'is empty', input: 'none' },
  ],
  date: [
    { op: 'within', label: 'within', input: 'relative' },
    { op: 'before', label: 'before', input: 'date' },
    { op: 'after', label: 'after', input: 'date' },
    { op: 'is_empty', label: 'is empty', input: 'none' },
  ],
  checkbox: [{ op: 'eq', label: 'is', input: 'boolean' }],
  select: [
    { op: 'has', label: 'is any of', input: 'options' },
    { op: 'has_none', label: 'is none of', input: 'options' },
    { op: 'is_empty', label: 'is empty', input: 'none' },
  ],
  multi_select: [
    { op: 'has', label: 'includes any of', input: 'options' },
    { op: 'has_none', label: 'includes none of', input: 'options' },
    { op: 'is_empty', label: 'is empty', input: 'none' },
  ],
  user: [
    { op: 'has', label: 'is any of', input: 'options' },
    { op: 'is_empty', label: 'is empty', input: 'none' },
  ],
  relation: [
    { op: 'not_empty', label: 'is linked', input: 'none' },
    { op: 'is_empty', label: 'is not linked', input: 'none' },
    { op: 'has', label: 'is any of', input: 'records' },
    { op: 'has_none', label: 'is none of', input: 'records' },
  ],
};

const RELATIVE_RANGES = [
  'today',
  'yesterday',
  'tomorrow',
  'last_7_days',
  'next_7_days',
  'this_month',
  'next_30_days',
];

export const SORTABLE = new Set(['title', 'text', 'number', 'date', 'url', 'email', 'select', 'checkbox', 'created_at', 'updated_at']);

export function ViewToolbar({
  fields,
  config,
  members,
  viewType = 'table',
  onPatch,
  ws,
  db,
  viewId,
}: {
  fields: Field[];
  config: ViewConfig;
  members: Array<{ id: string; name: string }>;
  viewType?: string;
  onPatch: (updates: Partial<ViewConfig>) => void;
  /** MN-075: identifies what to export. */
  ws?: string;
  db?: string;
  viewId?: string;
}) {
  const filterable = fields.filter((f) => OPS_BY_TYPE[f.type]);

  return (
    <div className="flex min-h-9 flex-wrap items-center gap-1.5 border-b border-border-default bg-app px-3 py-1">
      {/* Filters (MN-253): the builder + pinned chips — one spec (ViewConfig.filters)
          shared by every view type via this same component. */}
      <FiltersSection
        fields={filterable}
        members={members}
        ws={ws}
        filters={config.filters}
        onChange={(filters) => onPatch({ filters })}
      />

      {/* Sorts */}
      <SortButton fields={fields.filter((f) => SORTABLE.has(f.type))} sorts={config.sorts} onChange={(sorts) => onPatch({ sorts })} />

      {/* Field visibility: tables hide columns, boards pick card fields */}
      {viewType === 'board' || viewType === 'calendar' || viewType === 'gallery' || viewType === 'list' || viewType === 'feed' || viewType === 'form' ? (
        <CardFieldsButton
          fields={fields.filter((f) => !NON_TOGGLABLE.has(f.type))}
          shown={config.card_field_ids}
          onChange={(card_field_ids) => onPatch({ card_field_ids })}
          size={viewType === 'board' || viewType === 'gallery' ? config.card_size ?? 'medium' : undefined}
          onSizeChange={(card_size) => onPatch({ card_size })}
        />
      ) : (
        <HiddenFieldsButton
          fields={fields.filter((f) => !NON_TOGGLABLE.has(f.type))}
          hidden={config.hidden_field_ids}
          onChange={(hidden_field_ids) => onPatch({ hidden_field_ids })}
        />
      )}

      {viewType === 'calendar' && (
        <select
          className="h-6 rounded border border-border-default bg-card px-1 text-[12px] text-ink"
          value={config.date_field_id ?? ''}
          onChange={(e) => onPatch({ date_field_id: e.target.value })}
          title="Date field"
        >
          {fields.filter((f) => f.type === 'date' || f.type === 'created_at' || f.type === 'updated_at').map((f) => (
            <option key={f.id} value={f.id}>
              {f.displayName}
            </option>
          ))}
        </select>
      )}

      {/* Color-by (MN-102): tint rows/cards by a select field's option color. */}
      {(viewType === 'list' || viewType === 'feed' || viewType === 'timeline') && (
        <ColorByButton
          fields={fields.filter((f) => f.type === 'select')}
          value={config.color_by_field_id}
          onChange={(color_by_field_id) => onPatch({ color_by_field_id })}
        />
      )}

      {/* MN-075: the way out — this view's rows, exactly as shown. */}
      {ws && db && <ExportCsvButton ws={ws} db={db} viewId={viewId} />}
    </div>
  );
}

/**
 * A plain link, not a fetch: the browser handles the download, so we don't buffer
 * a large CSV into memory just to re-emit it as a blob. Credentials ride the
 * cookie the app already uses.
 */
export function ExportCsvButton({ ws, db, viewId }: { ws: string; db: string; viewId?: string }) {
  const href = `${API_URL}/api/v1/workspaces/${ws}/databases/${db}/export/csv${viewId ? `?view=${viewId}` : ''}`;
  return (
    <a
      href={href}
      className="ml-auto flex items-center gap-1 rounded px-1.5 py-0.5 text-[12px] text-muted hover:bg-hover hover:text-ink"
      title={viewId ? "Download this view's rows as CSV" : 'Download every record as CSV'}
    >
      <Download className="h-3.5 w-3.5" /> CSV
    </a>
  );
}

export function ColorByButton({
  fields,
  value,
  onChange,
}: {
  fields: Field[];
  value?: string;
  onChange: (fieldId: string | undefined) => void;
}) {
  if (fields.length === 0) return null;
  const active = fields.find((f) => f.id === value);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button className="flex items-center gap-1 rounded px-1.5 py-1 text-[12px] text-muted hover:bg-hover hover:text-ink">
          <Palette className="h-3.5 w-3.5" /> {active ? `Color: ${active.displayName}` : 'Color'}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="min-w-44">
        <button
          className="flex w-full items-center justify-between rounded px-2 py-1.5 text-[13px] text-ink hover:bg-hover"
          onClick={() => onChange(undefined)}
        >
          None {!value && <Check className="h-3.5 w-3.5 text-accent" />}
        </button>
        {fields.map((field) => (
          <button
            key={field.id}
            className="flex w-full items-center justify-between rounded px-2 py-1.5 text-[13px] text-ink hover:bg-hover"
            onClick={() => onChange(field.id)}
          >
            {field.displayName}
            {value === field.id && <Check className="h-3.5 w-3.5 text-accent" />}
          </button>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function defaultValueFor(input: string): unknown {
  if (input === 'options' || input === 'records') return [];
  if (input === 'boolean') return true;
  if (input === 'relative') return 'next_7_days';
  if (input === 'number') return 0;
  return '';
}

/** Field-type icon (mirrors the Add Field dialog's type list) — used on condition
 * rows, the add-condition menu and pinned chips so a filter's field is recognizable
 * at a glance (MN-253). Falls back for system types that aren't creatable fields. */
const TYPE_ICON = new Map(FIELD_TYPES.map((t) => [t.value, t.icon]));
const SYSTEM_TYPE_ICON: Record<string, LucideIcon> = {
  title: Type,
  id: Hash,
  created_at: Clock,
  updated_at: Clock,
  created_by: UserRound,
};
export function fieldTypeIcon(type: string): LucideIcon {
  return TYPE_ICON.get(type) ?? SYSTEM_TYPE_ICON[type] ?? ListFilter;
}

export function AddFilterButton({
  fields,
  onAdd,
  label = 'Filter',
}: {
  fields: Field[];
  onAdd: (field: Field) => void;
  label?: string;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button className="flex items-center gap-1 rounded px-1.5 py-1 text-[12px] text-muted hover:bg-hover hover:text-ink">
          <ListFilter className="h-3.5 w-3.5" /> {label}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="max-h-64 overflow-y-auto">
        {fields.map((field) => {
          const Icon = fieldTypeIcon(field.type);
          return (
            <button
              key={field.id}
              className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[13px] text-ink hover:bg-hover"
              onClick={() => onAdd(field)}
            >
              <Icon className="h-3.5 w-3.5 shrink-0 text-faint" />
              {field.displayName}
            </button>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The value editor for one condition — field-type-aware, shared by the compact
 * legacy chip (collection sections) and the full builder's condition rows. */
function FilterValueEditor({
  field,
  members,
  ws,
  activeOp,
  condition,
  onChange,
  compact = false,
}: {
  field: Field;
  members: Array<{ id: string; name: string }>;
  ws?: string;
  activeOp: { op: string; label: string; input: string };
  condition: FilterCondition;
  onChange: (condition: FilterCondition) => void;
  /** The old inline-chip look uses the chip's own background/borderless inputs. */
  compact?: boolean;
}) {
  const boxed = compact
    ? 'bg-card text-ink outline-none'
    : 'rounded border border-border-default bg-card px-1 py-0.5 text-[12px] text-ink outline-none';

  const optionSource: Array<{ id: string; label: string }> =
    field.type === 'user'
      ? members.map((m) => ({ id: m.id, label: m.name }))
      : (field.options ?? []).map((o) => ({ id: o.id, label: o.label }));

  if (activeOp.input === 'text') {
    return (
      <input
        className={cn(compact ? 'w-24' : 'w-24', boxed)}
        value={String(condition.value ?? '')}
        onChange={(e) => onChange({ ...condition, value: e.target.value })}
      />
    );
  }
  if (activeOp.input === 'number') {
    return (
      <input
        className={cn('w-16', boxed)}
        inputMode="decimal"
        value={String(condition.value ?? '')}
        onChange={(e) => onChange({ ...condition, value: Number(e.target.value) })}
      />
    );
  }
  if (activeOp.input === 'date') {
    return (
      <input
        type="date"
        className={boxed}
        value={String(condition.value ?? '')}
        onChange={(e) => onChange({ ...condition, value: e.target.value })}
      />
    );
  }
  if (activeOp.input === 'relative') {
    return (
      <select
        className={boxed}
        value={String(condition.value ?? 'next_7_days')}
        onChange={(e) => onChange({ ...condition, value: e.target.value })}
      >
        {RELATIVE_RANGES.map((r) => (
          <option key={r} value={r}>
            {r.replaceAll('_', ' ')}
          </option>
        ))}
      </select>
    );
  }
  if (activeOp.input === 'boolean') {
    return (
      <select
        className={boxed}
        value={String(condition.value ?? 'true')}
        onChange={(e) => onChange({ ...condition, value: e.target.value === 'true' })}
      >
        <option value="true">checked</option>
        <option value="false">unchecked</option>
      </select>
    );
  }
  if (activeOp.input === 'options') {
    return (
      <OptionMultiPick
        options={optionSource}
        selected={Array.isArray(condition.value) ? (condition.value as string[]) : []}
        onChange={(ids) => onChange({ ...condition, value: ids })}
      />
    );
  }
  if (activeOp.input === 'records') {
    return ws && field.relation ? (
      <RecordPicker
        ws={ws}
        field={field}
        selected={Array.isArray(condition.value) ? (condition.value as string[]) : []}
        onChange={(ids) => onChange({ ...condition, value: ids })}
      />
    ) : (
      <span className="text-faint">unavailable</span>
    );
  }
  return null;
}

/** Default, human-readable description of a condition — e.g. "State is none of
 * Done" — used as the pinned-chip label and the "Edit name" placeholder until the
 * user sets a custom one. Relation values aren't resolved here (that needs an
 * async title lookup — RecordPicker does that); they render as a count instead. */
function describeCondition(
  field: Field,
  condition: FilterCondition,
  members: Array<{ id: string; name: string }>,
): string {
  const ops = OPS_BY_TYPE[field.type] ?? [];
  const activeOp = ops.find((o) => o.op === condition.op) ?? ops[0];
  if (!activeOp) return field.displayName;
  if (activeOp.input === 'none') return `${field.displayName} ${activeOp.label}`;
  if (activeOp.input === 'options') {
    const ids = Array.isArray(condition.value) ? (condition.value as string[]) : [];
    if (ids.length === 0) return `${field.displayName} ${activeOp.label}`;
    const source =
      field.type === 'user'
        ? members.map((m) => ({ id: m.id, label: m.name }))
        : (field.options ?? []).map((o) => ({ id: o.id, label: o.label }));
    const labels = ids.map((id) => source.find((s) => s.id === id)?.label ?? id);
    return `${field.displayName} ${activeOp.label} ${labels.join(', ')}`;
  }
  if (activeOp.input === 'records') {
    const ids = Array.isArray(condition.value) ? (condition.value as string[]) : [];
    if (ids.length === 0) return `${field.displayName} ${activeOp.label}`;
    return `${field.displayName} ${activeOp.label} ${ids.length} record${ids.length > 1 ? 's' : ''}`;
  }
  if (activeOp.input === 'boolean') {
    return `${field.displayName} ${activeOp.label} ${condition.value ? 'checked' : 'unchecked'}`;
  }
  if (activeOp.input === 'relative') {
    return `${field.displayName} ${activeOp.label} ${String(condition.value ?? '').replaceAll('_', ' ')}`;
  }
  const v = String(condition.value ?? '').trim();
  return v ? `${field.displayName} ${activeOp.label} ${v}` : `${field.displayName} ${activeOp.label}`;
}

/** Legacy compact chip: still used by embedded, smaller-scoped filter UIs
 * (relation collection sections, MN-206) that don't need the full builder. */
export function FilterChip({
  fields,
  members,
  condition,
  ws,
  onChange,
  onRemove,
}: {
  fields: Field[];
  members: Array<{ id: string; name: string }>;
  condition: FilterCondition;
  /** Needed by the relation record picker (`has`/`has_none`) to search the target DB. */
  ws?: string;
  onChange: (condition: FilterCondition) => void;
  onRemove: () => void;
}) {
  const field = fields.find((f) => f.apiName === condition.field);
  if (!field) return null;
  const ops = OPS_BY_TYPE[field.type] ?? [];
  const activeOp = ops.find((o) => o.op === condition.op) ?? ops[0]!;

  return (
    <span className="flex items-center gap-1 rounded-[var(--radius-control)] border border-border-default bg-card px-1.5 py-0.5 text-[12px]">
      <span className="font-medium text-ink">{field.displayName}</span>
      <select
        className="bg-card text-muted outline-none"
        value={condition.op}
        onChange={(e) => {
          const nextOp = ops.find((o) => o.op === e.target.value)!;
          onChange({ ...condition, op: nextOp.op, value: defaultValueFor(nextOp.input) });
        }}
      >
        {ops.map((o) => (
          <option key={o.op} value={o.op}>
            {o.label}
          </option>
        ))}
      </select>

      <FilterValueEditor field={field} members={members} ws={ws} activeOp={activeOp} condition={condition} onChange={onChange} compact />

      <button onClick={onRemove} className="text-faint hover:text-error">
        <X className="h-3 w-3" />
      </button>
    </span>
  );
}

/**
 * Pinned filter chips + the "N filters" trigger that opens the builder popover
 * (MN-253). One `FilterGroup` (persisted as `ViewConfig.filters`) drives both —
 * pinning just formalizes what used to be "every active condition is a chip".
 */
export function FiltersSection({
  fields,
  members,
  ws,
  filters,
  onChange,
}: {
  fields: Field[];
  members: Array<{ id: string; name: string }>;
  ws?: string;
  filters: FilterGroup | undefined;
  onChange: (filters: FilterGroup | undefined) => void;
}) {
  const [open, setOpen] = useState(false);
  const connector = filterConnector(filters);
  const conditions = filterConditions(filters);
  const pinned = conditions.filter((c) => c.pinned);
  const activeCount = conditions.filter((c) => !c.disabled).length;

  function setConditions(next: FilterCondition[]) {
    onChange(buildFilterGroup(connector, next));
  }
  function updateAt(i: number, next: FilterCondition) {
    setConditions(conditions.map((c, j) => (j === i ? next : c)));
  }

  return (
    <>
      {pinned.map((condition) => {
        const i = conditions.indexOf(condition);
        const field = fields.find((f) => f.apiName === condition.field);
        if (!field) return null;
        return (
          <PinnedFilterChip
            key={i}
            field={field}
            condition={condition}
            members={members}
            onOpenBuilder={() => setOpen(true)}
            onUnpin={() => updateAt(i, { ...condition, pinned: false })}
          />
        );
      })}
      <span className="relative">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className={cn(
            'flex items-center gap-1 rounded px-1.5 py-1 text-[12px] hover:bg-hover',
            activeCount ? 'text-ink' : 'text-muted',
          )}
        >
          <ListFilter className="h-3.5 w-3.5" />
          {activeCount > 0 ? `${activeCount} filter${activeCount > 1 ? 's' : ''}` : 'Filter'}
        </button>
        {open && (
          <>
            {/* A full-screen backdrop, not a document click-outside listener: the
                panel below nests Radix dropdowns (option pickers, the "…" menu)
                that portal outside this subtree, so contains()-based outside-click
                detection would misfire and close the builder mid-interaction. */}
            <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
            <div className="absolute left-0 top-full z-50 mt-1 w-[26rem] max-w-[calc(100vw-2rem)] rounded-[var(--radius-card)] border border-border-default bg-card shadow-[0_4px_12px_rgba(15,23,41,0.08)]">
              <FilterBuilderPanel
                fields={fields}
                members={members}
                ws={ws}
                connector={connector}
                conditions={conditions}
                onConditionsChange={setConditions}
                onConnectorChange={(next) => onChange(buildFilterGroup(next, conditions))}
              />
            </div>
          </>
        )}
      </span>
    </>
  );
}

function PinnedFilterChip({
  field,
  condition,
  members,
  onOpenBuilder,
  onUnpin,
}: {
  field: Field;
  condition: FilterCondition;
  members: Array<{ id: string; name: string }>;
  onOpenBuilder: () => void;
  onUnpin: () => void;
}) {
  const label = condition.label || describeCondition(field, condition, members);
  const Icon = fieldTypeIcon(field.type);
  return (
    <span
      className={cn(
        'flex items-center gap-1 rounded-[var(--radius-control)] border border-border-default bg-card px-1.5 py-0.5 text-[12px]',
        condition.disabled && 'opacity-50',
      )}
    >
      <button
        type="button"
        onClick={onOpenBuilder}
        className="flex items-center gap-1"
        title={condition.disabled ? `${label} — disabled` : label}
      >
        <EntityIcon icon={condition.icon} color={null} size={12} fallback={<Icon className="h-3 w-3 text-faint" />} />
        <span className="max-w-40 truncate text-ink">{label}</span>
      </button>
      <button type="button" onClick={onUnpin} className="text-faint hover:text-error" title="Unpin from toolbar">
        <X className="h-3 w-3" />
      </button>
    </span>
  );
}

/** The builder popover's body: "Where" + condition rows (draggable, And/Or
 * between them), + add-condition, + an empty state and a help link (MN-253). */
function FilterBuilderPanel({
  fields,
  members,
  ws,
  connector,
  conditions,
  onConditionsChange,
  onConnectorChange,
}: {
  fields: Field[];
  members: Array<{ id: string; name: string }>;
  ws?: string;
  connector: FilterConnector;
  conditions: FilterCondition[];
  onConditionsChange: (next: FilterCondition[]) => void;
  onConnectorChange: (next: FilterConnector) => void;
}) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  function updateAt(i: number, next: FilterCondition) {
    onConditionsChange(conditions.map((c, j) => (j === i ? next : c)));
  }
  function removeAt(i: number) {
    onConditionsChange(conditions.filter((_, j) => j !== i));
  }
  function duplicateAt(i: number) {
    const copy = { ...conditions[i]!, pinned: false };
    onConditionsChange([...conditions.slice(0, i + 1), copy, ...conditions.slice(i + 1)]);
  }
  function addCondition(field: Field) {
    const first = OPS_BY_TYPE[field.type]![0]!;
    onConditionsChange([
      ...conditions,
      { field: field.apiName, op: first.op, value: defaultValueFor(first.input) },
    ]);
  }

  function onDragEnd(e: DragEndEvent) {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    onConditionsChange(reorderConditions(conditions, Number(active.id), Number(over.id)));
  }

  return (
    <div className="flex max-h-[70vh] flex-col">
      <div className="flex items-center justify-between border-b border-border-default px-3 py-2">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-faint">Filters</span>
        <a
          href="https://docs.storyos.dev/concepts/views/#filters--sorts"
          target="_blank"
          rel="noreferrer"
          className="flex items-center gap-1 text-faint hover:text-ink"
          title="How filters work on views"
        >
          <CircleHelp className="h-3.5 w-3.5" />
        </a>
      </div>

      {conditions.length === 0 ? (
        <div className="px-3 py-6 text-center">
          <p className="mb-2 text-[12px] text-faint">No filters yet — narrow this view down to what matters.</p>
          <div className="flex justify-center">
            <AddFilterButton fields={fields} onAdd={addCondition} label="Add your first filter" />
          </div>
        </div>
      ) : (
        <div className="max-h-80 overflow-y-auto p-1">
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
            <SortableContext items={conditions.map((_, i) => String(i))} strategy={verticalListSortingStrategy}>
              {conditions.map((condition, i) => (
                <ConditionRow
                  key={i}
                  index={i}
                  condition={condition}
                  fields={fields}
                  members={members}
                  ws={ws}
                  connector={connector}
                  onConnectorChange={onConnectorChange}
                  onChange={(next) => updateAt(i, next)}
                  onDuplicate={() => duplicateAt(i)}
                  onPin={() => updateAt(i, { ...condition, pinned: !condition.pinned })}
                  onRemove={() => removeAt(i)}
                />
              ))}
            </SortableContext>
          </DndContext>
        </div>
      )}

      {conditions.length > 0 && (
        <div className="border-t border-border-default p-1">
          <AddFilterButton fields={fields} onAdd={addCondition} label="Add condition" />
        </div>
      )}
    </div>
  );
}

function ConnectorToggle({ value, onChange }: { value: FilterConnector; onChange: (v: FilterConnector) => void }) {
  return (
    <span className="inline-flex overflow-hidden rounded border border-border-default text-[10px] font-semibold uppercase leading-none">
      {(['and', 'or'] as const).map((c) => (
        <button
          key={c}
          type="button"
          onClick={() => onChange(c)}
          className={cn('px-1.5 py-0.5', value === c ? 'bg-accent-soft text-ink' : 'text-faint hover:text-ink')}
        >
          {c}
        </button>
      ))}
    </span>
  );
}

function ConditionRow({
  index,
  condition,
  fields,
  members,
  ws,
  connector,
  onConnectorChange,
  onChange,
  onDuplicate,
  onPin,
  onRemove,
}: {
  index: number;
  condition: FilterCondition;
  fields: Field[];
  members: Array<{ id: string; name: string }>;
  ws?: string;
  connector: FilterConnector;
  onConnectorChange: (next: FilterConnector) => void;
  onChange: (next: FilterCondition) => void;
  onDuplicate: () => void;
  onPin: () => void;
  onRemove: () => void;
}) {
  const [editingLabel, setEditingLabel] = useState(false);
  const [pickingIcon, setPickingIcon] = useState(false);
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: String(index),
  });
  const field = fields.find((f) => f.apiName === condition.field);
  if (!field) return null;
  const ops = OPS_BY_TYPE[field.type] ?? [];
  const activeOp = ops.find((o) => o.op === condition.op) ?? ops[0]!;
  const Icon = fieldTypeIcon(field.type);
  const defaultLabel = describeCondition(field, condition, members);

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(
        'group relative rounded px-1 py-1.5',
        isDragging && 'z-40 bg-card opacity-90 shadow-[0_4px_12px_rgba(15,23,41,0.12)]',
      )}
    >
      <div className="flex items-start gap-1.5">
        <button
          {...attributes}
          {...listeners}
          className="mt-1.5 shrink-0 cursor-grab text-faint opacity-0 hover:text-muted group-hover:opacity-100"
          title="Drag to reorder"
        >
          <GripVertical className="h-3.5 w-3.5" />
        </button>

        <div className="min-w-0 flex-1">
          <div className="mb-1">
            {index === 0 ? (
              <span className="text-[11px] font-semibold uppercase tracking-wider text-faint">Where</span>
            ) : (
              <ConnectorToggle value={connector} onChange={onConnectorChange} />
            )}
          </div>
          <div className={cn('flex flex-wrap items-center gap-1', condition.disabled && 'opacity-50')}>
            <EntityIcon icon={condition.icon} color={null} size={13} fallback={<Icon className="h-3.5 w-3.5 shrink-0 text-faint" />} />
            <select
              className="max-w-28 truncate rounded border border-border-default bg-card px-1 py-0.5 text-[12px] text-ink"
              value={condition.field}
              onChange={(e) => {
                const nextField = fields.find((f) => f.apiName === e.target.value);
                if (!nextField) return;
                const first = (OPS_BY_TYPE[nextField.type] ?? [])[0];
                onChange({
                  ...condition,
                  field: nextField.apiName,
                  op: first?.op ?? condition.op,
                  value: first ? defaultValueFor(first.input) : condition.value,
                });
              }}
            >
              {fields.map((f) => (
                <option key={f.id} value={f.apiName}>
                  {f.displayName}
                </option>
              ))}
            </select>
            <select
              className="rounded border border-border-default bg-card px-1 py-0.5 text-[12px] text-muted"
              value={condition.op}
              onChange={(e) => {
                const nextOp = ops.find((o) => o.op === e.target.value)!;
                onChange({ ...condition, op: nextOp.op, value: defaultValueFor(nextOp.input) });
              }}
            >
              {ops.map((o) => (
                <option key={o.op} value={o.op}>
                  {o.label}
                </option>
              ))}
            </select>
            <FilterValueEditor field={field} members={members} ws={ws} activeOp={activeOp} condition={condition} onChange={onChange} />
          </div>

          {editingLabel && (
            <div className="mt-1.5 flex items-center gap-1.5 rounded border border-border-default bg-app p-1.5">
              <button
                type="button"
                onClick={() => setPickingIcon((v) => !v)}
                className="flex h-6 w-6 shrink-0 items-center justify-center rounded border border-border-default hover:bg-hover"
                title="Change icon"
              >
                <EntityIcon icon={condition.icon} color={null} size={13} fallback={<Icon className="h-3.5 w-3.5 text-faint" />} />
              </button>
              <input
                autoFocus
                className="h-6 flex-1 rounded border border-border-default bg-card px-1.5 text-[12px] text-ink outline-none"
                placeholder={defaultLabel}
                value={condition.label ?? ''}
                onChange={(e) => onChange({ ...condition, label: e.target.value || undefined })}
              />
              <button
                type="button"
                className="text-[11px] text-muted hover:text-ink"
                onClick={() => {
                  setEditingLabel(false);
                  setPickingIcon(false);
                }}
              >
                Done
              </button>
              {pickingIcon && (
                <div className="absolute left-0 top-full z-50 mt-1 rounded-[var(--radius-card)] border border-border-default bg-card p-2 shadow-[0_4px_12px_rgba(15,23,41,0.08)]">
                  <IconColorPicker
                    icon={condition.icon ?? null}
                    color={null}
                    onChange={(patch) => {
                      if ('icon' in patch) onChange({ ...condition, icon: patch.icon ?? undefined });
                    }}
                  />
                </div>
              )}
            </div>
          )}
        </div>

        <ConditionMenu
          condition={condition}
          onDuplicate={onDuplicate}
          onPin={onPin}
          onEditNameIcon={() => setEditingLabel((v) => !v)}
          onToggleDisabled={() => onChange({ ...condition, disabled: !condition.disabled })}
          onRemove={onRemove}
        />
      </div>
    </div>
  );
}

/** Per-clause "…" menu (MN-253): duplicate, pin, rename/re-icon, non-destructive
 * disable, remove. "Turn into group" is a deliberate no-op tonight — nested groups
 * are a separate backend sub-ticket (see the MN-253 spike report). */
function ConditionMenu({
  condition,
  onDuplicate,
  onPin,
  onEditNameIcon,
  onToggleDisabled,
  onRemove,
}: {
  condition: FilterCondition;
  onDuplicate: () => void;
  onPin: () => void;
  onEditNameIcon: () => void;
  onToggleDisabled: () => void;
  onRemove: () => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" className="mt-1 shrink-0 rounded p-0.5 text-faint hover:bg-active hover:text-ink" title="More">
          <MoreHorizontal className="h-3.5 w-3.5" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-48">
        <DropdownMenuItem onSelect={onDuplicate}>
          <Copy className="h-3.5 w-3.5" /> Duplicate
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onPin}>
          {condition.pinned ? <PinOff className="h-3.5 w-3.5" /> : <Pin className="h-3.5 w-3.5" />}
          {condition.pinned ? 'Unpin from toolbar' : 'Pin to toolbar'}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onEditNameIcon}>
          <PenLine className="h-3.5 w-3.5" /> Edit name and icon
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onToggleDisabled}>
          {condition.disabled ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
          {condition.disabled ? 'Enable' : 'Disable'}
        </DropdownMenuItem>
        <DropdownMenuItem disabled className="opacity-50" title="Nested filter groups are coming in a future update">
          <Group className="h-3.5 w-3.5" /> Turn into group
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem className="text-error" onSelect={onRemove}>
          <Trash2 className="h-3.5 w-3.5" /> Remove
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function OptionMultiPick({
  options,
  selected,
  onChange,
}: {
  options: Array<{ id: string; label: string }>;
  selected: string[];
  onChange: (ids: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const label =
    selected.length === 0
      ? 'pick…'
      : options
          .filter((o) => selected.includes(o.id))
          .map((o) => o.label)
          .join(', ');
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <button className={cn('max-w-40 truncate text-left', selected.length ? 'text-ink' : 'text-faint')}>
          {label}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="max-h-64 overflow-y-auto">
        {options.map((option) => (
          <label
            key={option.id}
            className="flex items-center gap-2 rounded px-2 py-1.5 text-[13px] text-ink hover:bg-hover"
          >
            <input
              type="checkbox"
              checked={selected.includes(option.id)}
              onChange={(e) =>
                onChange(
                  e.target.checked ? [...selected, option.id] : selected.filter((id) => id !== option.id),
                )
              }
            />
            {option.label}
          </label>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Relation filter picker (MN-223): search the relation's target database and
 * multi-select records. The condition `value` is an array of record ids; the
 * selected ids render as removable title chips. Titles come from the live search
 * results plus a per-id lookup that resolves ids restored from a saved filter.
 */
function RecordPicker({
  ws,
  field,
  selected,
  onChange,
}: {
  ws: string;
  field: Field;
  selected: string[];
  onChange: (ids: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [titles, setTitles] = useState<Record<string, string>>({});
  const ref = useRef<HTMLSpanElement>(null);
  const targetDb = field.relation?.target_database_id ?? '';

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const results = useQuery({
    queryKey: ['relation-filter-picker', ws, targetDb, search],
    enabled: open && Boolean(targetDb),
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/workspaces/{ws}/databases/{db}/records', {
        params: { path: { ws, db: targetDb }, query: { q: search || undefined, limit: 20 } },
      });
      if (error) throw error;
      return (data as unknown as { data: Array<{ id: string; title: string }> }).data;
    },
  });

  // Cache titles from search results so removing the search text keeps chip labels.
  useEffect(() => {
    if (!results.data) return;
    setTitles((prev) => {
      const next = { ...prev };
      for (const r of results.data!) next[r.id] = r.title;
      return next;
    });
  }, [results.data]);

  // Resolve titles for selected ids we haven't seen yet (e.g. a restored filter).
  const unresolved = selected.filter((id) => !(id in titles));
  useQuery({
    queryKey: ['relation-filter-titles', ws, targetDb, unresolved],
    enabled: Boolean(targetDb) && unresolved.length > 0,
    queryFn: async () => {
      const fetched = await Promise.all(
        unresolved.map(async (id) => {
          const { data } = await api.GET(
            '/api/v1/workspaces/{ws}/databases/{db}/records/{rec}',
            { params: { path: { ws, db: targetDb, rec: id } } },
          );
          return data as unknown as { id: string; title: string } | undefined;
        }),
      );
      setTitles((prev) => {
        const next = { ...prev };
        for (const r of fetched) if (r?.id) next[r.id] = r.title;
        return next;
      });
      return null;
    },
  });

  const titleFor = (id: string) => titles[id] || 'Untitled';
  const label = selected.length === 0 ? 'pick…' : selected.map(titleFor).join(', ');

  function toggle(id: string) {
    onChange(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);
  }

  return (
    <span ref={ref} className="relative">
      <button
        type="button"
        className={cn('max-w-40 truncate text-left', selected.length ? 'text-ink' : 'text-faint')}
        onClick={() => setOpen((o) => !o)}
      >
        {label}
      </button>
      {open && (
        <div className="absolute left-0 top-full z-30 mt-1 w-64 rounded-[var(--radius-card)] border border-border-default bg-card shadow-[0_4px_12px_rgba(15,23,41,0.08)]">
          {selected.length > 0 && (
            <div className="flex flex-wrap gap-1 border-b border-border-default p-2">
              {selected.map((id) => (
                <span
                  key={id}
                  className="inline-flex items-center gap-1 rounded border border-border-default bg-hover px-1.5 py-0.5 text-[12px] text-ink"
                >
                  <span className="max-w-32 truncate">{titleFor(id)}</span>
                  <button onClick={() => toggle(id)} className="text-faint hover:text-error">
                    <X className="h-3 w-3" />
                  </button>
                </span>
              ))}
            </div>
          )}
          <input
            autoFocus
            placeholder={`Search ${field.relation?.target_database_name ?? 'records'}…`}
            className="w-full border-b border-border-default bg-card px-3 py-2 text-[13px] text-ink outline-none placeholder:text-faint"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <div className="max-h-56 overflow-y-auto p-1">
            {(results.data ?? []).map((row) => (
              <button
                key={row.id}
                className={cn(
                  'flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-[13px] text-ink hover:bg-hover',
                  selected.includes(row.id) && 'bg-hover',
                )}
                onClick={() => toggle(row.id)}
              >
                <span className="truncate">{row.title || 'Untitled'}</span>
                {selected.includes(row.id) && <Check className="h-3.5 w-3.5 text-accent" />}
              </button>
            ))}
            {results.data?.length === 0 && (
              <p className="px-2 py-1.5 text-[12px] text-faint">No matches.</p>
            )}
          </div>
        </div>
      )}
    </span>
  );
}

export function SortButton({
  fields,
  sorts,
  onChange,
}: {
  fields: Field[];
  sorts: SortSpec[];
  onChange: (sorts: SortSpec[]) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          className={cn(
            'flex items-center gap-1 rounded px-1.5 py-1 text-[12px] hover:bg-hover',
            sorts.length ? 'text-ink' : 'text-muted',
          )}
        >
          <ArrowUpDown className="h-3.5 w-3.5" />
          {sorts.length ? `Sorted by ${sorts.length}` : 'Sort'}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-64 p-2">
        {sorts.map((sort, i) => (
          <div key={i} className="mb-1.5 flex items-center gap-1.5">
            <select
              className="h-7 flex-1 rounded border border-border-default bg-card px-1 text-[12px] text-ink"
              value={sort.field}
              onChange={(e) => onChange(sorts.map((s, j) => (j === i ? { ...s, field: e.target.value } : s)))}
            >
              {fields.map((f) => (
                <option key={f.id} value={f.apiName}>
                  {f.displayName}
                </option>
              ))}
            </select>
            <select
              className="h-7 rounded border border-border-default bg-card px-1 text-[12px] text-ink"
              value={sort.direction}
              onChange={(e) =>
                onChange(sorts.map((s, j) => (j === i ? { ...s, direction: e.target.value as 'asc' | 'desc' } : s)))
              }
            >
              <option value="asc">↑ asc</option>
              <option value="desc">↓ desc</option>
            </select>
            <button onClick={() => onChange(sorts.filter((_, j) => j !== i))} className="text-faint hover:text-error">
              <X className="h-3 w-3" />
            </button>
          </div>
        ))}
        {sorts.length < 3 && fields.length > 0 && (
          <button
            className="flex items-center gap-1 rounded px-1 py-1 text-[12px] text-muted hover:text-ink"
            onClick={() => onChange([...sorts, { field: fields[0]!.apiName, direction: 'asc' }])}
          >
            <Plus className="h-3 w-3" /> Add sort
          </button>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Title always shows; system timestamps never render in grids or on cards. */
const NON_TOGGLABLE = new Set(['title', 'created_by']);

/** Board/calendar card composition (MN-042, MN-089): which fields show + card size. */
function CardFieldsButton({
  fields,
  shown,
  onChange,
  size,
  onSizeChange,
}: {
  fields: Field[];
  shown: string[];
  onChange: (ids: string[]) => void;
  size?: 'small' | 'medium' | 'large';
  onSizeChange: (size: 'small' | 'medium' | 'large') => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          className={cn(
            'flex items-center gap-1 rounded px-1.5 py-1 text-[12px] hover:bg-hover',
            shown.length ? 'text-ink' : 'text-muted',
          )}
        >
          <EyeOff className="h-3.5 w-3.5" />
          Cards
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="max-h-72 w-56 overflow-y-auto">
        {size && (
          <div className="px-2 pb-1.5 pt-1">
            <div className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-faint">Card size</div>
            <div className="flex gap-1">
              {(['small', 'medium', 'large'] as const).map((opt) => (
                <button
                  key={opt}
                  onClick={() => onSizeChange(opt)}
                  className={cn(
                    'flex-1 rounded border px-1.5 py-1 text-[12px] capitalize',
                    size === opt
                      ? 'border-[var(--accent)] bg-accent-soft text-ink'
                      : 'border-border-default text-muted hover:bg-hover',
                  )}
                >
                  {opt === 'small' ? 'S' : opt === 'medium' ? 'M' : 'L'}
                </button>
              ))}
            </div>
          </div>
        )}
        <CardFieldPicker fields={fields} shown={shown} onChange={onChange} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Shown card fields (draggable, ordered) + a list to add more (MN-151). */
function CardFieldPicker({ fields, shown, onChange }: { fields: Field[]; shown: string[]; onChange: (ids: string[]) => void }) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
  const shownFields = shown
    .map((id) => fields.find((f) => f.id === id))
    .filter((f): f is Field => Boolean(f));
  const available = fields.filter((f) => !shown.includes(f.id));

  const onDragEnd = (e: DragEndEvent) => {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const from = shown.indexOf(String(active.id));
    const to = shown.indexOf(String(over.id));
    if (from < 0 || to < 0) return;
    onChange(arrayMove(shown, from, to));
  };

  return (
    <>
      {shownFields.length > 0 && (
        <>
          <div className="px-2 pb-0.5 pt-1 text-[11px] font-semibold uppercase tracking-wider text-faint">
            Shown · drag to reorder
          </div>
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
            <SortableContext items={shown} strategy={verticalListSortingStrategy}>
              {shownFields.map((field) => (
                <SortableCardField
                  key={field.id}
                  field={field}
                  onRemove={() => onChange(shown.filter((id) => id !== field.id))}
                />
              ))}
            </SortableContext>
          </DndContext>
        </>
      )}
      {available.length > 0 && (
        <>
          <div className="px-2 pb-0.5 pt-1.5 text-[11px] font-semibold uppercase tracking-wider text-faint">Add</div>
          {available.map((field) => (
            <button
              key={field.id}
              onClick={() => onChange([...shown, field.id])}
              className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-[13px] text-muted hover:bg-hover hover:text-ink"
            >
              <Plus className="h-3.5 w-3.5" /> {field.displayName}
            </button>
          ))}
        </>
      )}
    </>
  );
}

function SortableCardField({ field, onRemove }: { field: Field; onRemove: () => void }) {
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({ id: field.id });
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className="group flex items-center gap-2 rounded px-2 py-1.5 text-[13px] text-ink hover:bg-hover"
    >
      <button {...attributes} {...listeners} className="cursor-grab text-faint hover:text-muted" title="Drag to reorder">
        <GripVertical className="h-3.5 w-3.5" />
      </button>
      <span className="flex-1 truncate">{field.displayName}</span>
      <button
        onClick={onRemove}
        className="text-faint opacity-0 hover:text-error group-hover:opacity-100"
        title="Remove from cards"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

function HiddenFieldsButton({
  fields,
  hidden,
  onChange,
}: {
  fields: Field[];
  hidden: string[];
  onChange: (ids: string[]) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          className={cn(
            'flex items-center gap-1 rounded px-1.5 py-1 text-[12px] hover:bg-hover',
            hidden.length ? 'text-ink' : 'text-muted',
          )}
        >
          <EyeOff className="h-3.5 w-3.5" />
          {hidden.length ? `${hidden.length} hidden` : 'Hide fields'}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="max-h-64 overflow-y-auto">
        {fields.map((field) => (
          <label
            key={field.id}
            className="flex items-center gap-2 rounded px-2 py-1.5 text-[13px] text-ink hover:bg-hover"
          >
            <input
              type="checkbox"
              checked={!hidden.includes(field.id)}
              onChange={(e) =>
                onChange(e.target.checked ? hidden.filter((id) => id !== field.id) : [...hidden, field.id])
              }
            />
            {field.displayName}
          </label>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
