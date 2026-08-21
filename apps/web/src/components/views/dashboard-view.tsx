'use client';

import { useEffect, useMemo } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { useDatabase, useMembers, useRecordsInfinite } from '../table-view/use-table-data';
import { useDatabases } from '@/lib/queries';
import { toast } from 'sonner';
import type { FilterNode, ViewConfig, FilterGroup } from './use-view-state';
import { andFilterNodes, queryBodyFromConfig } from './use-view-state';
import { FiltersSection } from './view-toolbar';
import {
  TILE_OPS,
  computeTileValue,
  defaultTileLabel,
  formatTileValue,
  opLabel,
  opNeedsField,
} from './dashboard-tiles';
import type { TileOp } from './dashboard-tiles';
import { DashboardWidgetCard } from './dashboard-widgets';
import type { DashboardWidget } from './dashboard-widgets';

/** One metric tile in a dashboard view's config (mirrors dashboardTileSchema). */
export interface DashboardTile {
  id: string;
  label: string;
  op: TileOp;
  field_api_name?: string;
  /** #304 — this tile's own scope, ANDed with the view's filter. */
  filter?: FilterNode;
  /**
   * #304 — the database this tile measures. Omitted = the view's own database,
   * so every dashboard saved before this renders identically with no migration.
   */
  database_id?: string;
}

const SELECT_CLASS =
  'h-8 rounded-[var(--radius-control)] border border-border-default bg-card px-2 text-[13px] text-ink';

/**
 * Dashboard view (MN-225 / #168, Phase 1) — a grid of KPI / metric tiles, each
 * an aggregate (count/sum/avg/min/max) over the database's records. Records are
 * fetched through the SAME grant-scoped `/records/query` path every other view
 * uses (via `queryBodyFromConfig`), so a tile only ever aggregates records the
 * viewer can access, and the view's own filter scopes every tile. All pages are
 * pulled so the aggregate is correct over the full (filtered) dataset — a
 * server-side `/records/aggregate` endpoint is the Phase 2 optimization.
 *
 * Phase 1 is metric tiles only. Charts, cross-database tiles, per-tile filters,
 * and drag-to-arrange layout are deferred to later phases.
 */
