'use client';

import { useState } from 'react';
import { ArrowUpDown, Check, Download, EyeOff, GripVertical, ListFilter, Palette, Plus, X } from 'lucide-react';
import { DndContext, PointerSensor, closestCenter, useSensor, useSensors } from '@dnd-kit/core';
import type { DragEndEvent } from '@dnd-kit/core';
import { SortableContext, arrayMove, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { API_URL } from '@/lib/api';
import { cn } from '@/lib/utils';
import type { Field } from '../table-view/use-table-data';
import type { FilterCondition, SortSpec, ViewConfig } from './use-view-state';

/** Op menu per field type — mirrors the API op×type matrix. */
export const OPS_BY_TYPE: Record<string, Array<{ op: string; label: string; input: 'text' | 'number' | 'date' | 'options' | 'relative' | 'boolean' | 'none' }>> = {
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
  const conditions = config.filters?.and ?? [];

  function setConditions(next: FilterCondition[]) {
    onPatch({ filters: next.length > 0 ? { and: next } : undefined });
  }

  return (
    <div className="flex min-h-9 flex-wrap items-center gap-1.5 border-b border-border-default bg-app px-3 py-1">
      {/* Filters */}
      {conditions.map((condition, i) => (
        <FilterChip
          key={i}
          fields={filterable}
          members={members}
          condition={condition}
          onChange={(next) => setConditions(conditions.map((c, j) => (j === i ? next : c)))}
          onRemove={() => setConditions(conditions.filter((_, j) => j !== i))}
        />
      ))}
      <AddFilterButton
        fields={filterable}
        onAdd={(field) => {
          const first = OPS_BY_TYPE[field.type]![0]!;
          setConditions([
            ...conditions,
            { field: field.apiName, op: first.op, value: defaultValueFor(first.input) },
          ]);
        }}
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

function defaultValueFor(input: string): unknown {
  if (input === 'options') return [];
  if (input === 'boolean') return true;
  if (input === 'relative') return 'next_7_days';
  if (input === 'number') return 0;
  return '';
}

export function AddFilterButton({ fields, onAdd }: { fields: Field[]; onAdd: (field: Field) => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button className="flex items-center gap-1 rounded px-1.5 py-1 text-[12px] text-muted hover:bg-hover hover:text-ink">
          <ListFilter className="h-3.5 w-3.5" /> Filter
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="max-h-64 overflow-y-auto">
        {fields.map((field) => (
          <button
            key={field.id}
            className="flex w-full items-center rounded px-2 py-1.5 text-left text-[13px] text-ink hover:bg-hover"
            onClick={() => onAdd(field)}
          >
            {field.displayName}
          </button>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function FilterChip({
  fields,
  members,
  condition,
  onChange,
  onRemove,
}: {
  fields: Field[];
  members: Array<{ id: string; name: string }>;
  condition: FilterCondition;
  onChange: (condition: FilterCondition) => void;
  onRemove: () => void;
}) {
  const field = fields.find((f) => f.apiName === condition.field);
  if (!field) return null;
  const ops = OPS_BY_TYPE[field.type] ?? [];
  const activeOp = ops.find((o) => o.op === condition.op) ?? ops[0]!;

  const optionSource: Array<{ id: string; label: string }> =
    field.type === 'user'
      ? members.map((m) => ({ id: m.id, label: m.name }))
      : (field.options ?? []).map((o) => ({ id: o.id, label: o.label }));

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

      {activeOp.input === 'text' && (
        <input
          className="w-24 bg-card text-ink outline-none"
          value={String(condition.value ?? '')}
          onChange={(e) => onChange({ ...condition, value: e.target.value })}
        />
      )}
      {activeOp.input === 'number' && (
        <input
          className="w-16 bg-card text-ink outline-none"
          inputMode="decimal"
          value={String(condition.value ?? '')}
          onChange={(e) => onChange({ ...condition, value: Number(e.target.value) })}
        />
      )}
      {activeOp.input === 'date' && (
        <input
          type="date"
          className="bg-card text-ink outline-none"
          value={String(condition.value ?? '')}
          onChange={(e) => onChange({ ...condition, value: e.target.value })}
        />
      )}
      {activeOp.input === 'relative' && (
        <select
          className="bg-card text-ink outline-none"
          value={String(condition.value ?? 'next_7_days')}
          onChange={(e) => onChange({ ...condition, value: e.target.value })}
        >
          {RELATIVE_RANGES.map((r) => (
            <option key={r} value={r}>
              {r.replaceAll('_', ' ')}
            </option>
          ))}
        </select>
      )}
      {activeOp.input === 'boolean' && (
        <select
          className="bg-card text-ink outline-none"
          value={String(condition.value ?? 'true')}
          onChange={(e) => onChange({ ...condition, value: e.target.value === 'true' })}
        >
          <option value="true">checked</option>
          <option value="false">unchecked</option>
        </select>
      )}
      {activeOp.input === 'options' && (
        <OptionMultiPick
          options={optionSource}
          selected={Array.isArray(condition.value) ? (condition.value as string[]) : []}
          onChange={(ids) => onChange({ ...condition, value: ids })}
        />
      )}

      <button onClick={onRemove} className="text-faint hover:text-error">
        <X className="h-3 w-3" />
      </button>
    </span>
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
