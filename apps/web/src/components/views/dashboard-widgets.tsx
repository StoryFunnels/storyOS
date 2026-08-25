'use client';

import { useEffect, useMemo } from 'react';
import { Filter as FilterIcon, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
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
import { useDatabase, useRecordsInfinite } from '../table-view/use-table-data';
import type { FilterGroup, FilterNode, ViewConfig } from './use-view-state';
import { andFilterNodes, queryBodyFromConfig } from './use-view-state';
import { FiltersSection } from './view-toolbar';
import { TILE_OPS, defaultBlockLabel, formatTileValue, opLabel } from './dashboard-tiles';
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
  /** #367 — this widget's own scope, ANDed with the view's filter. */
  filter?: FilterNode;
  /**
   * #367 — the database this widget measures. Omitted = the view's own database,
   * so every dashboard saved before this renders identically with no migration.
   */
  database_id?: string;
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
const GROUPABLE_TYPES = new Set(['select', 'workflow', 'multi_select', 'date', 'checkbox']);

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
 * inline config (source / filter / type / group-by / measure).
 *
 * #367 — this widget OWNS ITS QUERY, exactly as `TileValue` has since #304.
 * It used to receive `rows`, `fields` and `loading` from the page-level fetch,
 * which is precisely why every widget on a dashboard necessarily measured the
 * same database with the same scope. It now resolves its own source and fetches
 * through the SAME grant-scoped `/records/query` path, so operator semantics stay
 * on the SERVER and a widget can never read past the viewer's access.
 *
 * Two widgets with identical source and scope share one request — react-query
 * dedupes on the query key, so N widgets over M databases are M round trips.
 */
export function DashboardWidgetCard({
  ws,
  db,
  config,
  personalFilter,
  sourceOptions,
  members,
  widget,
  showConfig,
  onPatch,
  onRemove,
}: {
  ws: string;
  /** #306 — absent on a space-level dashboard; the widget must name its own. */
  db?: string;
  config: ViewConfig;
  /** #259 — narrows this view's results for the current viewer only. */
  personalFilter?: FilterNode;
  /** #304's space-scoped, editor-visible picker options, computed once by the view. */
  sourceOptions: ReadonlyArray<{ id: string; name: string }>;
  members: Array<{ id: string; name: string }>;
  widget: DashboardWidget;
  /**
   * #385 — whether to render the inline config.
   *
   * This was `readOnly`, which answers "can this person edit at all" — a
   * different question from "are they editing right now", and the component only
   * had the first. The caller now owns that distinction (`!readOnly && editing`),
   * so a viewer and an editor who is merely reading get the same clean card.
   */
  showConfig: boolean;
  onPatch: (patch: Partial<DashboardWidget>) => void;
  onRemove: () => void;
}) {
  /**
   * #367 — which database this widget measures. Falls back to the view's, which
   * is how every dashboard saved before this keeps working with no migration.
   */
  const sourceDb = widget.database_id ?? db;
  const crossDatabase = sourceDb !== db;
  /**
   * #306 — no view database AND no widget database. UNCONFIGURED, not broken
   * (#305's rule): the widget keeps its place and asks to be pointed somewhere,
   * and cleanViewConfig must never garbage-collect it.
   */
  const unconfigured = !sourceDb;

  /**
   * A CROSS-DATABASE widget must not inherit the view's scope — the same trap
   * #304 documented for tiles. The view's filter, sorts and the viewer's personal
   * override all name the VIEW database's fields by api_name. Applying them to
   * another database asks it about columns it does not have: at best an error, at
   * worst a silent mismatch where an api_name exists on both and means something
   * different. That second case is the dangerous one — a widget that looks
   * configured and charts the wrong thing.
   */
  const scoped = useMemo(
    () => (crossDatabase ? widget.filter : andFilterNodes(personalFilter, widget.filter)),
    [crossDatabase, personalFilter, widget.filter],
  );
  const queryBody = useMemo(
    () =>
      crossDatabase
        ? { filters: scoped as FilterNode | undefined }
        : queryBodyFromConfig(config, scoped as FilterNode | undefined),
    [crossDatabase, config, scoped],
  );

  // The SOURCE database's fields drive the group-by and measure pickers. Offering
  // the view database's fields for a cross-database widget is how you build a
  // picker that proposes columns the query cannot honour.
  const sourceDatabase = useDatabase(ws, sourceDb ?? '');
  const fields = useMemo(() => sourceDatabase.data?.fields ?? [], [sourceDatabase.data]);

  const records = useRecordsInfinite(ws, sourceDb ?? '', queryBody);
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = records;
  // Aggregate over the whole matching set, not just page 1.
  useEffect(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  const rows = useMemo(() => (records.data?.pages ?? []).flatMap((p) => p.data), [records.data]);
  const loading = !unconfigured && (records.isLoading || hasNextPage || isFetchingNextPage);
  const sourceName = (id: string) => sourceOptions.find((o) => o.id === id)?.name ?? 'the previous database';

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

  /**
   * #387 — a chart's default title has the same defect a tile's did: derived from
   * the measure alone, every count-by-state chart reads identically no matter
   * which database it measures. `title` also defaults to empty, so the fallback
   * was literally "Untitled widget".
   *
   * Uses the shared `defaultBlockLabel` so tiles and charts cannot drift into two
   * naming conventions — the field-surfaces rule (reuse, don't re-case) applies
   * to labels as much as to cells.
   */
  const sourceLabel = sourceDb ? sourceOptions.find((o) => o.id === sourceDb)?.name : undefined;
  const heading =
    widget.title.trim() ||
    defaultBlockLabel({
      sourceName: sourceLabel,
      op: widget.measure.op,
      fieldDisplayName: fields.find((f) => f.apiName === widget.measure.field_api_name)?.displayName,
      groupByDisplayName: groupField?.displayName,
    }) ||
    'Untitled widget';

  return (
    <div className="flex flex-col gap-3 rounded-[var(--radius-control)] border border-border-default bg-card p-4">
      <div className="flex items-start justify-between gap-2">
        <span className="text-[13px] font-medium text-muted">{heading}</span>
        {showConfig && (
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

      {/* #387 — same provenance line the tiles carry: which database, and whether
          this chart is filtered. Both were visible only while the editor was
          permanently open. */}
      {!showConfig && sourceLabel && (
        <span className="-mt-2 flex items-center gap-1 text-[11px] text-faint">
          <span className="truncate" title={sourceLabel}>{sourceLabel}</span>
          {widget.filter != null && (
            <span className="flex shrink-0 items-center gap-0.5" title="This chart has its own filter">
              <FilterIcon className="h-2.5 w-2.5" />
              filtered
            </span>
          )}
        </span>
      )}

      <div className="min-h-[220px]">
        <WidgetBody
          unconfigured={unconfigured}
          /**
           * #367 — the query is grant-scoped server-side, so a source the VIEWER
           * cannot read FAILS rather than returning rows. Rendering an empty
           * chart here would be a lie: "no access" and "nothing to chart" look
           * identical, and only one of them is true.
           */
          noAccess={records.isError}
          loading={loading}
          groupConfigured={!!groupField}
          series={series}
          type={widget.type}
        />
      </div>

      {showConfig && (
        <div className="flex flex-col gap-1.5 border-t border-border-default pt-2">
          <input
            aria-label="Widget title"
            placeholder={heading}
            value={widget.title}
            onChange={(e) => onPatch({ title: e.target.value })}
            className="h-8 rounded-[var(--radius-control)] border border-border-default bg-card px-2 text-[13px] text-ink placeholder:text-faint"
          />
          {/* #367 — what this widget measures. Scoped to the dashboard's own SPACE,
              for the same reason #304 scoped the tile picker: a picker wider than
              the access story is how the leak gets built. */}
          <select
            aria-label="Widget source database"
            value={widget.database_id ?? db ?? ''}
            onChange={(e) => {
              const picked = e.target.value;
              const next = picked === '' || picked === db ? undefined : picked;
              if ((widget.database_id ?? db ?? '') === (next ?? db ?? '')) return;
              /**
               * The filter AND the group-by reference the OLD database's fields
               * by api_name. Keeping either would query the new database with
               * columns it does not have — a widget that looks configured and
               * charts nothing, the exact failure #367 exists to end.
               *
               * The group-by is the worse of the two: a stale filter tends to
               * error, but a stale group-by silently collapses every record into
               * one meaningless bucket. Clearing them silently would lose the
               * user's work with no warning, so: clear, and say so.
               */
              const lost = [
                widget.filter != null ? 'filter' : null,
                widget.group_by_field_api_name != null ? 'group-by' : null,
                widget.measure.field_api_name != null ? 'measure field' : null,
              ].filter((x): x is string => x != null);
              onPatch({
                database_id: next,
                filter: undefined,
                group_by_field_api_name: undefined,
                measure: { op: widget.measure.op },
              });
              if (lost.length > 0) {
                // Agreement matters here because this message routinely names ONE
                // thing: "group-by cleared — they referred to…" is what the naive
                // version says. And the source is phrased as "fields on Clients"
                // rather than a possessive, which would render "Clients's fields"
                // for any database name ending in s.
                const what = lost.length === 1 ? lost[0]! : `${lost.slice(0, -1).join(', ')} and ${lost.at(-1)}`;
                const verb = lost.length === 1 ? 'it referred' : 'they referred';
                toast.info(
                  `${what.charAt(0).toUpperCase()}${what.slice(1)} cleared — ${verb} to fields on ${sourceName(widget.database_id ?? db ?? '')}.`,
                );
              }
            }}
            className={SELECT_CLASS}
          >
            {sourceOptions.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </select>
          {/* #367 — this widget's own scope, through the SAME builder the view
              toolbar and tiles use (one filter spec, one UI). Offered only for a
              widget on the view's OWN database: the builder needs that database's
              field list, and handing it the wrong one produces conditions the
              query cannot honour. Mirrors #304's tile restriction exactly. */}
          {db != null && (widget.database_id ?? db) === db && (
            <FiltersSection
              ws={ws}
              db={db}
              fields={fields}
              members={members}
              filters={widget.filter as FilterGroup | undefined}
              onChange={(filter) => onPatch({ filter: filter as FilterNode | undefined })}
            />
          )}
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
  unconfigured,
  noAccess,
  loading,
  groupConfigured,
  series,
  type,
}: {
  unconfigured: boolean;
  noAccess: boolean;
  loading: boolean;
  groupConfigured: boolean;
  series: SeriesPoint[];
  type: ChartWidgetType;
}) {
  // #306/#367 — asked for, not yet answered. Distinct from broken, and never
  // garbage-collected (#305).
  if (unconfigured) {
    return <CenterNote>Pick a database.</CenterNote>;
  }
  if (loading) {
    return <CenterNote>Loading…</CenterNote>;
  }
  // #367 — checked BEFORE the empty-series branch on purpose. A forbidden source
  // and an empty one both produce zero rows; falling through to "No data to
  // chart yet" would report a permissions failure as a fact about the data.
  if (noAccess) {
    return <CenterNote>You don&apos;t have access to this widget&apos;s database.</CenterNote>;
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