export function DashboardView({
  ws,
  db,
  config,
  readOnly,
  personalFilter,
  onPatch,
}: {
  ws: string;
  db: string;
  config: ViewConfig;
  readOnly: boolean;
  /** #259 — narrows this view's results for the current viewer only. */
  personalFilter?: FilterNode;
  onPatch: (updates: Partial<ViewConfig>) => void;
}) {
  const database = useDatabase(ws, db);
  // #304 — the tile filter builder needs the roster for person-field conditions.
  const members = useMembers(ws, !readOnly);
  const memberList = useMemo(
    () => (members.data ?? []).map((m) => ({ id: m.user.id, name: m.user.name })),
    [members.data],
  );
  const queryBody = useMemo(() => queryBodyFromConfig(config, personalFilter), [config, personalFilter]);
  const records = useRecordsInfinite(ws, db, queryBody);

  // Aggregate over the whole (filtered) dataset, not just the first page —
  // keep paging until exhausted so count/sum/… are correct. #records is
  // grant-scoped server-side, so this never over-reads past the viewer's access.
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = records;
  useEffect(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  const rows = useMemo(() => (records.data?.pages ?? []).flatMap((p) => p.data), [records.data]);
  const loading = records.isLoading || hasNextPage || isFetchingNextPage;

  const tiles = (config.dashboard_tiles ?? []) as DashboardTile[];
  const fields = database.data?.fields ?? [];
  // Phase 1: numeric ops target plain number fields (formula/rollup targets later).
  const numberFields = useMemo(() => fields.filter((f) => f.type === 'number'), [fields]);

  /**
   * #304 — databases a tile may point at: the ones in THIS dashboard's space that
   * the EDITOR can see. `useDatabases` is already grant-scoped, so an editor is
   * never offered a source they cannot read — the picker cannot be the thing that
   * builds a leak. Space-scoped in v1 for the same reason #306 defers
   * workspace-root dashboards.
   */
  const allDatabases = useDatabases(ws).data ?? [];
  const sourceOptions = useMemo(() => {
    const spaceId = allDatabases.find((d) => d.id === db)?.spaceId;
    const inSpace = spaceId ? allDatabases.filter((d) => d.spaceId === spaceId) : allDatabases;
    // The view's own database first and always present, even if the list is
    // still loading — a picker whose current value is missing renders blank and
    // looks like the tile lost its source.
    const rest = inSpace.filter((d) => d.id !== db);
    return [{ id: db, name: database.data?.name ?? 'This database' }, ...rest.map((d) => ({ id: d.id, name: d.name }))];
  }, [allDatabases, db, database.data?.name]);
  const sourceName = (id: string) => sourceOptions.find((o) => o.id === id)?.name ?? 'the previous database';
  const fieldName = useMemo(() => new Map(fields.map((f) => [f.apiName, f.displayName])), [fields]);

  function patchTiles(next: DashboardTile[]) {
    onPatch({ dashboard_tiles: next });
  }
  function addTile() {
    patchTiles([
      ...tiles,
      { id: crypto.randomUUID(), label: '', op: 'count' },
    ]);
  }
  function updateTile(id: string, patch: Partial<DashboardTile>) {
    patchTiles(tiles.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  }
  function removeTile(id: string) {
    patchTiles(tiles.filter((t) => t.id !== id));
  }

  const widgets = (config.dashboard_widgets ?? []) as DashboardWidget[];
  function patchWidgets(next: DashboardWidget[]) {
    onPatch({ dashboard_widgets: next });
  }
  function addWidget() {
    patchWidgets([
      ...widgets,
      { id: crypto.randomUUID(), type: 'bar', title: '', measure: { op: 'count' } },
    ]);
  }
  function updateWidget(id: string, patch: Partial<DashboardWidget>) {
    patchWidgets(widgets.map((w) => (w.id === id ? { ...w, ...patch } : w)));
  }
  function removeWidget(id: string) {
    patchWidgets(widgets.filter((w) => w.id !== id));
  }

  return (
    <div className="h-full overflow-auto p-4">
      {tiles.length === 0 && widgets.length === 0 && (
        <div className="flex flex-col items-center justify-center gap-2 py-16 text-center">
          <p className="text-sm text-muted">Nothing on this dashboard yet.</p>
          {!readOnly && (
            <p className="text-[13px] text-faint">
              Add a metric tile (count, sum, average) or a chart grouped by a field.
            </p>
          )}
        </div>
      )}

      <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))' }}>
        {tiles.map((tile) => {
          const heading = tile.label.trim() || defaultTileLabel(tile.op, fieldName.get(tile.field_api_name ?? ''));
          return (
            <div
              key={tile.id}
              className="flex flex-col gap-3 rounded-[var(--radius-control)] border border-border-default bg-card p-4"
            >
              <div className="flex items-start justify-between gap-2">
                <span className="text-[13px] font-medium text-muted">{heading}</span>
                {!readOnly && (
                  <button
                    type="button"
                    title="Remove tile"
                    onClick={() => removeTile(tile.id)}
                    className="shrink-0 rounded p-0.5 text-faint hover:bg-hover hover:text-danger"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
              <span className="text-3xl font-semibold tabular-nums text-ink">
                <TileValue ws={ws} db={db} config={config} personalFilter={personalFilter} tile={tile} />
              </span>

              {!readOnly && (
                <div className="flex flex-col gap-1.5 border-t border-border-default pt-2">
                  <input
                    aria-label="Tile label"
                    placeholder={defaultTileLabel(tile.op, fieldName.get(tile.field_api_name ?? ''))}
                    value={tile.label}
                    onChange={(e) => updateTile(tile.id, { label: e.target.value })}
                    className="h-8 rounded-[var(--radius-control)] border border-border-default bg-card px-2 text-[13px] text-ink placeholder:text-faint"
                  />
                  {/* #304 — what this tile measures. Scoped to the dashboard's own
                      SPACE in v1: offering a picker wider than the access story is
                      how the leak gets built (#306 defers workspace-root for the
                      same reason). */}
                  <select
                    aria-label="Tile source database"
                    value={tile.database_id ?? db}
                    onChange={(e) => {
                      const next = e.target.value === db ? undefined : e.target.value;
                      if ((tile.database_id ?? db) === (next ?? db)) return;
                      // The filter references the OLD database's fields by
                      // api_name. Keeping it would query the new database with
                      // columns it does not have — a tile that looks configured and
                      // measures nothing, which is the exact failure this ticket
                      // exists to end. Clearing it silently would lose the user's
                      // work with no warning, so: clear, and say so.
                      const hadFilter = tile.filter != null;
                      updateTile(tile.id, { database_id: next, filter: undefined, field_api_name: undefined });
                      if (hadFilter) {
                        toast.info(`Filter cleared — it referred to ${sourceName(tile.database_id ?? db)}'s fields.`);
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
                  {/* #304 — this tile's own scope. The SAME builder the view toolbar
                      uses (one filter spec, one UI), so a tile can measure a slice
                      instead of every tile repeating the view's total. No viewId is
                      passed: Personal scope is a per-VIEW override, not a per-tile one.

                      Only offered for a tile on the view's OWN database: this
                      builder needs that database's field list, and handing it the
                      wrong one produces conditions the query cannot honour. A
                      cross-database tile filters by choosing its source for now. */}
                  {(tile.database_id ?? db) === db && (
                    <FiltersSection
                      ws={ws}
                      db={db}
                      fields={fields}
                      members={memberList}
                      filters={tile.filter as FilterGroup | undefined}
                      onChange={(filter) => updateTile(tile.id, { filter: filter as FilterNode | undefined })}
                    />
                  )}
                  <div className="flex gap-1.5">
                    <select
                      aria-label="Aggregation"
                      value={tile.op}
                      onChange={(e) => {
                        const op = e.target.value as TileOp;
                        // Moving to a numeric op with no field yet? Default to the first number field.
                        const field_api_name = opNeedsField(op)
                          ? tile.field_api_name ?? numberFields[0]?.apiName
                          : undefined;
                        updateTile(tile.id, { op, field_api_name });
                      }}
                      className={SELECT_CLASS}
                    >
                      {TILE_OPS.map((op) => (
                        <option key={op} value={op}>
                          {opLabel(op)}
                        </option>
                      ))}
                    </select>
                    {opNeedsField(tile.op) && (
                      <select
                        aria-label="Field"
                        value={tile.field_api_name ?? ''}
                        onChange={(e) => updateTile(tile.id, { field_api_name: e.target.value || undefined })}
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
                  {opNeedsField(tile.op) && numberFields.length === 0 && (
                    <span className="text-[11px] text-faint">This database has no number fields to aggregate.</span>
                  )}
                </div>
              )}
            </div>
          );
        })}

        {!readOnly && (
          <button
            type="button"
            onClick={addTile}
            className="flex min-h-[120px] flex-col items-center justify-center gap-1 rounded-[var(--radius-control)] border border-dashed border-border-default text-[13px] text-muted hover:border-[var(--accent)] hover:text-ink"
          >
            <Plus className="h-4 w-4" />
            Add tile
          </button>
        )}
      </div>

      {(widgets.length > 0 || !readOnly) && (
        <div className="mt-4 grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))' }}>
          {widgets.map((widget) => (
            <DashboardWidgetCard
              key={widget.id}
              widget={widget}
              rows={rows}
              fields={fields}
              loading={loading}
              readOnly={readOnly}
              onPatch={(patch) => updateWidget(widget.id, patch)}
              onRemove={() => removeWidget(widget.id)}
            />
          ))}

          {!readOnly && (
            <button
              type="button"
              onClick={addWidget}
              className="flex min-h-[120px] flex-col items-center justify-center gap-1 rounded-[var(--radius-control)] border border-dashed border-border-default text-[13px] text-muted hover:border-[var(--accent)] hover:text-ink"
            >
              <Plus className="h-4 w-4" />
              Add chart
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * #304 — one tile's number, fetched with THAT tile's own scope.
 *
 * A tile is its own component precisely so it can own a query: the tile filter is
 * ANDed onto the view's (and the viewer's personal) filter and sent to the SAME
 * grant-scoped /records/query path every other view uses. That reuses the server's
 * filter semantics instead of re-implementing operator behaviour client-side, and
 * it keeps a tile from ever reading past the viewer's access.
 *
 * Two tiles with identical scope share one request — react-query dedupes on the
 * query key, so N tiles do not mean N round trips.
 */
function TileValue({
  ws,
  db,
  config,
  personalFilter,
  tile,
}: {
  ws: string;
  db: string;
  config: ViewConfig;
  personalFilter?: FilterNode;
  tile: DashboardTile;
}) {
  /**
   * #304 — which database this tile measures. Falls back to the view's, which is
   * how every dashboard saved before this keeps working with no config migration.
   */
  const sourceDb = tile.database_id ?? db;
  const crossDatabase = sourceDb !== db;

  /**
   * A CROSS-DATABASE tile must not inherit the view's scope.
   *
   * The view's filter, sorts and the viewer's personal override all reference the
   * VIEW database's fields by api_name. Applying them to another database asks it
   * about columns it does not have — at best an error, at worst a silent mismatch
   * where an api_name happens to exist on both and means something different.
   * That second case is the dangerous one: a tile that looks configured and
   * measures the wrong thing.
   *
   * So a cross-database tile is scoped by its OWN filter and nothing else.
   */
  const scoped = useMemo(
    () => (crossDatabase ? tile.filter : andFilterNodes(personalFilter, tile.filter)),
    [crossDatabase, personalFilter, tile.filter],
  );
  const queryBody = useMemo(
    () =>
      crossDatabase
        ? { filters: scoped as FilterNode | undefined }
        : queryBodyFromConfig(config, scoped as FilterNode | undefined),
    [crossDatabase, config, scoped],
  );
  const records = useRecordsInfinite(ws, sourceDb, queryBody);
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = records;
  // Aggregate over the whole matching set, not just page 1.
  useEffect(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  const rows = useMemo(() => (records.data?.pages ?? []).flatMap((p) => p.data), [records.data]);
  const loading = records.isLoading || hasNextPage || isFetchingNextPage;
  if (loading) return <span className="text-muted">…</span>;
  /**
   * #304 — the query is grant-scoped server-side, so a source the VIEWER cannot
   * read fails rather than returning rows. Say so. Rendering 0 here would be a
   * lie: "no access" and "adds up to zero" are different answers, and a tile
   * quietly reading 0 is indistinguishable from an empty database.
   */
  if (records.isError) {
    return (
      <span className="text-[13px] font-normal text-muted" title="You don't have access to this tile's database">
        No access
      </span>
    );
  }
  return <>{formatTileValue(computeTileValue(tile.op, tile.field_api_name, rows))}</>;
}
