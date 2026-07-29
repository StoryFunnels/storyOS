'use client';

import { useMemo } from 'react';
import { Trash2 } from 'lucide-react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { Field } from '../table-view/use-table-data';
import { TILE_OPS, formatTileValue, opLabel } from './dashboard-tiles';
import type { TileOp } from './dashboard-tiles';
import {
  CHART_WIDGET_TYPES,
  computeChartSeries,
  measureNeedsField,
  type ChartWidgetType,
  type SeriesPoint,
} from './dashboard-charts';

/** One chart / grouped-table widget in a dashboard config (mirrors dashboardWidgetSchema). */
export interface DashboardWidget {
  id: string;
  type: ChartWidgetType;
  title: string;
  group_by_field_api_name?: string;
  measure: { op: TileOp; field_api_name?: string };
}

/**
 * Categorical palette for chart series. Values are CSS-variable references
 * (defined for both light and dark in globals.css) so a bar/slice recolors with
 * the theme — never a hardcoded hex that would break dark mode. SVG fill/stroke
 * resolve `var(--chart-N)` at paint time.
 */
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

function colorFor(i: number): string {
  return CHART_COLORS[i % CHART_COLORS.length]!;
}

const SELECT_CLASS =
  'h-8 rounded-[var(--radius-control)] border border-border-default bg-card px-2 text-[13px] text-ink';

/** Field types a widget can group records by (categorical / date). */
const GROUPABLE_TYPES = new Set(['select', 'multi_select', 'date', 'checkbox']);

const WIDGET_TYPE_LABEL: Record<ChartWidgetType, string> = {
  bar: 'Bar chart',
  line: 'Line chart',
  pie: 'Pie chart',
  grouped_table: 'Grouped table',
};

/** Theme-aware inline style for Recharts' floating tooltip (it uses inline styles). */
const TOOLTIP_STYLE: React.CSSProperties = {
  background: 'var(--bg-card)',
  border: '1px solid var(--border-default)',
  borderRadius: 'var(--radius-control)',
  color: 'var(--text-primary)',
  fontSize: 12,
};

function TooltipContent({
  active,
  payload,
}: {
  active?: boolean;
  payload?: Array<{ payload: SeriesPoint }>;
}) {
  if (!active || !payload?.length) return null;
  const point = payload[0]!.payload;
  return (
    <div style={{ ...TOOLTIP_STYLE, padding: '6px 8px' }}>
      <div className="font-medium">{point.label}</div>
      <div className="text-muted">{formatTileValue(point.value)}</div>
    </div>
  );
}

/**
 * A single dashboard chart / grouped-table widget: renders the computed series
 * (bar/line/pie via Recharts, or a grouped table) plus, unless read-only, the
 * inline config (type / group-by / measure) matching the tile config UX.
 *
 * `rows` are the SAME grant-scoped, view-filtered records the tiles aggregate;
 * the widget computes its grouped series client-side (pure functions in
 * dashboard-charts.ts). Loading and empty states are handled here.
 */
