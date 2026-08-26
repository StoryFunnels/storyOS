'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, Filter as FilterIcon, Pencil, Plus, Trash2 } from 'lucide-react';
import { useDatabase, useMembers, useRecordsInfinite } from '../table-view/use-table-data';
import { useDatabases } from '@/lib/queries';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import type { FilterNode, ViewConfig, FilterGroup } from './use-view-state';
import { andFilterNodes, queryBodyFromConfig } from './use-view-state';
import { FiltersSection } from './view-toolbar';
import {
  TILE_OPS,
  computeTileValue,
  defaultBlockLabel,
  defaultTileLabel,
  formatTileValue,
  opLabel,
  opNeedsField,
  targetProgress,
} from './dashboard-tiles';
import type { TileOp } from './dashboard-tiles';
import { DashboardWidgetCard } from './dashboard-widgets';
import type { DashboardWidget } from './dashboard-widgets';
import { DndContext, closestCenter, PointerSensor, useSensor, useSensors } from '@dnd-kit/core';
import type { DragEndEvent } from '@dnd-kit/core';
import { SortableContext, rectSortingStrategy } from '@dnd-kit/sortable';
import { DashboardBlockShell } from './dashboard-block-shell';
import { mergeBlocks, reorderBlocks, splitBlocks } from './dashboard-layout';
import type { BlockLayout } from '@storyos/schemas';

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
  /** #386 — where this tile sits and how big it is. Absent = source order. */
  layout?: BlockLayout;
  /** #388 — a target to measure the number against. */
  comparison?: { target?: number; direction: 'up' | 'down' };
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
  spaceId,
  config,
  readOnly,
  personalFilter,
  onPatch,
}: {
  ws: string;
  /** #306 — absent for a SPACE-level dashboard, which owns no database. */
  db?: string;
  /** #306 — set instead of `db` for a space-level dashboard, to scope the picker. */
  spaceId?: string;
  config: ViewConfig;
  readOnly: boolean;
  /** #259 — narrows this view's results for the current viewer only. */
  personalFilter?: FilterNode;
  onPatch: (updates: Partial<ViewConfig>) => void;
}) {
  const database = useDatabase(ws, db ?? '');
  // #304 — the tile filter builder needs the roster for person-field conditions.
  const members = useMembers(ws, !readOnly);
  const memberList = useMemo(
    () => (members.data ?? []).map((m) => ({ id: m.user.id, name: m.user.name })),
    [members.data],
  );
  /**
   * #367 — the page-level record fetch is GONE.
   *
   * It paged the view's entire filtered dataset on every dashboard render, and
   * since #304 nothing read it: tiles fetch their own (`TileValue`), and widgets
   * now do too. It was the last thing forcing every widget onto one database with
   * one scope — the whole defect this ticket describes — and it was also a full
   * extra pass over the table that no rendered element consumed.
   *
   * `useDatabase` below stays: the pickers still need the VIEW database's fields.
   */
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
    // #306 — the space comes from the view's own database when it has one, and
    // from the prop when it does not (a space-level dashboard).
    const space = spaceId ?? allDatabases.find((d) => d.id === db)?.spaceId;
    const inSpace = space ? allDatabases.filter((d) => d.spaceId === space) : allDatabases;
    const rest = inSpace.filter((d) => d.id !== db);
    // #306 — a space-level dashboard has no "this database" to lead with, so the
    // list opens on an explicit unconfigured choice rather than defaulting the
    // tile to whichever database happens to sort first.
    const head = db
      ? // The view's own database first and always present, even while the list
        // loads — a picker whose current value is missing renders blank and looks
        // like the tile lost its source.
        [{ id: db, name: database.data?.name ?? 'This database' }]
      : [{ id: '', name: 'Pick a database…' }];
    return [...head, ...rest.map((d) => ({ id: d.id, name: d.name }))];
  }, [allDatabases, db, spaceId, database.data?.name]);
  const sourceName = (id: string) => sourceOptions.find((o) => o.id === id)?.name ?? 'the previous database';
  const fieldName = useMemo(() => new Map(fields.map((f) => [f.apiName, f.displayName])), [fields]);

  /**
   * #385 — view mode vs edit mode.
   *
   * The only gate here used to be `readOnly`, which answers "CAN this person
   * edit", not "do they want to edit right now". Those are different questions
   * and the code only had the first — so anyone with edit rights permanently saw
   * every label input, database dropdown, aggregation select, filter builder and
   * delete icon. The readable version of a dashboard already existed and was
   * shown only to the people who had not built it.
   *
   * Deliberately component STATE, not persisted and not in the URL: a dashboard
   * left in edit mode last week must not greet you as a form. Defaults to view on
   * every load, including right after adding a tile — that moment ("is it
   * right?") is exactly when you want to see it clean.
   */
  const [editing, setEditing] = useState(false);
  /** Editors only. A viewer has nothing to toggle and already sees values only. */
  const showEditor = !readOnly && editing;

  /**
   * #387 — what a tile is called when nobody typed a label.
   *
   * Derived from the source database and the measure, never from the op alone:
   * `defaultTileLabel` returns "Count of records" for every count tile, which is
   * precisely the founder's screenshot — two tiles reading 383 and 5 under
   * identical headings. Returns null for an unconfigured source so the tile
   * renders its own "pick a database" state instead of a confident label over
   * nothing (#305).
   */
  const tileSourceId = (tile: DashboardTile) => tile.database_id ?? db ?? '';
  const tileHeading = (tile: DashboardTile): string => {
    if (tile.label.trim()) return tile.label.trim();
    const id = tileSourceId(tile);
    const derived = defaultBlockLabel({
      sourceName: id ? sourceName(id) : undefined,
      op: tile.op,
      // Only the VIEW database's field names are known here; a cross-database
      // tile's field is named by its own database, which this component does not
      // load. Falling back to the op-only label is honest — better a generic
      // measure than a wrong field name.
      fieldDisplayName: fieldName.get(tile.field_api_name ?? ''),
    });
    return derived ?? defaultTileLabel(tile.op, fieldName.get(tile.field_api_name ?? ''));
  };

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

  /**
   * #386 — ONE ordered grid over both arrays.
   *
   * Tiles and widgets stay in their own config arrays (that is storage, and
   * merging them would be a migration), but they are rendered as a single
   * sequence. That is the whole point: the two-grid structure is what forced
   * every chart below every tile, so a KPI could never sit next to the trend
   * that explains it.
   */
  const blocks = useMemo(() => mergeBlocks(tiles, widgets), [tiles, widgets]);
  const gridRef = useRef<HTMLDivElement | null>(null);
  const dragSensors = useSensors(
    // A small distance threshold so a click on the grip is still a click, and
    // a stray 1px wobble while pressing a control never starts a drag.
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
  );

  /** Write a reordered/resized sequence back to BOTH arrays in one patch. */
  function commitBlocks(next: ReturnType<typeof mergeBlocks<DashboardTile, DashboardWidget>>) {
    const split = splitBlocks(next);
    // One onPatch, not two: two would be two view-config saves for a single
    // drag, and the second could land on a stale config.
    onPatch({ dashboard_tiles: split.tiles, dashboard_widgets: split.widgets });
  }

  function onBlockDragEnd(e: DragEndEvent) {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const from = blocks.findIndex((b) => b.id === active.id);
    const to = blocks.findIndex((b) => b.id === over.id);
    if (from < 0 || to < 0) return;
    commitBlocks(reorderBlocks(blocks, from, to));
  }

  function resizeBlock(id: string, span: { w: number; h: number }) {
    commitBlocks(
      blocks.map((b) => (b.id === id ? { ...b, layout: { ...b.layout, ...span } } : b)),
    );
  }

  const isEmpty = tiles.length === 0 && widgets.length === 0;


  /**
   * One metric tile's card.
   *
   * Extracted from the JSX so #386's grid can render tiles and charts from the
   * SAME merged sequence — inline in a `tiles.map` it could only ever appear in
   * the tiles-only pass, which is the structure the ticket is removing.
   */
  function renderTile(tile: DashboardTile) {
        const heading = tileHeading(tile);
        const srcId = tileSourceId(tile);
        return (
          <div
            key={tile.id}
            /* `h-full` — the grid ITEM stretches to the row, but the card inside
               it does not, so a tile with no target (and therefore no progress
               row) rendered visibly shorter than its neighbours. Cards in a row
               must share a height or the grid reads as broken. */
            className="flex h-full flex-col gap-3 rounded-[var(--radius-control)] border border-border-default bg-card p-4"
          >
            <div className="flex items-start justify-between gap-2">
              {/* #387 — `title` carries the full text: tiles are 220px and a
                  database name longer than a few words truncates, at which
                  point hover is the only way to read it. */}
              <span className="truncate text-[13px] font-medium text-muted" title={heading}>
                {heading}
              </span>
              {/* #385 — a permanently visible destructive control on a page you
                  are only reading is its own small hazard, so the delete leaves
                  view mode entirely rather than merely being discouraged. */}
              {showEditor && (
                <button
                  type="button"
                  title="Remove tile"
                  onClick={() => removeTile(tile.id)}
                  className="shrink-0 rounded p-0.5 text-faint hover:bg-hover hover:text-error"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
            <span className="text-3xl font-semibold tabular-nums text-ink">
              <TileValue ws={ws} db={db} config={config} personalFilter={personalFilter} tile={tile} />
            </span>

            {/* #387 — provenance, quietly, in VIEW mode.
                The source database used to be visible only because the editor
                was permanently open; #385 hides that dropdown, so without this
                line view mode would be less informative than the bug. The
                filter marker matters just as much: a filtered count and an
                unfiltered one look identical and can differ by an order of
                magnitude, which is the difference between a number you trust
                and one you go and verify. */}
            {!showEditor && srcId && (
              <span className="flex items-center gap-1 text-[11px] text-faint">
                <span className="truncate" title={sourceName(srcId)}>{sourceName(srcId)}</span>
                {tile.filter != null && (
                  <span className="flex shrink-0 items-center gap-0.5" title="This tile has its own filter">
                    <FilterIcon className="h-2.5 w-2.5" />
                    filtered
                  </span>
                )}
              </span>
            )}

            {showEditor && (
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
                  value={tile.database_id ?? db ?? ''}
                  onChange={(e) => {
                    const picked = e.target.value;
                    const next = picked === '' || picked === db ? undefined : picked;
                    if ((tile.database_id ?? db ?? '') === (next ?? db ?? '')) return;
                    // The filter references the OLD database's fields by
                    // api_name. Keeping it would query the new database with
                    // columns it does not have — a tile that looks configured and
                    // measures nothing, which is the exact failure this ticket
                    // exists to end. Clearing it silently would lose the user's
                    // work with no warning, so: clear, and say so.
                    const hadFilter = tile.filter != null;
                    updateTile(tile.id, { database_id: next, filter: undefined, field_api_name: undefined });
                    if (hadFilter) {
                      toast.info(`Filter cleared — it referred to ${sourceName(tile.database_id ?? db ?? '')}'s fields.`);
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
                {db != null && (tile.database_id ?? db) === db && (
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

                {/* #388 — a target, so the number supports a decision.
                    The TARGET ships and the period comparison does not: a target
                    is one number in the config with no time-series reasoning
                    behind it, and it covers the common case ("we want 20 leads
                    this month"). A comparison needs a date field, a second query
                    and a decision about what "the previous period" means for an
                    already-filtered tile — a bigger feature, recorded on the
                    ticket rather than half-built here. */}
                {/* Stacked, not side by side. A tile is 3 of 12 columns — about
                    180px — and a number input beside a select overflows the card
                    at that width, which is what it did on first render. */}
                <div className="flex flex-col gap-1.5">
                  <input
                    type="number"
                    aria-label="Target"
                    placeholder="Target (optional)"
                    value={tile.comparison?.target ?? ''}
                    onChange={(e) => {
                      const raw = e.target.value;
                      // Empty clears the whole comparison rather than storing a
                      // target of 0 — which would otherwise read as "we are
                      // aiming at nothing" and divide to Infinity.
                      if (raw === '') return updateTile(tile.id, { comparison: undefined });
                      const target = Number(raw);
                      if (!Number.isFinite(target)) return;
                      updateTile(tile.id, {
                        comparison: { target, direction: tile.comparison?.direction ?? 'up' },
                      });
                    }}
                    className="h-8 w-full min-w-0 rounded-[var(--radius-control)] border border-border-default bg-card px-2 text-[13px] text-ink placeholder:text-faint"
                  />
                  {tile.comparison?.target != null && (
                    <select
                      aria-label="Which direction is good"
                      value={tile.comparison.direction}
                      onChange={(e) =>
                        updateTile(tile.id, {
                          comparison: {
                            target: tile.comparison?.target,
                            direction: e.target.value as 'up' | 'down',
                          },
                        })
                      }
                      className={`${SELECT_CLASS} w-full min-w-0`}
                      /* Stated, not inferred. More revenue is good; more overdue
                         invoices is bad. A wrong guess here colours a bad number
                         green, which is worse than no colour at all. */
                      title="Is a higher number good, or is the target a limit?"
                    >
                      <option value="up">Higher is better</option>
                      <option value="down">Target is a limit</option>
                    </select>
                  )}
                </div>
              </div>
            )}
          </div>
        );
  }

  return (
    <div className="h-full overflow-auto p-4">
      {/* #385 — the toggle. Only for someone who CAN edit: a viewer has nothing
          to switch and already sees values only, so showing them a disabled
          control would be noise. Placed above the grid rather than floating over
          it, so entering edit mode never covers the thing being edited. */}
      {!readOnly && !isEmpty && (
        <div className="mb-3 flex items-center justify-end">
          <button
            type="button"
            onClick={() => setEditing((e) => !e)}
            aria-pressed={editing}
            className="flex items-center gap-1.5 rounded-[var(--radius-control)] border border-border-default bg-card px-2.5 py-1 text-[13px] text-ink-secondary hover:bg-hover"
          >
            {editing ? <Check className="h-3.5 w-3.5" /> : <Pencil className="h-3.5 w-3.5" />}
            {editing ? 'Done' : 'Edit'}
          </button>
        </div>
      )}

      {isEmpty && (
        <div className="flex flex-col items-center justify-center gap-2 py-16 text-center">
          <p className="text-sm text-muted">Nothing on this dashboard yet.</p>
          {!readOnly && (
            <p className="text-[13px] text-faint">
              Add a metric tile (count, sum, average) or a chart grouped by a field.
            </p>
          )}
        </div>
      )}

      {/*
        #386 — a single 12-column grid for BOTH tiles and charts.

        The narrow-screen rule lives in `.dashboard-grid` (globals.css), not
        here. `grid-cols-1` alone does NOT collapse the blocks: a child spanning
        6 in a one-column grid creates five IMPLICIT columns rather than
        clamping, so a phone still gets tiles side by side. Verified at 375px in
        a real browser — the first version of this shipped that bug.
      */}
      <DndContext sensors={dragSensors} collisionDetection={closestCenter} onDragEnd={onBlockDragEnd}>
        <SortableContext items={blocks.map((b) => b.id)} strategy={rectSortingStrategy}>
          <div
            ref={gridRef}
            className="dashboard-grid grid grid-cols-1 gap-3 md:grid-cols-12"
            style={{ gridAutoRows: 'minmax(120px, auto)' }}
          >
            {blocks.map((block) => (
              <DashboardBlockShell
                key={block.id}
                id={block.id}
                layout={block.layout}
                editing={showEditor}
                gridRef={gridRef}
                onResize={(span) => resizeBlock(block.id, span)}
              >
                {block.kind === 'tile' ? (
                  renderTile(block.tile!)
                ) : (
                  <DashboardWidgetCard
                    ws={ws}
                    db={db}
                    config={config}
                    personalFilter={personalFilter}
                    sourceOptions={sourceOptions}
                    members={memberList}
                    widget={block.widget!}
                    showConfig={showEditor}
                    onPatch={(patch) => updateWidget(block.widget!.id, patch)}
                    onRemove={() => removeWidget(block.widget!.id)}
                  />
                )}
              </DashboardBlockShell>
            ))}
          </div>
        </SortableContext>
      </DndContext>

      {/* #385 — the add controls leave view mode, EXCEPT on an empty dashboard.
          "A dashboard with no tiles still offers a way to add one" is explicit in
          the ticket: an empty dashboard with no way forward is worse than the
          problem being fixed.

          #386 moved them OUT of the grid. As grid children they were blocks
          competing for a span, which meant the arrangement shifted the moment
          you entered edit mode — the layout you were about to adjust was not the
          layout you had been looking at. */}
      {!readOnly && (editing || isEmpty) && (
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={addTile}
            className="flex items-center gap-1 rounded-[var(--radius-control)] border border-dashed border-border-default px-3 py-2 text-[13px] text-muted hover:border-[var(--accent)] hover:text-ink"
          >
            <Plus className="h-4 w-4" />
            Add tile
          </button>
          <button
            type="button"
            onClick={addWidget}
            className="flex items-center gap-1 rounded-[var(--radius-control)] border border-dashed border-border-default px-3 py-2 text-[13px] text-muted hover:border-[var(--accent)] hover:text-ink"
          >
            <Plus className="h-4 w-4" />
            Add chart
          </button>
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
  /** #306 — absent on a space-level dashboard; the tile must name its own. */
  db?: string;
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
   * #306 — no view database AND no tile database. That is UNCONFIGURED, not
   * broken: #305's rule. The tile keeps its place and asks to be pointed
   * somewhere, and cleanViewConfig must never garbage-collect it.
   */
  const unconfigured = !sourceDb;

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
  // `enabled` inside the hook keeps an unconfigured tile from querying at all.
  const records = useRecordsInfinite(ws, sourceDb ?? '', queryBody);
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = records;
  // Aggregate over the whole matching set, not just page 1.
  useEffect(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  const rows = useMemo(() => (records.data?.pages ?? []).flatMap((p) => p.data), [records.data]);
  const loading = records.isLoading || hasNextPage || isFetchingNextPage;
  if (unconfigured) {
    return <span className="text-[13px] font-normal text-muted">Pick a database</span>;
  }
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
  const value = computeTileValue(tile.op, tile.field_api_name, rows);
  /*
   * #388 — the target, when there is one and it can be computed honestly.
   * `targetProgress` returns null for a missing value, a missing target or a
   * zero target, so a tile never reports "0% of target" while still loading or
   * "∞% of target" against a target of nothing.
   */
  const progress = targetProgress(value, tile.comparison?.target, tile.comparison?.direction ?? 'up');
  if (!progress) return <>{formatTileValue(value)}</>;
  return (
    <span className="flex flex-col gap-1">
      <span className="flex items-baseline gap-1.5">
        {formatTileValue(value)}
        <span
          className={cn(
            'text-[12px] font-medium',
            /* Semantic, NOT the brand accent: good/bad/neutral is a different
               scale from "this is interactive", and #388 requires it legible in
               both themes. These three tokens are already theme-aware. */
            progress.tone === 'good' && 'text-success',
            progress.tone === 'bad' && 'text-error',
            progress.tone === 'neutral' && 'text-muted',
          )}
        >
          {Math.round(progress.percent)}%
        </span>
      </span>
      <span className="flex items-center gap-1.5">
        <span className="h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-hover">
          <span
            className={cn(
              'block h-full rounded-full',
              progress.tone === 'good' && 'bg-success',
              progress.tone === 'bad' && 'bg-error',
              progress.tone === 'neutral' && 'bg-muted',
            )}
            style={{ width: `${progress.ratio * 100}%` }}
          />
        </span>
        <span className="shrink-0 text-[11px] font-normal text-faint">{progress.label}</span>
      </span>
    </span>
  );
}
