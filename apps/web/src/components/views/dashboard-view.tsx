'use client';

import { useEffect, useMemo } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { useDatabase, useRecordsInfinite } from '../table-view/use-table-data';
import type { FilterNode, ViewConfig } from './use-view-state';
import { queryBodyFromConfig } from './use-view-state';
import {
  TILE_OPS,
  computeTileValue,
  defaultTileLabel,
  formatTileValue,
  opLabel,
  opNeedsField,
} from './dashboard-tiles';
import type { TileOp } from './dashboard-tiles';

/** One metric tile in a dashboard view's config (mirrors dashboardTileSchema). */
export interface DashboardTile {
  id: string;
  label: string;
  op: TileOp;
  field_api_name?: string;
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

  return (
    <div className="h-full overflow-auto p-4">
      {tiles.length === 0 && (
        <div className="flex flex-col items-center justify-center gap-2 py-16 text-center">
          <p className="text-sm text-muted">No metric tiles yet.</p>
          {!readOnly && (
            <p className="text-[13px] text-faint">Add a tile to show a count, sum, or average of your records.</p>
          )}
        </div>
      )}

      <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))' }}>
        {tiles.map((tile) => {
          const value = loading ? null : computeTileValue(tile.op, tile.field_api_name, rows);
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
                {loading ? <span className="text-muted">…</span> : formatTileValue(value)}
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
    </div>
  );
}
