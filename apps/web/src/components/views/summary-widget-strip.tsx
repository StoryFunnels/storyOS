'use client';

import { useState } from 'react';
import { useQueries } from '@tanstack/react-query';
import {
  BarChart3,
  ChevronDown,
  Copy,
  GripVertical,
  X,
} from 'lucide-react';
import { Bar, BarChart, Cell, Line, LineChart, Pie, PieChart, ResponsiveContainer, Tooltip } from 'recharts';
import { DndContext, PointerSensor, closestCenter, useSensor, useSensors } from '@dnd-kit/core';
import type { DragEndEvent } from '@dnd-kit/core';
import { SortableContext, arrayMove, horizontalListSortingStrategy, useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import type { Field } from '../table-view/use-table-data';
import { TILE_OPS, formatTileValue, opLabel, opNeedsField } from './dashboard-tiles';
import type { TileOp } from './dashboard-tiles';
import { andFilterNodes } from './filter-config';
import type { FilterNode } from './filter-config';
import type { ViewConfig } from './use-view-state';

export type SummaryWidget = NonNullable<ViewConfig['summary_widgets']>[number];

const WIDGET_TYPE_LABEL: Record<SummaryWidget['type'], string> = {
  stat: 'Number',
  bar: 'Bar chart',
  line: 'Line chart',
  pie: 'Pie chart',
};

const CHART_COLORS = [
  'var(--chart-1)',
  'var(--chart-2)',
  'var(--chart-3)',
  'var(--chart-4)',
  'var(--chart-5)',
  'var(--chart-6)',
  'var(--chart-7)',
  'var(--chart-8)',
] as const;
const colorFor = (i: number) => CHART_COLORS[i % CHART_COLORS.length]!;

/**
 * #228 v1 — group-by is restricted to fields whose bucket set is small and
 * KNOWN UP FRONT (a select/workflow's options; checkbox's two values), so
 * every bucket's count is one `/records/aggregate` call rather than fetching
 * every row client-side to group it there. `multi_select` (one record can
 * land in several buckets — a real question about double-counting, not
 * answered here) and `date` (needs a bucketing rule: day? month? quarter?)
 * are genuine features and bigger ones; deferred, per the schema's own
 * comment, not silently unsupported.
 */
const GROUPABLE_TYPES = new Set(['select', 'workflow', 'checkbox']);

async function fetchAggregate(
  ws: string,
  db: string,
  op: TileOp,
  field: string | undefined,
  filter: unknown,
): Promise<number | null> {
  const { data, error } = await api.POST('/api/v1/workspaces/{ws}/databases/{db}/records/aggregate', {
    params: { path: { ws, db } },
    body: { op, ...(field ? { field } : {}), ...(filter ? { filter } : {}) } as never,
  } as never);
  if (error) return null;
  return (data as unknown as { value: number | null }).value;
}

/** One aggregate call per bucket — the view's own active filter ANDed with a
 * condition selecting just that bucket's records. */
function bucketsFor(field: Field | undefined): Array<{ label: string; condition: FilterNode }> {
  if (!field) return [];
  if (field.type === 'checkbox') {
    return [
      { label: 'Checked', condition: { field: field.apiName, op: 'eq', value: true } },
      { label: 'Unchecked', condition: { field: field.apiName, op: 'eq', value: false } },
    ];
  }
  return (field.options ?? []).map((o) => ({
    label: o.label,
    condition: { field: field.apiName, op: 'has', value: [o.id] },
  }));
}

function useWidgetValue(
  ws: string,
  db: string,
  widget: SummaryWidget,
  viewFilter: unknown,
  fields: Field[],
): { loading: boolean; stat: number | null; series: Array<{ label: string; value: number }> } {
  const groupField = fields.find((f) => f.apiName === widget.group_by_field_api_name);
  const buckets = widget.type === 'stat' ? [] : bucketsFor(groupField);

  const statQuery = {
    queryKey: ['summary-widget-stat', ws, db, widget.op, widget.field_api_name, viewFilter],
    queryFn: () => fetchAggregate(ws, db, widget.op, widget.field_api_name, viewFilter),
    enabled: widget.type === 'stat',
  };
  const bucketQueries = buckets.map((b) => ({
    queryKey: ['summary-widget-bucket', ws, db, widget.op, widget.field_api_name, b.label, viewFilter],
    queryFn: () => fetchAggregate(ws, db, widget.op, widget.field_api_name, andFilterNodes(viewFilter, b.condition)),
    enabled: widget.type !== 'stat',
  }));

  const results = useQueries({ queries: widget.type === 'stat' ? [statQuery] : bucketQueries });

  if (widget.type === 'stat') {
    return { loading: results[0]?.isLoading ?? false, stat: results[0]?.data ?? null, series: [] };
  }
  const series = buckets.map((b, i) => ({ label: b.label, value: results[i]?.data ?? 0 }));
  return { loading: results.some((r) => r.isLoading), stat: null, series };
}

function WidgetChart({ type, series }: { type: 'bar' | 'line' | 'pie'; series: Array<{ label: string; value: number }> }) {
  if (type === 'pie') {
    return (
      <ResponsiveContainer width="100%" height={80}>
        <PieChart>
          <Pie data={series} dataKey="value" nameKey="label" innerRadius={18} outerRadius={34}>
            {series.map((_, i) => (
              <Cell key={i} fill={colorFor(i)} />
            ))}
          </Pie>
          <Tooltip />
        </PieChart>
      </ResponsiveContainer>
    );
  }
  const Chart = type === 'bar' ? BarChart : LineChart;
  return (
    <ResponsiveContainer width="100%" height={80}>
      <Chart data={series}>
        <Tooltip />
        {type === 'bar' ? (
          <Bar dataKey="value" radius={[3, 3, 0, 0]}>
            {series.map((_, i) => (
              <Cell key={i} fill={colorFor(i)} />
            ))}
          </Bar>
        ) : (
          <Line type="monotone" dataKey="value" stroke={colorFor(0)} strokeWidth={2} dot={false} />
        )}
      </Chart>
    </ResponsiveContainer>
  );
}

function WidgetCard({
  widget,
  ws,
  db,
  fields,
  viewFilter,
  readOnly,
  onPatch,
  onRemove,
  onDuplicate,
  autoOpen,
}: {
  widget: SummaryWidget;
  ws: string;
  db: string;
  fields: Field[];
  viewFilter: unknown;
  readOnly: boolean;
  onPatch: (patch: Partial<SummaryWidget>) => void;
  onRemove: () => void;
  onDuplicate: () => void;
  /** A freshly duplicated card opens its config immediately — changing the
   *  grouping is the whole point of the gesture (#696). */
  autoOpen?: boolean;
}) {
  const [editing, setEditing] = useState(!!autoOpen);
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({ id: widget.id });
  const { loading, stat, series } = useWidgetValue(ws, db, widget, viewFilter, fields);
  const numberFields = fields.filter((f) => f.type === 'number');
  const groupableFields = fields.filter((f) => GROUPABLE_TYPES.has(f.type));
  const fieldLabel = fields.find((f) => f.apiName === widget.field_api_name)?.displayName;
  const groupLabel = fields.find((f) => f.apiName === widget.group_by_field_api_name)?.displayName;
  const title =
    widget.title ||
    (widget.type === 'stat'
      ? widget.op === 'count'
        ? 'Count'
        : `${opLabel(widget.op)} of ${fieldLabel ?? '…'}`
      : `${opLabel(widget.op)} by ${groupLabel ?? '…'}`);

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      /* #696 — `max-w-72` is load-bearing. Without a cap, `flex-1` makes a card's
         width a function of how many SIBLINGS it has: measured at a 1440px
         viewport, one widget stretched to 1068px, two to 530, three to 351, and
         only at four (261px) did it look deliberate. The content cannot use that
         space — a stat is a 24px number and a chart is a donut pinned at
         outerRadius 34 — so one widget showed a 68px circle in a 1068px card.
         Capping makes width follow content instead of neighbour count, and the
         n=1 case falls out correctly rather than being special-cased. Cards still
         shrink past the cap and wrap when crowded, keeping the min-w-40 floor. */
      className="flex min-w-40 max-w-72 flex-1 flex-col gap-1 rounded-[var(--radius-card)] border border-border-default bg-card p-3"
    >
      <div className="flex items-center justify-between gap-1">
        <span className="flex min-w-0 items-center gap-1">
          {!readOnly && (
            <button
              {...attributes}
              {...listeners}
              className="cursor-grab text-faint hover:text-muted"
              title="Drag to reorder"
            >
              <GripVertical className="h-3.5 w-3.5" />
            </button>
          )}
          <span className="truncate text-[12px] font-medium text-muted">{title}</span>
        </span>
        {!readOnly && (
          <span className="flex shrink-0 items-center gap-0.5">
            <button
              type="button"
              onClick={() => setEditing((v) => !v)}
              className="rounded p-0.5 text-faint hover:bg-hover hover:text-ink"
              title="Configure"
            >
              <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', editing && 'rotate-180')} />
            </button>
            <button
              type="button"
              onClick={onDuplicate}
              className="rounded p-0.5 text-faint hover:bg-hover hover:text-ink"
              title="Duplicate widget"
            >
              <Copy className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={onRemove}
              className="rounded p-0.5 text-faint hover:bg-hover hover:text-error"
              title="Remove widget"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </span>
        )}
      </div>

      {widget.type === 'stat' ? (
        <span className="text-2xl font-semibold text-ink">{loading ? '…' : formatTileValue(stat)}</span>
      ) : (
        <WidgetChart type={widget.type} series={series} />
      )}

      {editing && (
        <div className="mt-1 flex flex-col gap-1.5 border-t border-border-default pt-2">
          <label className="flex items-center justify-between gap-2 text-[12px] text-muted">
            Type
            <select
              className="h-7 rounded border border-border-default bg-card px-1.5 text-[12px] text-ink"
              value={widget.type}
              onChange={(e) => {
                const type = e.target.value as SummaryWidget['type'];
                onPatch(
                  type === 'stat'
                    ? { type, group_by_field_api_name: undefined }
                    : { type, group_by_field_api_name: widget.group_by_field_api_name ?? groupableFields[0]?.apiName },
                );
              }}
            >
              {(Object.keys(WIDGET_TYPE_LABEL) as Array<SummaryWidget['type']>).map((t) => (
                <option key={t} value={t}>
                  {WIDGET_TYPE_LABEL[t]}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center justify-between gap-2 text-[12px] text-muted">
            Aggregate
            <select
              className="h-7 rounded border border-border-default bg-card px-1.5 text-[12px] text-ink"
              value={widget.op}
              onChange={(e) => {
                const op = e.target.value as TileOp;
                onPatch({ op, field_api_name: opNeedsField(op) ? widget.field_api_name ?? numberFields[0]?.apiName : undefined });
              }}
            >
              {TILE_OPS.map((op) => (
                <option key={op} value={op}>
                  {opLabel(op)}
                </option>
              ))}
            </select>
          </label>
          {opNeedsField(widget.op) && (
            <label className="flex items-center justify-between gap-2 text-[12px] text-muted">
              Field
              <select
                className="h-7 rounded border border-border-default bg-card px-1.5 text-[12px] text-ink"
                value={widget.field_api_name ?? ''}
                onChange={(e) => onPatch({ field_api_name: e.target.value || undefined })}
              >
                <option value="">pick…</option>
                {numberFields.map((f) => (
                  <option key={f.id} value={f.apiName}>
                    {f.displayName}
                  </option>
                ))}
              </select>
            </label>
          )}
          {widget.type !== 'stat' && (
            <label className="flex items-center justify-between gap-2 text-[12px] text-muted">
              Group by
              <select
                className="h-7 rounded border border-border-default bg-card px-1.5 text-[12px] text-ink"
                value={widget.group_by_field_api_name ?? ''}
                onChange={(e) => onPatch({ group_by_field_api_name: e.target.value || undefined })}
              >
                <option value="">pick…</option>
                {groupableFields.map((f) => (
                  <option key={f.id} value={f.apiName}>
                    {f.displayName}
                  </option>
                ))}
              </select>
            </label>
          )}
          <input
            className="h-7 rounded border border-border-default bg-card px-1.5 text-[12px] text-ink placeholder:text-muted"
            placeholder={title}
            value={widget.title}
            onChange={(e) => onPatch({ title: e.target.value })}
          />
        </div>
      )}
    </div>
  );
}

/**
 * #228 — a small strip of stat/chart cards above an ordinary view's records,
 * summarising THIS view's own filtered rows (its `filters` + the viewer's
 * `personalFilter`, ANDed — exactly what's visible in the grid beneath it,
 * never anything wider). Config lives on `ViewConfig.summary_widgets`, so it
 * persists with the view like every other view setting.
 */
export function SummaryWidgetStrip({
  ws,
  db,
  fields,
  config,
  activeFilter,
  readOnly,
  onPatch,
}: {
  ws: string;
  db: string;
  fields: Field[];
  config: ViewConfig;
  /** The view's own active filter, ANDed with the viewer's personal filter —
   * the exact scope the records grid itself queries with. */
  activeFilter: unknown;
  readOnly: boolean;
  onPatch: (patch: Partial<ViewConfig>) => void;
}) {
  const widgets = config.summary_widgets ?? [];
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
  /* Declared above the early return below — hooks cannot sit behind a branch. */
  const [justDuplicated, setJustDuplicated] = useState<string | null>(null);

  /* #698 — no widgets, no strip. It used to render a full-width row carrying
     nothing but its own add button plus a border-b, costing ~40px above the grid
     on every table/board/gallery/list view whether or not anyone used the
     feature. The add control now lives in the toolbar row (see
     AddSummaryWidgetButton below), so there is nothing left to render here. */
  if (widgets.length === 0) return null;

  function setWidgets(next: SummaryWidget[]) {
    onPatch({ summary_widgets: next });
  }

  /** #696 — insert the copy directly AFTER its original, not at the end, so the
   *  two groupings sit side by side to be compared. A fresh id is required:
   *  SortableContext keys on widget.id, so a duplicate id breaks drag-reorder. */
  function duplicateWidget(widget: SummaryWidget) {
    const id = crypto.randomUUID();
    const i = widgets.findIndex((w) => w.id === widget.id);
    setWidgets([...widgets.slice(0, i + 1), { ...widget, id }, ...widgets.slice(i + 1)]);
    setJustDuplicated(id);
  }

  function onDragEnd(e: DragEndEvent) {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const from = widgets.findIndex((w) => w.id === active.id);
    const to = widgets.findIndex((w) => w.id === over.id);
    if (from === -1 || to === -1) return;
    setWidgets(arrayMove(widgets, from, to));
  }

  return (
    <div className="flex shrink-0 flex-wrap items-stretch gap-2 border-b border-border-default px-3 py-2">
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={widgets.map((w) => w.id)} strategy={horizontalListSortingStrategy}>
          {widgets.map((widget) => (
            <WidgetCard
              key={widget.id}
              widget={widget}
              ws={ws}
              db={db}
              fields={fields}
              viewFilter={activeFilter}
              readOnly={readOnly}
              onPatch={(patch) => setWidgets(widgets.map((w) => (w.id === widget.id ? { ...w, ...patch } : w)))}
              onRemove={() => setWidgets(widgets.filter((w) => w.id !== widget.id))}
              onDuplicate={() => duplicateWidget(widget)}
              autoOpen={widget.id === justDuplicated}
            />
          ))}
        </SortableContext>
      </DndContext>
    </div>
  );
}

/**
 * The "add a summary widget" control, rendered by the VIEW TOOLBAR rather than
 * by the strip (#698).
 *
 * Styled to match the toolbar's own controls — Filter, Sort, Hide fields, CSV —
 * not the strip's chip. A control that moves into a row should look like the row
 * it moved into; carrying its old styling across is how a toolbar ends up with
 * five different button treatments.
 *
 * No `ml-auto`: that belongs to ExportCsvButton, which is deliberately pushed to
 * the right edge. This joins the left group.
 */
export function AddSummaryWidgetButton({
  config,
  onPatch,
}: {
  config: ViewConfig;
  onPatch: (patch: Partial<ViewConfig>) => void;
}) {
  return (
    <button
      type="button"
      onClick={() =>
        onPatch({
          summary_widgets: [
            ...(config.summary_widgets ?? []),
            { id: crypto.randomUUID(), type: 'stat', title: '', op: 'count' },
          ],
        })
      }
      className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[12px] text-muted hover:bg-hover hover:text-ink"
      title="Add a summary widget over this view's rows"
    >
      <BarChart3 className="h-3.5 w-3.5" /> Add widget
    </button>
  );
}