export function DashboardWidgetCard({
  widget,
  rows,
  fields,
  loading,
  readOnly,
  onPatch,
  onRemove,
}: {
  widget: DashboardWidget;
  rows: ReadonlyArray<{ values: Record<string, unknown> }>;
  fields: Field[];
  loading: boolean;
  readOnly: boolean;
  onPatch: (patch: Partial<DashboardWidget>) => void;
  onRemove: () => void;
}) {
  const groupableFields = useMemo(
    () => fields.filter((f) => GROUPABLE_TYPES.has(f.type)),
    [fields],
  );
  const numberFields = useMemo(() => fields.filter((f) => f.type === 'number'), [fields]);

  const groupField = useMemo(
    () => fields.find((f) => f.apiName === widget.group_by_field_api_name),
    [fields, widget.group_by_field_api_name],
  );

  // Resolve raw group keys to human labels: select/multi_select values are
  // option ids → option labels; checkbox true/false → Yes/No; otherwise the key.
  const labelFor = useMemo(() => {
    const optionLabel = new Map((groupField?.options ?? []).map((o) => [o.id, o.label]));
    return (key: string): string => {
      if (groupField?.type === 'checkbox') return key === 'true' ? 'Yes' : 'No';
      return optionLabel.get(key) ?? key;
    };
  }, [groupField]);

  const series = useMemo<SeriesPoint[]>(() => {
    if (loading || !groupField) return [];
    return computeChartSeries(
      rows,
      widget.group_by_field_api_name,
      groupField.type,
      widget.measure,
      labelFor,
    );
  }, [loading, groupField, rows, widget.group_by_field_api_name, widget.measure, labelFor]);

  const measureLabel =
    widget.measure.op === 'count'
      ? 'Count'
      : `${opLabel(widget.measure.op)} of ${
          fields.find((f) => f.apiName === widget.measure.field_api_name)?.displayName ?? 'field'
        }`;
  const heading =
    widget.title.trim() ||
    (groupField ? `${measureLabel} by ${groupField.displayName}` : 'Untitled widget');

  return (
    <div className="flex flex-col gap-3 rounded-[var(--radius-control)] border border-border-default bg-card p-4">
      <div className="flex items-start justify-between gap-2">
        <span className="text-[13px] font-medium text-muted">{heading}</span>
        {!readOnly && (
          <button
            type="button"
            title="Remove widget"
            onClick={onRemove}
            className="shrink-0 rounded p-0.5 text-faint hover:bg-hover hover:text-danger"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      <div className="min-h-[220px]">
        <WidgetBody loading={loading} groupConfigured={!!groupField} series={series} type={widget.type} />
      </div>

      {!readOnly && (
        <div className="flex flex-col gap-1.5 border-t border-border-default pt-2">
          <input
            aria-label="Widget title"
            placeholder={heading}
            value={widget.title}
            onChange={(e) => onPatch({ title: e.target.value })}
            className="h-8 rounded-[var(--radius-control)] border border-border-default bg-card px-2 text-[13px] text-ink placeholder:text-faint"
          />
          <div className="flex flex-wrap gap-1.5">
            <select
              aria-label="Widget type"
              value={widget.type}
              onChange={(e) => onPatch({ type: e.target.value as ChartWidgetType })}
              className={SELECT_CLASS}
            >
              {CHART_WIDGET_TYPES.map((t) => (
                <option key={t} value={t}>
                  {WIDGET_TYPE_LABEL[t]}
                </option>
              ))}
            </select>
            <select
              aria-label="Group by field"
              value={widget.group_by_field_api_name ?? ''}
              onChange={(e) => onPatch({ group_by_field_api_name: e.target.value || undefined })}
              className={`${SELECT_CLASS} min-w-0 flex-1`}
            >
              <option value="">Group by…</option>
              {groupableFields.map((f) => (
                <option key={f.id} value={f.apiName}>
                  {f.displayName}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-wrap gap-1.5">
            <select
              aria-label="Measure"
              value={widget.measure.op}
              onChange={(e) => {
                const op = e.target.value as TileOp;
                const field_api_name = measureNeedsField(op)
                  ? widget.measure.field_api_name ?? numberFields[0]?.apiName
                  : undefined;
                onPatch({ measure: { op, field_api_name } });
              }}
              className={SELECT_CLASS}
            >
              {TILE_OPS.map((op) => (
                <option key={op} value={op}>
                  {opLabel(op)}
                </option>
              ))}
            </select>
            {measureNeedsField(widget.measure.op) && (
              <select
                aria-label="Measure field"
                value={widget.measure.field_api_name ?? ''}
                onChange={(e) =>
                  onPatch({
                    measure: { op: widget.measure.op, field_api_name: e.target.value || undefined },
                  })
                }
                className={`${SELECT_CLASS} min-w-0 flex-1`}
              >
                <option value="">Select a number field…</option>
                {numberFields.map((f) => (
                  <option key={f.id} value={f.apiName}>
                    {f.displayName}
                  </option>
                ))}
              </select>
            )}
          </div>
          {groupableFields.length === 0 && (
            <span className="text-[11px] text-faint">
              This database has no select, date, or checkbox fields to group by.
            </span>
          )}
        </div>
      )}
    </div>
  );
}

function WidgetBody({
  loading,
  groupConfigured,
  series,
  type,
}: {
  loading: boolean;
  groupConfigured: boolean;
  series: SeriesPoint[];
  type: ChartWidgetType;
}) {
  if (loading) {
    return <CenterNote>Loading…</CenterNote>;
  }
  if (!groupConfigured) {
    return <CenterNote>Pick a field to group by.</CenterNote>;
  }
  if (series.length === 0) {
    return <CenterNote>No data to chart yet.</CenterNote>;
  }
  if (type === 'grouped_table') return <GroupedTable series={series} />;
  if (type === 'pie') return <PieWidget series={series} />;
  if (type === 'line') return <LineWidget series={series} />;
  return <BarWidget series={series} />;
}

function CenterNote({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-[220px] items-center justify-center text-[13px] text-faint">{children}</div>
  );
}

/** Numeric value for a chart mark — nulls (empty aggregate) plot as 0. */
function plotValue(p: SeriesPoint): number {
  return p.value ?? 0;
}

const AXIS_TICK = { fill: 'var(--text-muted)', fontSize: 11 } as const;

function BarWidget({ series }: { series: SeriesPoint[] }) {
  return (
    <ResponsiveContainer width="100%" height={220}>
      <BarChart data={series} margin={{ top: 8, right: 8, bottom: 8, left: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--border-default)" vertical={false} />
        <XAxis dataKey="label" tick={AXIS_TICK} stroke="var(--border-strong)" interval={0} />
        <YAxis tick={AXIS_TICK} stroke="var(--border-strong)" allowDecimals width={44} />
        <Tooltip cursor={{ fill: 'var(--bg-hover)' }} content={<TooltipContent />} />
        <Bar dataKey={plotValue} radius={[3, 3, 0, 0]} isAnimationActive={false}>
          {series.map((p, i) => (
            <Cell key={p.key ?? `empty-${i}`} fill={colorFor(i)} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

function LineWidget({ series }: { series: SeriesPoint[] }) {
  return (
    <ResponsiveContainer width="100%" height={220}>
      <LineChart data={series} margin={{ top: 8, right: 8, bottom: 8, left: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--border-default)" vertical={false} />
        <XAxis dataKey="label" tick={AXIS_TICK} stroke="var(--border-strong)" interval={0} />
        <YAxis tick={AXIS_TICK} stroke="var(--border-strong)" allowDecimals width={44} />
        <Tooltip cursor={{ stroke: 'var(--border-strong)' }} content={<TooltipContent />} />
        <Line
          type="monotone"
          dataKey={plotValue}
          stroke="var(--chart-1)"
          strokeWidth={2}
          dot={{ fill: 'var(--chart-1)', r: 3 }}
          isAnimationActive={false}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}

function PieWidget({ series }: { series: SeriesPoint[] }) {
  return (
    <ResponsiveContainer width="100%" height={220}>
      <PieChart>
        <Tooltip content={<TooltipContent />} />
        <Pie
          data={series}
          dataKey={plotValue}
          nameKey="label"
          cx="50%"
          cy="50%"
          outerRadius={80}
          innerRadius={44}
          stroke="var(--bg-card)"
          strokeWidth={2}
          isAnimationActive={false}
        >
          {series.map((p, i) => (
            <Cell key={p.key ?? `empty-${i}`} fill={colorFor(i)} />
          ))}
        </Pie>
      </PieChart>
    </ResponsiveContainer>
  );
}

function GroupedTable({ series }: { series: SeriesPoint[] }) {
  return (
    <div className="overflow-auto">
      <table className="w-full text-[13px]">
        <thead>
          <tr className="border-b border-border-default text-left text-muted">
            <th className="py-1.5 pr-2 font-medium">Group</th>
            <th className="py-1.5 pl-2 text-right font-medium">Value</th>
          </tr>
        </thead>
        <tbody>
          {series.map((p, i) => (
            <tr key={p.key ?? `empty-${i}`} className="border-b border-border-default last:border-0">
              <td className="flex items-center gap-2 py-1.5 pr-2 text-ink">
                <span
                  className="inline-block h-2.5 w-2.5 shrink-0 rounded-[2px]"
                  style={{ background: colorFor(i) }}
                />
                <span className="truncate">{p.label}</span>
              </td>
              <td className="py-1.5 pl-2 text-right tabular-nums text-ink">
                {formatTileValue(p.value)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
