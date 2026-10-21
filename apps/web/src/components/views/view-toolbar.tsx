'use client';

/**
 * #706 — THE --text-faint SITES IN THIS FILE ARE CLASSIFIED. 21 of them stay
 * faint deliberately; do not "finish the job" by sweeping them.
 *
 * Every remaining one is a NON-TEXT GRAPHIC, judged at 3:1 rather than the
 * 4.5:1 that applies to text, which faint clears on every surface this toolbar
 * renders over. They fall into three families:
 *
 *   - ICON-ONLY BUTTONS whose accessible name is a `title` attribute — remove
 *     (X), unpin, "More" (MoreHorizontal), the enable/disable eye, the
 *     CircleHelp links, and the per-row remove buttons.
 *   - ICON FALLBACKS passed to <EntityIcon> for a field with no icon of its own.
 *   - DRAG HANDLES (GripVertical), which additionally only appear on hover.
 *
 * The 24 sites that DID move were text: section headings, empty states,
 * placeholder values, unselected segmented-control labels, and the "Clear all"
 * and "Empty values" labels. The rule this follows is globals.css's own —
 * faint is reserved for genuinely decorative text, and anything carrying an
 * affordance uses --text-muted.
 */

import { useEffect, useMemo, useState } from 'react';
import { newSummaryWidgets } from './summary-widget-strip';
import { ViewSearchBox } from './view-search-box';
import { useViewSearch } from './view-search';
import { filterButtonState } from './filter-state';
import { DisplayMenu } from './display-menu';
import { GroupChip, showsGroupChip, viewGroups } from './group-chip';
import { buildViewMenu } from './view-menu';
import type { ViewMenuHandlers, ViewMenuTarget } from './view-menu';
import { RenameViewDialog, ViewMenuItems } from './view-menu-items';
import { useRecordCount } from '../table-view/use-table-data';
import { viewSupportsSummaryWidgets } from './summary-widget-support';
import { SORTABLE_FIELD_TYPES, isIncompleteCondition } from '@storyos/schemas';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  ArrowUpDown,
  Check,
  CircleHelp,
  Copy,
  Eye,
  EyeOff,
  Group,
  GripVertical,
  ListFilter,
  MoreHorizontal,
  Palette,
  PenLine,
  Pin,
  PinOff,
  Plus,
  Search,
  Trash2,
  Ungroup,
  UserRound,
  X,
} from 'lucide-react';
import { DndContext, closestCenter } from '@dnd-kit/core';
import type { DragEndEvent } from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { DatePicker } from '@/components/ui/date-picker';
import { DragPreview, useDragPresentation, useSortableSensors, vacatedSlotClass } from '@/components/ui/drag-presentation';
import { EntityIcon, IconColorPicker } from '@/components/ui/icon-picker';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Tooltip } from '@/components/ui/tooltip';
import { API_URL, api } from '@/lib/api';
import { cn } from '@/lib/utils';
import type { Field } from '../table-view/use-table-data';
import { fieldTypeIcon } from './field-type-icon';
import type { FilterCondition, SortSpec, ViewConfig } from './use-view-state';
import { queryBodyFromConfig, useClearPersonalFilter, useSetPersonalFilter } from './use-view-state';
import {
  buildFilterGroup,
  canMoveNodeTo,
  canTurnIntoGroup,
  duplicateNodeAt,
  filterConditions,
  filterConnector,
  flattenFilterTree,
  getNodeAt,
  isFilterGroup,
  moveNodeTo,
  nodeChildren,
  nodeConnector,
  pathFromId,
  removeNodeCascade,
  turnIntoGroup,
  ungroupNodeAt,
  updateNodeAt,
  visibleFilterChips,
} from './filter-config';
import type { FilterConnector, FilterGroup, FilterNode } from './filter-config';
import { MAX_SORTS, directionLabel, isSortableFormula, nextSortField, reorderSorts } from './sort-config';
import type { NullsPlacement } from './sort-config';
import { SYSTEM_FIELD_OPS, SYSTEM_USER_TYPES, isPickableField, withSystemFields } from './system-fields';
import { OPTION_COLORS, OptionIcon } from '../table-view/cells';

/**
 * Op menu per field type — mirrors the API op×type matrix.
 *
 * #429 — audited against `apps/api/src/records/query-compiler.ts`'s actual
 * allowed-op sets (TEXTISH_OPS/NUMBER_OPS/DATE_FIELD_OPS/ID_SET_SCALAR_OPS/
 * ID_SET_ARRAY_OPS/RELATION_OPS), not against this file's own prior list —
 * the compiler turned out to already accept `is_empty`/`not_empty` uniformly
 * and `eq`/`neq` on select/workflow, so most of what's added here is exposing
 * ops the API always accepted, proven by the round-trip tests alongside this
 * change rather than by inspection alone. Two things are DELIBERATELY still
 * missing, each with the compiler-side reason:
 *  - `between` (number/date): expressible today as two conditions (`gte` +
 *    `lte`, or `after` + `before`), and Otto's ruling is explicit that a
 *    second op for the same query is not worth a second control until
 *    someone actually asks for it.
 *  - is_empty/not_empty on `checkbox`: the compiler accepts them (a missing
 *    key vs. a stored boolean), but a checkbox defaults to a real `false`
 *    the moment it's ever touched, so "empty" only ever means "never
 *    touched" — a distinction almost nobody is asking "is this checked"
 *    actually means. `neq` ("is not") is added since it's the ordinary
 *    negation of the one op already offered.
 */
export type OpsEntry = {
  op: string;
  label: string;
  input: 'text' | 'number' | 'date' | 'options' | 'option' | 'relative' | 'boolean' | 'records' | 'none';
};

export const OPS_BY_TYPE: Record<string, OpsEntry[]> = {
  title: [
    { op: 'contains', label: 'contains', input: 'text' },
    { op: 'not_contains', label: 'does not contain', input: 'text' },
    { op: 'eq', label: 'is', input: 'text' },
    { op: 'neq', label: 'is not', input: 'text' },
    { op: 'is_empty', label: 'is empty', input: 'none' },
    { op: 'not_empty', label: 'is not empty', input: 'none' },
  ],
  text: [
    { op: 'contains', label: 'contains', input: 'text' },
    { op: 'not_contains', label: 'does not contain', input: 'text' },
    { op: 'eq', label: 'is', input: 'text' },
    { op: 'neq', label: 'is not', input: 'text' },
    { op: 'is_empty', label: 'is empty', input: 'none' },
    { op: 'not_empty', label: 'is not empty', input: 'none' },
  ],
  url: [
    { op: 'contains', label: 'contains', input: 'text' },
    { op: 'not_contains', label: 'does not contain', input: 'text' },
    { op: 'eq', label: 'is', input: 'text' },
    { op: 'neq', label: 'is not', input: 'text' },
    { op: 'is_empty', label: 'is empty', input: 'none' },
    { op: 'not_empty', label: 'is not empty', input: 'none' },
  ],
  email: [
    { op: 'contains', label: 'contains', input: 'text' },
    { op: 'not_contains', label: 'does not contain', input: 'text' },
    { op: 'eq', label: 'is', input: 'text' },
    { op: 'neq', label: 'is not', input: 'text' },
    { op: 'is_empty', label: 'is empty', input: 'none' },
    { op: 'not_empty', label: 'is not empty', input: 'none' },
  ],
  // #391 — "posts with no cover image". Presence only: a filter box asking for
  // a file uuid is a control with nothing sensible to type into it.
  attachment: [
    { op: 'is_empty', label: 'is empty', input: 'none' },
    { op: 'not_empty', label: 'is not empty', input: 'none' },
  ],
  number: [
    { op: 'eq', label: '=', input: 'number' },
    { op: 'neq', label: '≠', input: 'number' },
    { op: 'gt', label: '>', input: 'number' },
    { op: 'gte', label: '≥', input: 'number' },
    { op: 'lt', label: '<', input: 'number' },
    { op: 'lte', label: '≤', input: 'number' },
    { op: 'is_empty', label: 'is empty', input: 'none' },
    { op: 'not_empty', label: 'is not empty', input: 'none' },
  ],
  date: [
    { op: 'within', label: 'within', input: 'relative' },
    { op: 'eq', label: 'on', input: 'date' },
    { op: 'neq', label: 'is not', input: 'date' },
    { op: 'before', label: 'before', input: 'date' },
    { op: 'after', label: 'after', input: 'date' },
    { op: 'is_empty', label: 'is empty', input: 'none' },
    { op: 'not_empty', label: 'is not empty', input: 'none' },
  ],
  checkbox: [
    { op: 'eq', label: 'is', input: 'boolean' },
    { op: 'neq', label: 'is not', input: 'boolean' },
  ],
  select: [
    { op: 'eq', label: 'is', input: 'option' },
    { op: 'neq', label: 'is not', input: 'option' },
    { op: 'has', label: 'is any of', input: 'options' },
    { op: 'has_none', label: 'is none of', input: 'options' },
    { op: 'is_empty', label: 'is empty', input: 'none' },
    { op: 'not_empty', label: 'is not empty', input: 'none' },
  ],
  // #172: a workflow (canonical Status) field is single-select-shaped — one
  // coloured option id — so it filters exactly like `select`. Omitting it here
  // dropped Status out of the Filter/Sort/Color field pickers entirely.
  // #429/#558: kept byte-for-byte identical to `select` — this is also the
  // MCP's OPS_BY_FIELD_TYPE.workflow list (packages/mcp/src/tools.ts), and
  // Otto's ruling is that the two must never diverge.
  workflow: [
    { op: 'eq', label: 'is', input: 'option' },
    { op: 'neq', label: 'is not', input: 'option' },
    { op: 'has', label: 'is any of', input: 'options' },
    { op: 'has_none', label: 'is none of', input: 'options' },
    { op: 'is_empty', label: 'is empty', input: 'none' },
    { op: 'not_empty', label: 'is not empty', input: 'none' },
  ],
  multi_select: [
    { op: 'has', label: 'includes any of', input: 'options' },
    { op: 'has_none', label: 'includes none of', input: 'options' },
    { op: 'is_empty', label: 'is empty', input: 'none' },
    { op: 'not_empty', label: 'is not empty', input: 'none' },
  ],
  relation: [
    { op: 'not_empty', label: 'is linked', input: 'none' },
    { op: 'is_empty', label: 'is not linked', input: 'none' },
    { op: 'has', label: 'is any of', input: 'records' },
    { op: 'has_none', label: 'is none of', input: 'records' },
  ],
  // #352 — the built-in system columns (number/id/created_at/updated_at/
  // created_by/updated_by), keyed by their compiler type. Sourced from the
  // shared @storyos/schemas registry so the op menu never diverges from what
  // the API filter compiler accepts.
  ...SYSTEM_FIELD_OPS,
};

/**
 * #429 — `user` is the one type whose op set genuinely depends on the FIELD,
 * not just the type: a single-assignee field is stored as a scalar id (the
 * compiler's `compileIdSet(..., 'scalar')`, same shape as select/workflow,
 * so `eq`/`neq` are meaningful), while a multi-assignee field
 * (`config.multi === true`) is stored as an array (`'array'` shape) and the
 * compiler explicitly REFUSES eq/neq there ("use has/has_none for user
 * fields") — offering them would be an operator the compiler rejects, which
 * criterion 5 calls worse than not offering it. `opsForField` is the one
 * place that decides which list a given `user` field gets; every other type
 * still reads straight off `OPS_BY_TYPE`.
 */
const USER_SCALAR_OPS: OpsEntry[] = [
  { op: 'eq', label: 'is', input: 'option' },
  { op: 'neq', label: 'is not', input: 'option' },
  { op: 'has', label: 'is any of', input: 'options' },
  { op: 'has_none', label: 'is none of', input: 'options' },
  { op: 'is_empty', label: 'is empty', input: 'none' },
  { op: 'not_empty', label: 'is not empty', input: 'none' },
];
const USER_ARRAY_OPS: OpsEntry[] = [
  { op: 'has', label: 'is any of', input: 'options' },
  { op: 'has_none', label: 'is none of', input: 'options' },
  { op: 'is_empty', label: 'is empty', input: 'none' },
  { op: 'not_empty', label: 'is not empty', input: 'none' },
];

/** The op list for THIS field — the one call every site should use instead of
 * indexing `OPS_BY_TYPE` directly, since `user` needs its field's own config
 * to answer (see USER_SCALAR_OPS/USER_ARRAY_OPS above). */
export function opsForField(field: Field): OpsEntry[] {
  if (field.type === 'user') return field.config['multi'] === true ? USER_ARRAY_OPS : USER_SCALAR_OPS;
  return OPS_BY_TYPE[field.type] ?? [];
}

const RELATIVE_RANGES = [
  'today',
  'yesterday',
  'tomorrow',
  'last_7_days',
  'next_7_days',
  'this_month',
  'next_30_days',
];

/**
 * #680 — DERIVED from the schema's own `SORTABLE_FIELD_TYPES`, never a second
 * hand-maintained list. This set used to be a literal copy "mirroring" the
 * api's SORTABLE_FIELD_TYPES (records.service.ts) by hand, and it drifted
 * TWICE: #657 added `relation` to the api's list and this file's copy missed
 * it (Epic and every other relation field stayed unsortable in the picker
 * despite the API accepting the sort); #662 fixed `user` here by hand instead
 * of importing the shared export, which is why the drift for `relation`
 * wasn't caught by the same fix. Importing the export directly makes a THIRD
 * occurrence structurally impossible — there is no longer a second literal to
 * forget updating.
 */
export const SORTABLE = new Set<string>(SORTABLE_FIELD_TYPES);

/**
 * #754 (G1) — replaces the Cover picker when the database has no attachment
 * field at all. #225's rule, reused verbatim for the gallery: "a picker that
 * silently omits a field is indistinguishable from a bug" — this one omitted
 * the whole picker. Names the fix rather than a bare "no attachment field"
 * dead end. Text only, deliberately: an inline "+ Add field" dialog here
 * would import `add-field-dialog.tsx`, which imports `button-actions-editor.tsx`,
 * which imports THIS file — a real cycle the import-cycle guard (#315) catches
 * for good reason. The existing "+ New field" affordance (record page, Hide
 * Fields panel) is one click away without it.
 */
export function ViewToolbar({
  fields,
  config,
  members,
  viewType = 'table',
  onPatch,
  ws,
  db,
  databaseId,
  viewId,
  personalFilter,
  onReorderFields,
  readOnly,
  view,
  viewMenu,
  onRenameView,
}: {
  fields: Field[];
  config: ViewConfig;
  members: Array<{ id: string; name: string }>;
  viewType?: string;
  onPatch: (updates: Partial<ViewConfig>) => void;
  /** MN-075: identifies what to export. */
  ws?: string;
  db?: string;
  /** #233 — the current database's real id, for hierarchy-field eligibility
   * (a field's `relation.target_database_id` is a real id, never the route's
   * slug — `db` above may be either). Optional so every existing call site
   * that has no use for hierarchy mode (non-table views) needn't change. */
  databaseId?: string;
  viewId?: string;
  /** #259 — current viewer's personal override for THIS view, if any. */
  personalFilter?: FilterNode;
  /** #338 — drag-to-reorder the canonical field order from the Hide-fields panel.
   * Only supplied when the viewer may edit the schema (`creator`); omitted = read-only list. */
  onReorderFields?: (activeId: string, overId: string) => void;
  /** #698 — gates the add-summary-widget control only. The toolbar's other
   * controls keep whatever permission behaviour they already had. */
  readOnly?: boolean;
  /** #964 — the view this toolbar is showing, for the ⋯ menu. Absent = no menu. */
  view?: ViewMenuTarget;
  /** #964 — what the page can do for this view (everything but the toolbar's own widget / CSV / rename). */
  viewMenu?: ViewMenuHandlers;
  /** #964 — the toolbar door's rename. The tab renames inline; the sidebar has its own dialog. */
  onRenameView?: (name: string) => void;
}) {
  // #352 — overlay the canonical system-field set (Number, ID, Created, Last
  // edited, Created by, Last edited by) onto the introspected fields so filter
  // & sort enumerate them alongside user fields. Contained to these two
  // surfaces: the Cards / Hide-fields / color / group sections keep the raw
  // `fields` (system columns aren't card/hideable toggles).
  const augmented = useMemo(() => withSystemFields(fields), [fields]);
  // #743 — a deprecated system field (`number`) still resolves via `augmented`
  // for an EXISTING chip's label, but must never be offered as a NEW pick.
  const filterable = augmented.filter((f) => opsForField(f).length > 0 && isPickableField(f));

  /**
   * #289/#699/#702 — what the Hide-fields / Cards pickers may offer.
   *
   * `rendered` is every ORDINARY column a view actually renders — no synthetic
   * entries mixed in. `title` stays non-togglable (hiding it would leave rows
   * unidentifiable); so does `id` (#699 — the raw internal UUID renders as a
   * column nowhere, so its toggle did nothing) and `created_by` (views don't
   * render it either): a toggle that can't change what you see is worse than
   * no toggle.
   *
   * The synthetic permanent-number id is deliberately NOT part of `rendered`
   * (only meaningful when the database has no REAL `number` field row of its
   * own). #659 made it render as a suffix inside table view's row-index
   * gutter, not as an ordinary column — table view offers it as its own "Row
   * gutter" section (`HiddenFieldsButton` below), separate from this generic
   * list, per #699 AC2. #702 found the SAME synthetic id was also being handed
   * to the five card-based view types' picker (board/calendar/gallery/list/
   * feed) even though none of them read it: nothing there renders a gutter for
   * it to merge into, so it's excluded from `rendered` entirely rather than
   * offering a toggle with no effect on any of them.
   */
  const rendered = useMemo(() => fields.filter((f) => !NON_TOGGLABLE.has(f.type)), [fields]);
  /** #699 — the synthetic number system-field entry, only when the database
   *  has no real `number` field of its own (in which case that real field
   *  already flows through `rendered` with ordinary present-means-hidden
   *  semantics, per number-column.ts's own comment). */
  const numberEntry = useMemo(() => {
    const hasNumber = fields.some((f) => f.apiName === 'number');
    return hasNumber ? undefined : augmented.find((f) => f.apiName === 'number');
  }, [fields, augmented]);
  /** #739 AC3 — table's Fields list must keep offering the system DATE
   *  columns (Created, Last edited), off by default, same "unconfigured, not
   *  excluded" treatment as `numberEntry` above and the opposite of rich
   *  text's total removal (AC2). Same "real row wins" guard: only the
   *  synthetic entry is added, and only when the database has no stored field
   *  of that type already flowing through `rendered`. */
  const systemDateEntries = useMemo(
    () =>
      augmented.filter(
        (f) =>
          (f.type === 'created_at' || f.type === 'updated_at') &&
          !fields.some((real) => real.apiName === f.apiName),
      ),
    [fields, augmented],
  );

  const [renaming, setRenaming] = useState(false);
  const viewKind = viewType ?? 'table';

  // #964 — the ONE view menu (view-menu.ts). The toolbar door adds what is about the rows on screen:
  // a summary widget and a CSV. Everything else is the same list the tab and the sidebar show.
  const menuItems =
    view && viewMenu
      ? buildViewMenu(view, {
          ...viewMenu,
          onRename: onRenameView ? () => setRenaming(true) : undefined,
          onAddWidget:
            !readOnly && viewSupportsSummaryWidgets(viewKind)
              ? () => onPatch({ summary_widgets: newSummaryWidgets(config) })
              : undefined,
          exportHref: ws && db ? csvExportHref(ws, db, viewId) : undefined,
        })
      : [];

  return (
    <div className="flex min-h-9 flex-wrap items-center gap-1.5 border-b border-border-default bg-app px-3 py-1">
      {/* #964 — Filter · Sort · [Group] · Find · N of M · Display · ⋯ · New, in that order. The
          left cluster is what narrows and orders the rows; the right is how they look, the view's
          own menu, and the one primary action. */}
      {/* #725 — NEITHER OF THESE APPLIES TO A FORM. A form view has no result set: it CREATES records
          rather than displaying them, so Filter narrows nothing and Sort orders nothing. Per-field
          `relation_filter` (#501) is the REAL mechanism for narrowing a relation picker's candidates on
          a form; it lives in the form builder and is untouched. */}
      {viewType !== 'form' && (
        <>
          {/* Filters (MN-253): the builder + pinned chips — one spec (ViewConfig.filters) shared by every
              view type. Personal scope (#259) rides along: same popover, a Global/Personal toggle. */}
          <FiltersSection
            fields={filterable}
            members={members}
            ws={ws}
            db={db}
            viewId={viewId}
            filters={config.filters}
            onChange={(filters) => onPatch({ filters })}
            personalFilter={personalFilter}
          />
          {/* Sorts (MN-252): field-type-aware, self-filtered to what the query layer can order by. */}
          <SortButton
            fields={augmented}
            sorts={config.sorts}
            emptyLabel="Manual order"
            nulls={config.sorts_nulls}
            onChange={(sorts) => onPatch({ sorts })}
            onNullsChange={(sorts_nulls) => onPatch({ sorts_nulls })}
          />
        </>
      )}

      {/* Group: ALWAYS on a board (its columns ARE the grouping), on a list only while grouping is on.
          The change-grouping dialog and the toggles that lived in the filter popover are in here. */}
      {viewGroups(viewType) && showsGroupChip(viewType, config) && (
        <GroupChip viewType={viewType} fields={fields} config={config} onPatch={onPatch} />
      )}

      {/* #835 — transient find-in-view. Not for a form (it shows no records) or a dashboard (tiles). */}
      {ws && db && viewType !== 'form' && viewType !== 'dashboard' && (
        <ViewSearchBox ws={ws} db={db} config={config} personalFilter={personalFilter} />
      )}

      <div className="ml-auto flex items-center gap-1.5">
        {ws && db && viewType !== 'form' && viewType !== 'dashboard' && (
          <ViewCount ws={ws} db={db} config={config} personalFilter={personalFilter} />
        )}
        <DisplayMenu
          viewType={viewKind}
          fields={fields}
          rendered={rendered}
          numberEntry={numberEntry}
          systemDateEntries={systemDateEntries}
          config={config}
          onPatch={onPatch}
          databaseId={databaseId}
          onReorderFields={onReorderFields}
        />
        {menuItems.length > 0 && (
          <DropdownMenu>
            <Tooltip label="View options">
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  aria-label="View options"
                  className="flex h-7 w-7 items-center justify-center rounded-[var(--radius-control)] text-muted hover:bg-hover hover:text-ink aria-expanded:bg-hover"
                >
                  <MoreHorizontal className="h-4 w-4" />
                </button>
              </DropdownMenuTrigger>
            </Tooltip>
            <DropdownMenuContent align="end" className="w-56">
              <ViewMenuItems items={menuItems} />
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        {ws && db && !readOnly && viewType !== 'dashboard' && <NewRecordButton ws={ws} db={db} />}
      </div>
      {view && onRenameView && (
        <RenameViewDialog open={renaming} onOpenChange={setRenaming} name={view.name} onRename={onRenameView} />
      )}
    </div>
  );
}

/**
 * #964 — "N of M": the rows this view shows, out of every row in the database. Two server-side
 * counts (the same `/aggregate` the table header uses, never a count of loaded pages), so it stays
 * true past the first page. Shown as just "M" when nothing narrows the view.
 */
function ViewCount({
  ws,
  db,
  config,
  personalFilter,
}: {
  ws: string;
  db: string;
  config: ViewConfig;
  personalFilter?: FilterNode;
}) {
  const search = useViewSearch(db);
  const body = queryBodyFromConfig(config, personalFilter, search);
  const shown = useRecordCount(ws, db, body['filter'], true, body['q'] as string | undefined);
  const total = useRecordCount(ws, db);
  if (total.data === undefined) return null;
  const narrowed = shown.data !== undefined && shown.data !== total.data;
  return (
    <span className="whitespace-nowrap px-1 text-label tabular-nums text-muted" aria-live="polite">
      {narrowed ? `${shown.data} of ${total.data}` : String(total.data)}
    </span>
  );
}

/**
 * #964 — the toolbar's ONE primary button. It makes a blank record and opens it (what the mobile
 * quick-add already does), on every view type. It also answers `storyos:new-record`, the event the
 * command palette's "New record here" has always dispatched and nothing used to listen for.
 */
function NewRecordButton({ ws, db }: { ws: string; db: string }) {
  const router = useRouter();
  const create = useMutation({
    mutationFn: async () => {
      const { data, error } = await api.POST('/api/v1/workspaces/{ws}/databases/{db}/records', {
        params: { path: { ws, db } },
        body: { values: {} },
      });
      if (error) throw error;
      return data as unknown as { id: string };
    },
    onSuccess: (created) => router.push(`/w/${ws}/d/${db}/r/${created.id}`),
    onError: () => toast.error('Could not create the record'),
  });
  useEffect(() => {
    const onNew = () => create.mutate();
    window.addEventListener('storyos:new-record', onNew);
    return () => window.removeEventListener('storyos:new-record', onNew);
  }, [create]);
  return (
    <button
      type="button"
      onClick={() => create.mutate()}
      disabled={create.isPending}
      className="flex h-7 items-center gap-1 rounded-[var(--radius-control)] bg-primary px-2.5 text-label font-semibold text-[var(--text-on-dark)] hover:bg-primary-hover disabled:opacity-60"
    >
      <Plus className="h-3.5 w-3.5" /> New
    </button>
  );
}

/**
 * The CSV export is a plain link, not a fetch: the browser handles the download, so we don't buffer a
 * large CSV into memory just to re-emit it as a blob. Credentials ride the cookie the app already uses.
 * (#964: it is the view menu's "Export CSV" now, so this is the href, not a button.)
 *
 * #725 — a form view has no rows of its own; the export queries the DATABASE's records and, because a
 * form does not use `hidden_field_ids`, carries every field. That is the right answer for submissions.
 */
export function csvExportHref(ws: string, db: string, viewId?: string): string {
  return `${API_URL}/api/v1/workspaces/${ws}/databases/${db}/export/csv${viewId ? `?view=${viewId}` : ''}`;
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
        <button className="flex items-center gap-1 rounded px-1.5 py-1 text-label text-muted hover:bg-hover hover:text-ink">
          <Palette className="h-3.5 w-3.5" /> {active ? `Color: ${active.displayName}` : 'Color'}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="min-w-44">
        <button
          className="flex w-full items-center justify-between rounded px-2 py-1.5 text-body text-ink hover:bg-hover"
          onClick={() => onChange(undefined)}
        >
          None {!value && <Check className="h-3.5 w-3.5 text-accent" />}
        </button>
        {fields.map((field) => (
          <button
            key={field.id}
            className="flex w-full items-center justify-between rounded px-2 py-1.5 text-body text-ink hover:bg-hover"
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

// #175 — the field-type icon map now lives in its own module (shared with the
// Fields menu). Re-exported here so existing importers of the toolbar keep working.
export { fieldTypeIcon };

/**
 * #423 — retarget a condition at a different field.
 *
 * The operator is ALWAYS replaced with one valid for the new type, never
 * carried over: `is any of` makes sense on a user field and is nonsense on a
 * date, and a condition holding an op its field does not support renders the
 * wrong widget for it. The value is reset for the same reason — a user id array
 * is not a date.
 *
 * Returns null when the new type has no operators at all. The previous code
 * fell back to keeping the old op in that case, which is the one branch that
 * could produce an incoherent condition; refusing the switch leaves the user
 * where they were instead of somewhere broken.
 */
export function remapConditionToField(
  condition: FilterCondition,
  nextField: Field,
): FilterCondition | null {
  const first = opsForField(nextField)[0];
  if (!first) return null;
  return {
    ...condition,
    field: nextField.apiName,
    op: first.op,
    value: defaultValueFor(first.input),
  };
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
        <button className="flex items-center gap-1 rounded px-1.5 py-1 text-label text-muted hover:bg-hover hover:text-ink">
          <ListFilter className="h-3.5 w-3.5" /> {label}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="max-h-64 overflow-y-auto">
        {fields.map((field) => {
          const Icon = fieldTypeIcon(field.type);
          return (
            <button
              key={field.id}
              className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-body text-ink hover:bg-hover"
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

/** True for any field whose value is a user id — a real `user` field or one of the
 * system authorship columns (Created by / Last edited by). They share one picker. */
function isUserField(field: Field): boolean {
  return field.type === 'user' || SYSTEM_USER_TYPES.has(field.type);
}

/** The dynamic "Me" value (#191): stored verbatim as the id `'me'`, which the query
 * compiler's `resolveMe` swaps for the current viewer at query time. Offered on every
 * user-typed field so an "assigned to me" filter keeps meaning "me" for each teammate
 * a shared view reaches, instead of pinning to whoever built it. `has`/`has_none`
 * already map each array element through `resolveMe`, and user fields skip the
 * option-id validation `select` gets, so `'me'` rides through the AST untouched. */
export const ME_OPTION = { id: 'me', label: 'Me (current user)' } as const;

/** The `{id,label}` list an options/person picker draws from: user fields lead with
 * the dynamic "Me" entry then the workspace members; everything else uses the field's
 * own select options. Shared by the value editor and `describeCondition` so a stored
 * `'me'` (or option id) renders the same label everywhere. */
/**
 * #215: carries each option's `icon` and `color` alongside its label, so a filter
 * chip draws the option the way every other surface draws it. Previously this
 * flattened to `{id, label}` and the filter was the one place an option lost its
 * appearance — you'd pick "Blocked 🚫" from a board and see bare text in the
 * filter that produced the same set.
 *
 * A member (user field) has no option row and therefore no icon/colour; those
 * entries simply omit both.
 */
/** #215: an option's colour as a `currentColor` tint for its icon, so the icon
 *  carries the same colour cue the chip's fill does. No colour (a member entry)
 *  means inherit, which is what the surrounding text already uses. */
function optionTint(color?: string): { color: string } | undefined {
  if (!color) return undefined;
  const hex = OPTION_COLORS[color];
  return hex ? { color: hex } : undefined;
}

function optionSourceFor(
  field: Field,
  members: Array<{ id: string; name: string }>,
): Array<{ id: string; label: string; icon?: string | null; color?: string }> {
  if (isUserField(field)) return [ME_OPTION, ...members.map((m) => ({ id: m.id, label: m.name }))];
  return (field.options ?? []).map((o) => ({ id: o.id, label: o.label, icon: o.icon, color: o.color }));
}

/**
 * Exported for #423's mount test: every `input` kind in OPS_BY_TYPE has to
 * render standalone, because that is exactly how the toolbar mounts it — a
 * control that needs a parent it does not create is a crash waiting for the
 * first person who picks that field type.
 */
export function FilterValueEditor({
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
    : 'rounded-[var(--radius-control)] border border-border-default bg-card px-1 py-0.5 text-label text-ink outline-none';

  const optionSource = optionSourceFor(field, members);

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
      <DateFilterInput
        value={condition.value == null ? null : String(condition.value)}
        boxed={boxed}
        onChange={(v) => onChange({ ...condition, value: v ?? '' })}
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
  // #429 — `eq`/`neq` on select/workflow/user: a SCALAR id, not the array
  // `options` stores. A plain native `<select>` rather than reusing
  // OptionMultiPick's chip-and-dropdown UI — that UI is built around
  // "several chips at once", and dressing it up to hold exactly one would be
  // more control for a simpler question than it's answering.
  if (activeOp.input === 'option') {
    return (
      <select
        className={boxed}
        value={typeof condition.value === 'string' ? condition.value : ''}
        onChange={(e) => onChange({ ...condition, value: e.target.value || null })}
      >
        <option value="">pick…</option>
        {optionSource.map((o) => (
          <option key={o.id} value={o.id}>
            {o.label}
          </option>
        ))}
      </select>
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
      <span className="text-muted">unavailable</span>
    );
  }
  return null;
}

/** Date value control for a `before`/`after`/`on` filter — the app's own DatePicker
 * (forgiving text parse + calendar grid + Today/Clear) instead of a bare native
 * `<input type=date>`, matching the cell editor. A trigger button shows the current
 * ISO value; clicking it mounts the self-positioning picker over a parent anchor. */
function DateFilterInput({
  value,
  boxed,
  onChange,
}: {
  value: string | null;
  boxed: string;
  onChange: (value: string | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  /*
   * #423 — there is deliberately NO PopoverParentAnchor here.
   *
   * One used to sit at the top of this span, and it crashed the route: a Radix
   * `PopoverAnchor` throws without a `<Popover>` ancestor, and nothing here
   * provides one. It was almost certainly copied from the cell editors
   * (table-view/cells.tsx, entity/scalar-fields.tsx, relation-cell.tsx) where
   * the CALLER wraps the control in a `<Popover>`. Here the toolbar mounts this
   * control bare.
   *
   * It also rendered outside the `editing` guard, so it threw the moment a date
   * filter mounted — before anyone clicked anything. That is why picking a date
   * field was not a degraded experience but a white screen.
   *
   * The anchor is not missing: `DatePicker` renders its own `<Popover open>`
   * AND its own PopoverParentAnchor inside it, and that anchor positions
   * against this `relative` span. Which is what the span is for — keep it.
   */
  return (
    <span className="relative inline-block">
      <button
        type="button"
        className={cn(boxed, !value && 'text-muted')}
        onClick={() => setEditing((v) => !v)}
      >
        {value ? value.slice(0, 10) : 'pick date…'}
      </button>
      {editing && (
        <DatePicker
          value={value}
          onCommit={(v) => {
            onChange(v);
            setEditing(false);
          }}
          onCancel={() => setEditing(false)}
        />
      )}
    </span>
  );
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
  const ops = opsForField(field);
  const activeOp = ops.find((o) => o.op === condition.op) ?? ops[0];
  if (!activeOp) return field.displayName;
  if (activeOp.input === 'none') return `${field.displayName} ${activeOp.label}`;
  if (activeOp.input === 'options') {
    const ids = Array.isArray(condition.value) ? (condition.value as string[]) : [];
    if (ids.length === 0) return `${field.displayName} ${activeOp.label}`;
    const source = optionSourceFor(field, members);
    const labels = ids.map((id) => source.find((s) => s.id === id)?.label ?? id);
    return `${field.displayName} ${activeOp.label} ${labels.join(', ')}`;
  }
  // #429 — the single-value counterpart to 'options' (select/workflow/user
  // `eq`/`neq`, a scalar id rather than an array).
  if (activeOp.input === 'option') {
    const id = typeof condition.value === 'string' ? condition.value : '';
    if (!id) return `${field.displayName} ${activeOp.label}`;
    const source = optionSourceFor(field, members);
    const label = source.find((s) => s.id === id)?.label ?? id;
    return `${field.displayName} ${activeOp.label} ${label}`;
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
  const ops = opsForField(field);
  const activeOp = ops.find((o) => o.op === condition.op) ?? ops[0]!;

  return (
    <span className="flex items-center gap-1 rounded-[var(--radius-control)] border border-border-default bg-card px-1.5 py-0.5 text-label">
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
  db,
  viewId,
  filters,
  onChange,
  personalFilter,
}: {
  fields: Field[];
  members: Array<{ id: string; name: string }>;
  ws?: string;
  /** #259 — the Personal scope only exists once a real view is on the page. */
  db?: string;
  viewId?: string;
  filters: FilterGroup | undefined;
  onChange: (filters: FilterGroup | undefined) => void;
  /** #259 — current viewer's personal override for THIS view, if any. */
  personalFilter?: FilterNode;
}) {
  const [open, setOpen] = useState(false);
  const canUsePersonalScope = Boolean(ws && db && viewId);

  /**
   * #278 — while the builder is OPEN, edits go into a draft; they are committed
   * once, when it closes. Before this, every keystroke and every option tick
   * re-queried the view, so composing a filter thrashed the board (and, for the
   * Personal scope, fired a server mutation per edit).
   *
   * Buffered per scope because the two persist to different places. Pinned chips
   * live OUTSIDE this panel and deliberately keep applying immediately — they're
   * one-click toggles on an already-composed filter, which is the opposite
   * interaction.
   */
  type FilterDraft = { connector: FilterConnector; nodes: FilterNode[] } | null;
  const [draftGlobal, setDraftGlobal] = useState<FilterDraft>(null);
  const [draftPersonal, setDraftPersonal] = useState<FilterDraft>(null);

  const connector = filterConnector(filters);
  const nodes = filterConditions(filters);
  // MN-258: pinned chips + the active count read every LEAF condition in the tree,
  // not just the top level — a condition can be pinned from inside a nested group.
  const leaves = useMemo(
    () => flattenFilterTree(nodes).filter((f): f is typeof f & { node: FilterCondition } => !isFilterGroup(f.node)),
    [nodes],
  );
  /*
   * #965 — a chip exists only for a condition someone PINNED. Nothing is chipped by default: the Filter
   * button itself says "something is applied" (yellow), and the panel is one click away. #733's fix
   * stands (a third condition can never hide another): the chip set depends on `pinned` alone.
   */
  const visibleLeaves = visibleFilterChips(leaves);
  // #426's rule survives in the numbers below: the button counts what the user has BUILT, from the draft
  // while the panel is open (so it never under-reports what the panel shows), and the panel header says
  // "N of M applied" when some of it does not run yet (#425, #345).
  // #965 — what the button says, from what the user is LOOKING at (the draft while the panel is open,
  // the saved filters otherwise), so it never lags the panel it sits above.
  const buttonState = filterButtonState(
    draftGlobal ? buildFilterGroup(draftGlobal.connector, draftGlobal.nodes) : filters,
    draftPersonal ? buildFilterGroup(draftPersonal.connector, draftPersonal.nodes) : personalFilter,
  );

  function setNodes(next: FilterNode[]) {
    onChange(buildFilterGroup(connector, next));
  }

  /** What the panel renders: the draft while open, the saved tree otherwise. */
  const shownConnector = draftGlobal?.connector ?? connector;
  const shownNodes = draftGlobal?.nodes ?? nodes;
  function updateLeafAt(path: number[], next: FilterCondition) {
    setNodes(updateNodeAt(nodes, path, () => next));
  }

  // #259: the personal tree — pinning/labels don't apply to a personal override
  // (it never renders a toolbar chip; only the owner ever sees it), but it's the
  // SAME FilterNode shape, so the same connector/nodes/builder machinery applies.
  const personalGroup = personalFilter as FilterGroup | undefined;
  const personalConnector = filterConnector(personalGroup);
  const personalNodes = filterConditions(personalGroup);
  const setPersonal = useSetPersonalFilter(ws ?? '', db ?? '');
  const clearPersonal = useClearPersonalFilter(ws ?? '', db ?? '');
  function persistPersonalGroup(group: FilterGroup | undefined) {
    if (!viewId) return;
    if (group) setPersonal.mutate({ viewId, filter: group as never });
    else clearPersonal.mutate(viewId);
  }
  /** #278 — seed both drafts from what's saved, then open. */
  function openBuilder() {
    setDraftGlobal({ connector, nodes });
    setDraftPersonal({ connector: personalConnector, nodes: personalNodes });
    setOpen(true);
  }

  const changed = (a: unknown, b: unknown) => JSON.stringify(a) !== JSON.stringify(b);

  /**
   * #426 — APPLY AS YOU BUILD, debounced.
   *
   * This deliberately reverses #278's commit-on-close. That decision made every
   * other filter bug indistinguishable: "my condition is wrong", "it was
   * silently dropped" (#425), "the value never got set" (#422) and "it worked,
   * you just can't see it" all looked identical — you did something and nothing
   * changed. Measured on the live app: a correct `Name contains Tyron` left the
   * grid at 50 rows and the chip reading "1 filter" until the panel was
   * dismissed, at which point it became 7 rows and "2 filters".
   *
   * The panel is a live control over the view, not a form you submit — which is
   * also what the reference tool does.
   *
   * Debounced rather than immediate so typing a 20-character value issues one
   * query, not twenty. The draft stays the source of truth for what the INPUTS
   * show, so keystrokes never wait on a round-trip.
   *
   * Only a scope whose draft actually differs is written, so opening and closing
   * without editing still performs no mutation and no re-query.
   */
  const APPLY_DEBOUNCE_MS = 300;
  const liveGlobal = useDebouncedValue(draftGlobal, APPLY_DEBOUNCE_MS);
  const livePersonal = useDebouncedValue(draftPersonal, APPLY_DEBOUNCE_MS);

  useEffect(() => {
    if (!liveGlobal) return;
    if (changed(liveGlobal.nodes, nodes) || liveGlobal.connector !== connector) {
      onChange(buildFilterGroup(liveGlobal.connector, liveGlobal.nodes));
    }
    // `nodes`/`connector` are intentionally NOT dependencies: they change as a
    // RESULT of this commit, and including them would re-fire the effect on the
    // echo of its own write. (exhaustive-deps is off repo-wide, so there is no
    // directive to suppress — this comment is the record of the decision.)
  }, [liveGlobal]);

  useEffect(() => {
    if (!livePersonal) return;
    if (changed(livePersonal.nodes, personalNodes) || livePersonal.connector !== personalConnector) {
      persistPersonalGroup(buildFilterGroup(livePersonal.connector, livePersonal.nodes));
    }
    // Same reasoning as the global effect above.
  }, [livePersonal]);

  /**
   * Closing flushes anything the debounce has not yet written, so a fast
   * click-away cannot lose the last edit — the failure #278 was protecting
   * against, kept without keeping commit-on-close.
   */
  function closeBuilder() {
    if (draftGlobal && (changed(draftGlobal.nodes, nodes) || draftGlobal.connector !== connector)) {
      onChange(buildFilterGroup(draftGlobal.connector, draftGlobal.nodes));
    }
    if (
      draftPersonal &&
      (changed(draftPersonal.nodes, personalNodes) || draftPersonal.connector !== personalConnector)
    ) {
      persistPersonalGroup(buildFilterGroup(draftPersonal.connector, draftPersonal.nodes));
    }
    setDraftGlobal(null);
    setDraftPersonal(null);
    setOpen(false);
  }

  return (
    <>
      {visibleLeaves.map((leaf) => {
        const field = fields.find((f) => f.apiName === leaf.node.field);
        if (!field) return null;
        return (
          <PinnedFilterChip
            key={leaf.id}
            field={field}
            condition={leaf.node}
            members={members}
            onOpenBuilder={openBuilder}
            onUnpin={() => updateLeafAt(leaf.path, { ...leaf.node, pinned: false })}
          />
        );
      })}
      <span className="relative">
        <button
          type="button"
          onClick={() => (open ? closeBuilder() : openBuilder())}
          aria-label={
            buttonState.yellow
              ? `Filter, ${buttonState.applied} applied${buttonState.personalOn ? ', including your personal filter' : ''}`
              : 'Filter'
          }
          className={cn(
            'flex items-center gap-1 rounded-[var(--radius-control)] border px-1.5 py-1 text-label hover:bg-hover',
            // #965 — YELLOW whenever any condition is applied (the view's or your personal one, pinned
            // included). Disabled and unfinished conditions hide nothing, so they do not turn it on.
            buttonState.yellow
              ? 'border-[var(--accent)] bg-accent-soft text-ink'
              : 'border-transparent text-muted',
          )}
        >
          <ListFilter className="h-3.5 w-3.5" />
          Filter
          {/* The count: applied conditions that are not already chips. A pinned one is its own chip. */}
          {buttonState.buttonCount > 0 && (
            <span className="tabular-nums text-ink">{buttonState.buttonCount}</span>
          )}
          {/* A person mark while the personal filter is on; it replaces the old standing chip (#259). */}
          {buttonState.personalOn && (
            <UserRound className="h-3 w-3" aria-hidden />
          )}
        </button>
        {open && (
          <>
            {/* A full-screen backdrop, not a document click-outside listener: the
                panel below nests Radix dropdowns (option pickers, the "…" menu)
                that portal outside this subtree, so contains()-based outside-click
                detection would misfire and close the builder mid-interaction. */}
            {/* #278 — clicking away closes AND commits the draft. */}
            <div className="fixed inset-0 z-[var(--z-overlay-backdrop)]" onClick={closeBuilder} />
            {/*
              #429 — GLOBAL AND PERSONAL, VISIBLE AT ONCE. Otto's ruling,
              verbatim: "the effective filter is the thing a user needs to
              READ, and tabs hide half of it". This used to be a single
              FilterBuilderPanel whose tree depended on a `scope` toggle;
              it is now always both, stacked, each labelled — reading the
              popover top to bottom IS reading the effective filter.
            */}
            <div className="absolute left-0 top-full z-[var(--z-overlay)] mt-1 max-h-[70vh] w-[26rem] max-w-[calc(100vw-2rem)] overflow-y-auto rounded-[var(--radius-card)] border border-border-default bg-card shadow-[var(--shadow-popover)]">
              {/* #965 — "N of M applied" lives here now, not on the button: M is every condition built
                  (either section), N the ones that actually run (not disabled, not unfinished). */}
              {buttonState.configured > 0 && (
                <p className="border-b border-border-default px-3 py-1.5 text-meta text-muted" aria-live="polite">
                  {buttonState.applied} of {buttonState.configured} applied
                </p>
              )}
              <FilterBuilderPanel
                sectionLabel="Everyone"
                sectionHint="The view's filter. Every viewer sees this."

                fields={fields}
                members={members}
                ws={ws}
                connector={shownConnector}
                nodes={shownNodes}
                onNodesChange={(next) => setDraftGlobal({ connector: shownConnector, nodes: next })}
                onConnectorChange={(next) => setDraftGlobal({ connector: next, nodes: shownNodes })}
                onClearAll={() => setDraftGlobal({ connector: shownConnector, nodes: [] })}
              />
              {canUsePersonalScope && (
                <div className="border-t border-border-default">
                  <FilterBuilderPanel
                    sectionLabel="Only you"
                    fields={fields}
                    members={members}
                    ws={ws}
                    connector={draftPersonal?.connector ?? personalConnector}
                    nodes={draftPersonal?.nodes ?? personalNodes}
                    onNodesChange={(next) =>
                      setDraftPersonal({ connector: draftPersonal?.connector ?? personalConnector, nodes: next })
                    }
                    onConnectorChange={(next) =>
                      setDraftPersonal({ connector: next, nodes: draftPersonal?.nodes ?? personalNodes })
                    }
                    personalScopeHint
                  />
                </div>
              )}
            </div>
          </>
        )}
      </span>
    </>
  );
}

/**
 * #426 — debounce any value, not just a string.
 *
 * command-palette.tsx has a string-only `useDebounced`; this one is generic so
 * the whole draft (connector + node tree) can be debounced as a unit. Kept here
 * rather than generalising that one, which would drag an unrelated component
 * into this change.
 */
function useDebouncedValue<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return debounced;
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
        'flex items-center gap-1 rounded-[var(--radius-control)] border border-border-default bg-card px-1.5 py-0.5 text-label',
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

/** The builder popover's body: "Where" + condition/group rows (draggable, And/Or
 * between them at every level), + add-condition, + an empty state and a help link
 * (MN-253 flat; MN-258 nested groups). One `DndContext` and one flat
 * `SortableContext` cover the WHOLE tree (path-addressed ids, e.g. "2.0.1") —
 * reusing the exact dnd-kit setup MN-253 shipped rather than a second drag
 * pattern per nesting level; `onDragEnd` resolves the drop into a tree op
 * (`moveNodeTo`) instead of a flat array index swap. */
/**
 * MN-295: exported so the Rollup field-config UI (add-field-dialog.tsx /
 * edit-field-dialog.tsx) can reuse this SAME condition-tree builder for a
 * rollup's filter, rather than a second filter-condition UI. Everything else
 * about it (row rendering, drag-to-reorder, group nesting) is unchanged —
 * a caller outside the view toolbar just drives `nodes`/`connector` from its
 * own local state instead of a persisted `ViewConfig.filters`.
 */
export function FilterBuilderPanel({
  fields,
  members,
  ws,
  connector,
  nodes,
  onNodesChange,
  onConnectorChange,
  personalScopeHint,
  sectionLabel,
  sectionHint,
  onClearAll,
}: {
  fields: Field[];
  members: Array<{ id: string; name: string }>;
  ws?: string;
  connector: FilterConnector;
  nodes: FilterNode[];
  onNodesChange: (next: FilterNode[]) => void;
  onConnectorChange: (next: FilterConnector) => void;
  /** #259 — true when this instance is editing the PERSONAL tree, not the
   * shared view's. Swaps the copy so "no filters yet" doesn't read as if it's
   * describing the (possibly non-empty) shared view. */
  personalScopeHint?: boolean;
  /**
   * #429 — Global and Personal render as two labelled sections of ONE panel
   * now, not two tabs of the same panel (the effective filter has to be
   * readable without toggling). This names which section's header to show
   * instead of the old generic "Filters" — omit it to keep standalone callers
   * (the rollup field-config reuse, MN-295) exactly as they were.
   */
  sectionLabel?: string;
  /** #965 — one line under the section header saying who sees this section. */
  sectionHint?: string;
  /** #429 — Global's header gets a "Clear all", matching Fibery's panel. Only
   * meaningful (and only rendered) when there's something to clear. */
  onClearAll?: () => void;
}) {
  const sensors = useSortableSensors();
  const flat = useMemo(() => flattenFilterTree(nodes), [nodes]);

  function addCondition(field: Field) {
    const first = opsForField(field)[0]!;
    onNodesChange([...nodes, { field: field.apiName, op: first.op, value: defaultValueFor(first.input) }]);
  }

  function onDragEnd(e: DragEndEvent) {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const from = pathFromId(String(active.id));
    let to = pathFromId(String(over.id));
    // Dropping ONTO a group's own header row nests the dragged node as that
    // group's first child, rather than swapping places with the group itself.
    const overNode = getNodeAt(nodes, to);
    if (overNode && isFilterGroup(overNode)) to = [...to, 0];
    if (!canMoveNodeTo(nodes, from, to)) {
      toast.error('Filter groups can only nest 3 levels deep');
      return;
    }
    onNodesChange(moveNodeTo(nodes, from, to));
  }

  // #656 — path-addressed ids ("2.0.1") fail #415's readable-announcement intent
  // exactly as badly as a raw uuid, so the label reads the SAME node summary a
  // group/condition row shows itself: a group has no field, a condition reuses
  // describeCondition (or its own custom label, same precedence ConditionRow uses).
  const filterLabel = (id: string) => {
    const entry = flat.find((f) => f.id === id);
    if (!entry) return undefined;
    const node = entry.node;
    if (isFilterGroup(node)) return 'Filter group';
    const field = fields.find((f) => f.apiName === node.field);
    if (!field) return undefined;
    return node.label ?? describeCondition(field, node, members);
  };
  const filterDrag = useDragPresentation(filterLabel, { onDragEnd }, flat.map((f) => f.id));

  return (
    <div className="flex flex-col">
      <div className="flex items-center justify-between border-b border-border-default px-3 py-2">
        <span className="text-meta font-semibold uppercase tracking-wider text-muted">
          {sectionLabel ?? 'Filters'}
        </span>
        <span className="flex items-center gap-2">
          {onClearAll && nodes.length > 0 && (
            <button type="button" onClick={onClearAll} className="text-meta text-muted hover:text-ink">
              Clear all
            </button>
          )}
          <a
            href="https://docs.storyos.dev/concepts/views/#filters--sorts"
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-1 text-faint hover:text-ink"
            title="How filters work on views"
          >
            <CircleHelp className="h-3.5 w-3.5" />
          </a>
        </span>
      </div>

      {sectionHint && (
        <p className="border-b border-border-default px-3 py-1.5 text-meta text-muted">{sectionHint}</p>
      )}
      {personalScopeHint && (
        <p className="border-b border-border-default px-3 py-1.5 text-meta text-muted">
          A personal filter. It narrows this view for you only; teammates don't see it.
        </p>
      )}

      {nodes.length === 0 ? (
        <div className="px-3 py-6 text-center">
          <p className="mb-2 text-label text-muted">
            {personalScopeHint
              ? 'No personal filter yet — narrow this view down further, just for you.'
              : 'No filters yet — narrow this view down to what matters.'}
          </p>
          <div className="flex justify-center">
            <AddFilterButton fields={fields} onAdd={addCondition} label="Add your first filter" />
          </div>
        </div>
      ) : (
        <div className="max-h-80 overflow-y-auto p-1">
          <DndContext sensors={sensors} collisionDetection={closestCenter} {...filterDrag.contextProps}>
            <SortableContext items={flat.map((f) => f.id)} strategy={verticalListSortingStrategy}>
              {nodes.map((node, i) => (
                <FilterNodeRow
                  key={i}
                  path={[i]}
                  node={node}
                  fields={fields}
                  members={members}
                  ws={ws}
                  connector={connector}
                  isFirst={i === 0}
                  onConnectorChange={onConnectorChange}
                  rootNodes={nodes}
                  onRootChange={onNodesChange}
                />
              ))}
            </SortableContext>
            <DragPreview>
              {filterDrag.activeId && (
                <div className="rounded-[var(--radius-control)] border border-border-default bg-card px-2 py-1 text-label font-medium text-ink shadow-[var(--shadow-lifted)]">
                  {filterLabel(filterDrag.activeId) ?? ''}
                </div>
              )}
            </DragPreview>
          </DndContext>
        </div>
      )}

      {nodes.length > 0 && (
        <div className="border-t border-border-default p-1">
          <AddFilterButton fields={fields} onAdd={addCondition} label="Add condition" />
        </div>
      )}

    </div>
  );
}

function ConnectorToggle({ value, onChange }: { value: FilterConnector; onChange: (v: FilterConnector) => void }) {
  return (
    <span className="inline-flex overflow-hidden rounded-[var(--radius-control)] border border-border-default text-micro font-semibold uppercase leading-none">
      {(['and', 'or'] as const).map((c) => (
        <button
          key={c}
          type="button"
          onClick={() => onChange(c)}
          className={cn('px-1.5 py-0.5', value === c ? 'bg-accent-soft text-ink' : 'text-muted hover:text-ink')}
        >
          {c}
        </button>
      ))}
    </span>
  );
}

/** Dispatches a tree node to its row renderer (MN-258): a leaf condition gets the
 * MN-253 row, a nested group gets its own header + recursively rendered contents.
 * Every op (duplicate/remove/turn-into-group/…) is expressed against `rootNodes` +
 * `path` here, so both renderers share the exact same tree-mutation primitives. */
function FilterNodeRow({
  path,
  node,
  fields,
  members,
  ws,
  connector,
  isFirst,
  onConnectorChange,
  rootNodes,
  onRootChange,
}: {
  path: number[];
  node: FilterNode;
  fields: Field[];
  members: Array<{ id: string; name: string }>;
  ws?: string;
  connector: FilterConnector;
  isFirst: boolean;
  onConnectorChange: (next: FilterConnector) => void;
  rootNodes: FilterNode[];
  onRootChange: (next: FilterNode[]) => void;
}) {
  if (isFilterGroup(node)) {
    return (
      <GroupRow
        path={path}
        node={node}
        fields={fields}
        members={members}
        ws={ws}
        connector={connector}
        isFirst={isFirst}
        onConnectorChange={onConnectorChange}
        rootNodes={rootNodes}
        onRootChange={onRootChange}
      />
    );
  }
  return (
    <ConditionRow
      path={path}
      condition={node}
      fields={fields}
      members={members}
      ws={ws}
      connector={connector}
      isFirst={isFirst}
      onConnectorChange={onConnectorChange}
      onChange={(next) => onRootChange(updateNodeAt(rootNodes, path, () => next))}
      onDuplicate={() => onRootChange(duplicateNodeAt(rootNodes, path))}
      onPin={() => onRootChange(updateNodeAt(rootNodes, path, () => ({ ...node, pinned: !node.pinned })))}
      onRemove={() => onRootChange(removeNodeCascade(rootNodes, path))}
      canTurnIntoGroup={canTurnIntoGroup(rootNodes, path)}
      onTurnIntoGroup={() => onRootChange(turnIntoGroup(rootNodes, path, 'and'))}
    />
  );
}

/** A nested group's row (MN-258): its own header (Where/connector, drag handle,
 * "…" menu) plus its children rendered recursively inside an indented box, each
 * with the group's OWN connector — "A and (B or C)" is a top-level `and` row and
 * a nested `or` group in exactly this shape. */
function GroupRow({
  path,
  node,
  fields,
  members,
  ws,
  connector,
  isFirst,
  onConnectorChange,
  rootNodes,
  onRootChange,
}: {
  path: number[];
  node: FilterGroup;
  fields: Field[];
  members: Array<{ id: string; name: string }>;
  ws?: string;
  connector: FilterConnector;
  isFirst: boolean;
  onConnectorChange: (next: FilterConnector) => void;
  rootNodes: FilterNode[];
  onRootChange: (next: FilterNode[]) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: path.join('.'),
  });
  const children = nodeChildren(node);
  const innerConnector = nodeConnector(node);

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(
        'group relative rounded px-1 py-1.5',
        // #656 — the dragged content now floats in the shared DragPreview
        // overlay, so this slot never competes for stacking order; it only
        // needs to mark itself as vacated (#409/#631).
        vacatedSlotClass(isDragging),
      )}
    >
      <div className="flex items-start gap-1.5">
        <button
          type="button"
          {...attributes}
          {...listeners}
          className="mt-1.5 shrink-0 cursor-grab text-faint opacity-0 hover:text-muted focus-visible:opacity-100 group-hover:opacity-100"
          title="Drag to reorder"
        >
          <GripVertical className="h-3.5 w-3.5" />
        </button>

        <div className="min-w-0 flex-1">
          <div className="mb-1">
            {isFirst ? (
              <span className="text-meta font-semibold uppercase tracking-wider text-muted">Where</span>
            ) : (
              <ConnectorToggle value={connector} onChange={onConnectorChange} />
            )}
          </div>

          <div className="rounded border border-dashed border-border-default py-1 pl-2 pr-1">
            {children.map((child, j) => (
              <FilterNodeRow
                key={j}
                path={[...path, j]}
                node={child}
                fields={fields}
                members={members}
                ws={ws}
                connector={innerConnector}
                isFirst={j === 0}
                onConnectorChange={(next) =>
                  onRootChange(updateNodeAt(rootNodes, path, () => buildFilterGroup(next, children)!))
                }
                rootNodes={rootNodes}
                onRootChange={onRootChange}
              />
            ))}
          </div>
        </div>

        <GroupMenu
          onDuplicate={() => onRootChange(duplicateNodeAt(rootNodes, path))}
          onUngroup={() => onRootChange(ungroupNodeAt(rootNodes, path))}
          onRemove={() => onRootChange(removeNodeCascade(rootNodes, path))}
        />
      </div>
    </div>
  );
}

function ConditionRow({
  path,
  condition,
  fields,
  members,
  ws,
  connector,
  isFirst,
  onConnectorChange,
  onChange,
  onDuplicate,
  onPin,
  onRemove,
  canTurnIntoGroup,
  onTurnIntoGroup,
}: {
  path: number[];
  condition: FilterCondition;
  fields: Field[];
  members: Array<{ id: string; name: string }>;
  ws?: string;
  connector: FilterConnector;
  isFirst: boolean;
  onConnectorChange: (next: FilterConnector) => void;
  onChange: (next: FilterCondition) => void;
  onDuplicate: () => void;
  onPin: () => void;
  onRemove: () => void;
  canTurnIntoGroup: boolean;
  onTurnIntoGroup: () => void;
}) {
  const [editingLabel, setEditingLabel] = useState(false);
  const [pickingIcon, setPickingIcon] = useState(false);
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: path.join('.'),
  });
  const field = fields.find((f) => f.apiName === condition.field);
  if (!field) return null;
  const ops = opsForField(field);
  const activeOp = ops.find((o) => o.op === condition.op) ?? ops[0]!;
  const Icon = fieldTypeIcon(field.type);
  const defaultLabel = describeCondition(field, condition, members);

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(
        'group relative rounded px-1 py-1.5',
        // #656 — the dragged content now floats in the shared DragPreview
        // overlay, so this slot never competes for stacking order; it only
        // needs to mark itself as vacated (#409/#631).
        vacatedSlotClass(isDragging),
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

        {/*
          #429 — Otto's ruling on Q2/Q6, verbatim: "a disabled condition that
          looks identical to an enabled one is SILENT WRONGNESS - the user
          reads a filter that is not the filter being applied - so its state
          has to be visible, not merely reachable." This used to be reachable
          only through the "..." menu's Disable/Enable item (a state nobody
          would notice without opening it); it's a persistent toggle on the
          row now, and the menu item is gone rather than duplicated.
        */}
        <button
          type="button"
          onClick={() => onChange({ ...condition, disabled: !condition.disabled })}
          className={cn('mt-1.5 shrink-0 rounded p-0.5 hover:bg-hover', condition.disabled ? 'text-faint' : 'text-ink')}
          title={condition.disabled ? 'Disabled — click to enable' : 'Enabled — click to disable'}
        >
          {condition.disabled ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
        </button>

        <div className="min-w-0 flex-1">
          <div className="mb-1">
            {isFirst ? (
              <span className="text-meta font-semibold uppercase tracking-wider text-muted">Where</span>
            ) : (
              <ConnectorToggle value={connector} onChange={onConnectorChange} />
            )}
          </div>
          <div className={cn('flex flex-wrap items-center gap-1', condition.disabled && 'opacity-50')}>
            <EntityIcon icon={condition.icon} color={null} size={13} fallback={<Icon className="h-3.5 w-3.5 shrink-0 text-faint" />} />
            <select
              className="max-w-28 truncate rounded-[var(--radius-control)] border border-border-default bg-card px-1 py-0.5 text-label text-ink"
              value={condition.field}
              onChange={(e) => {
                const nextField = fields.find((f) => f.apiName === e.target.value);
                if (!nextField) return;
                const next = remapConditionToField(condition, nextField);
                if (next) onChange(next);
              }}
            >
              {fields.map((f) => (
                <option key={f.id} value={f.apiName}>
                  {f.displayName}
                </option>
              ))}
            </select>
            <select
              className="rounded-[var(--radius-control)] border border-border-default bg-card px-1 py-0.5 text-label text-muted"
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
            <div className="mt-1.5 flex items-center gap-1.5 rounded-[var(--radius-control)] border border-border-default bg-app p-1.5">
              <Popover open={pickingIcon} onOpenChange={setPickingIcon}>
                <Tooltip label="Change icon">
                  <PopoverTrigger asChild>
                    <button
                      type="button"
                      className="flex h-6 w-6 shrink-0 items-center justify-center rounded-[var(--radius-control)] border border-border-default hover:bg-hover"
                      aria-label="Change icon"
                    >
                      <EntityIcon icon={condition.icon} color={null} size={13} fallback={<Icon className="h-3.5 w-3.5 text-faint" />} />
                    </button>
                  </PopoverTrigger>
                </Tooltip>
                <PopoverContent align="start" className="p-2" onClick={(e) => e.stopPropagation()}>
                  <IconColorPicker
                    icon={condition.icon ?? null}
                    color={null}
                    onChange={(patch) => {
                      if ('icon' in patch) onChange({ ...condition, icon: patch.icon ?? undefined });
                    }}
                  />
                </PopoverContent>
              </Popover>
              <input
                autoFocus
                className="h-6 flex-1 rounded-[var(--radius-control)] border border-border-default bg-card px-1.5 text-label text-ink outline-none"
                placeholder={defaultLabel}
                value={condition.label ?? ''}
                onChange={(e) => onChange({ ...condition, label: e.target.value || undefined })}
              />
              <button
                type="button"
                className="text-meta text-muted hover:text-ink"
                onClick={() => {
                  setEditingLabel(false);
                  setPickingIcon(false);
                }}
              >
                Done
              </button>
            </div>
          )}
          {/*
            #425 — an unfinished condition says so, instead of looking valid.
            
            A row with no value is KEPT (the persistence path has always
            preserved it — the schema accepts it, cleanFilterNode keeps it,
            buildFilterGroup keeps it) but it is excluded from the query by
            #345's rule. Unlabelled, that is indistinguishable from a condition
            that is simply not working, which is the ambiguity #426 is about.
            
            `is_empty` / `not_empty` legitimately carry no value and must never
            be marked — isIncompleteCondition already encodes that, so this
            reads it rather than re-deriving emptiness here.
          */}
          {isIncompleteCondition(condition) && !condition.disabled && (
            <p className="mt-0.5 text-meta text-warning">Needs a value — not applied yet</p>
          )}
        </div>

        <ConditionMenu
          condition={condition}
          onDuplicate={onDuplicate}
          onPin={onPin}
          onEditNameIcon={() => setEditingLabel((v) => !v)}
          onRemove={onRemove}
          canTurnIntoGroup={canTurnIntoGroup}
          onTurnIntoGroup={onTurnIntoGroup}
        />
      </div>
    </div>
  );
}

/** Per-clause "…" menu (MN-253 base; MN-258 wires up "Turn into group" for real).
 * Depth/condition caps (packages/schemas' filterSchema, mirrored in
 * filter-config.ts) are enforced client-side via `canTurnIntoGroup` — disabled +
 * tooltipped rather than a 422 on save once a clause is already 3 levels deep. */
function ConditionMenu({
  condition,
  onDuplicate,
  onPin,
  onEditNameIcon,
  onRemove,
  canTurnIntoGroup,
  onTurnIntoGroup,
}: {
  condition: FilterCondition;
  onDuplicate: () => void;
  onPin: () => void;
  onEditNameIcon: () => void;
  onRemove: () => void;
  canTurnIntoGroup: boolean;
  onTurnIntoGroup: () => void;
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
        <DropdownMenuItem
          disabled={!canTurnIntoGroup}
          className={cn(!canTurnIntoGroup && 'opacity-50')}
          title={canTurnIntoGroup ? undefined : 'Filter groups can only nest 3 levels deep'}
          onSelect={onTurnIntoGroup}
        >
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

/** A group's own "…" menu (MN-258): duplicate the whole group (deep copy),
 * ungroup (flatten its children back into the parent level), or remove the
 * group and everything inside it. */
function GroupMenu({
  onDuplicate,
  onUngroup,
  onRemove,
}: {
  onDuplicate: () => void;
  onUngroup: () => void;
  onRemove: () => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" className="mt-1 shrink-0 rounded p-0.5 text-faint hover:bg-active hover:text-ink" title="More">
          <MoreHorizontal className="h-3.5 w-3.5" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-44">
        <DropdownMenuItem onSelect={onDuplicate}>
          <Copy className="h-3.5 w-3.5" /> Duplicate group
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onUngroup}>
          <Ungroup className="h-3.5 w-3.5" /> Ungroup
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem className="text-error" onSelect={onRemove}>
          <Trash2 className="h-3.5 w-3.5" /> Remove group
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Multi-select value picker for `is any of` / `is none of` on a select, multi-select,
 * or user field. Selected values render as removable chips inline (Fibery parity);
 * the dropdown carries a search box over a scrollable, checkable option list so a
 * long option/member set stays usable. Option ids (including the dynamic `'me'`) are
 * stored verbatim — this is a pure `string[]` editor, unaware of what the ids mean.
 */
function OptionMultiPick({
  options,
  selected,
  onChange,
}: {
  options: Array<{ id: string; label: string; icon?: string | null; color?: string }>;
  selected: string[];
  onChange: (ids: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const selectedOptions = selected.map((id) => options.find((o) => o.id === id) ?? { id, label: id });
  const q = search.trim().toLowerCase();
  const filtered = q ? options.filter((o) => o.label.toLowerCase().includes(q)) : options;

  function toggle(id: string) {
    onChange(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);
  }

  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      {selectedOptions.map((option) => (
        <span
          key={option.id}
          className="inline-flex items-center gap-1 rounded-[var(--radius-control)] border border-border-default bg-hover px-1.5 py-0.5 text-label text-ink"
        >
          {/* #215: through the shared OptionIcon, tinted with the option's own
              colour — not a re-implementation of "how do I draw an icon ref". */}
          <span className="flex items-center" style={optionTint(option.color)}>
            <OptionIcon icon={option.icon} />
          </span>
          <span className="max-w-32 truncate">{option.label}</span>
          <button
            type="button"
            onClick={() => toggle(option.id)}
            className="text-faint hover:text-error"
            title="Remove"
          >
            <X className="h-3 w-3" />
          </button>
        </span>
      ))}
      <DropdownMenu open={open} onOpenChange={(o) => { setOpen(o); if (!o) setSearch(''); }}>
        <DropdownMenuTrigger asChild>
          <button type="button" className={cn('text-left', selected.length ? 'text-muted hover:text-ink' : 'text-muted')}>
            {selected.length ? '+ add' : 'pick…'}
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent className="w-56 p-0">
          <div className="flex items-center gap-1.5 border-b border-border-default px-2 py-1.5">
            <Search className="h-3.5 w-3.5 shrink-0 text-faint" />
            <input
              autoFocus
              placeholder="Search…"
              className="w-full bg-transparent text-body text-ink outline-none placeholder:text-muted"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              // Radix menus run a typeahead off keydown; let the input own its keys.
              onKeyDown={(e) => e.stopPropagation()}
            />
          </div>
          <div className="max-h-56 overflow-y-auto p-1">
            {filtered.map((option) => (
              <label
                key={option.id}
                className="flex items-center gap-2 rounded px-2 py-1.5 text-body text-ink hover:bg-hover"
              >
                <input
                  type="checkbox"
                  checked={selected.includes(option.id)}
                  onChange={() => toggle(option.id)}
                />
                <span className="flex items-center" style={optionTint(option.color)}>
                  <OptionIcon icon={option.icon} />
                </span>
                <span className="truncate">{option.label}</span>
              </label>
            ))}
            {filtered.length === 0 && <p className="px-2 py-1.5 text-label text-muted">No matches.</p>}
          </div>
        </DropdownMenuContent>
      </DropdownMenu>
    </span>
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
  const targetDb = field.relation?.target_database_id ?? '';

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

  // #276: render the dropdown in a portal (Popover) rather than a plain
  // `absolute` div. The filter builder's condition list is an overflow-y-auto
  // scroll container (FilterBuilderPanel), which CLIPPED the old inline dropdown
  // — leaving a cramped, barely-clickable sliver. A portaled Popover escapes
  // that clip, so options render full-size and the whole row is clickable.
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn('max-w-40 truncate text-left', selected.length ? 'text-ink' : 'text-muted')}
        >
          {label}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 p-0" onClick={(e) => e.stopPropagation()}>
        {selected.length > 0 && (
          <div className="flex flex-wrap gap-1 border-b border-border-default p-2">
            {selected.map((id) => (
              <span
                key={id}
                className="inline-flex items-center gap-1 rounded-[var(--radius-control)] border border-border-default bg-hover px-1.5 py-0.5 text-label text-ink"
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
          className="w-full border-b border-border-default bg-card px-3 py-2 text-body text-ink outline-none placeholder:text-muted"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          // Keep keystrokes in the box — the popover mustn't treat them as typeahead.
          onKeyDown={(e) => e.stopPropagation()}
        />
        <div className="max-h-56 overflow-y-auto p-1">
          {(results.data ?? []).map((row) => (
            <button
              key={row.id}
              className={cn(
                'flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-body text-ink hover:bg-hover',
                selected.includes(row.id) && 'bg-hover',
              )}
              onClick={() => toggle(row.id)}
            >
              <span className="truncate">{row.title || 'Untitled'}</span>
              {selected.includes(row.id) && <Check className="h-3.5 w-3.5 text-accent" />}
            </button>
          ))}
          {results.data?.length === 0 && (
            <p className="px-2 py-1.5 text-label text-muted">No matches.</p>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

/**
 * The sort builder (MN-252): multi-key precedence, drag-reorder, and a whole-sort
 * empty-values placement toggle. Rebuilt on #253's filter-builder conventions — a
 * hand-rolled popover (not DropdownMenu) with a full-screen backdrop instead of a
 * contains()-based outside-click listener, since dnd-kit's drag sensor doesn't play
 * well inside a Radix menu (see FiltersSection's comment for the same reasoning).
 *
 * `fields` is the view's FULL field list, not pre-filtered — the builder narrows to
 * SORTABLE itself (mirroring the query layer's SORTABLE set in records.service.ts),
 * further narrowed for formula fields by isSortableFormula (MN-260/MN-267 — a
 * formula that reaches into a `lookup` isn't materialized; one reaching into a
 * `rollup` now is) instead of silently omitting those fields from view.
 */
export function SortButton({
  fields,
  sorts,
  nulls,
  onChange,
  onNullsChange,
  // #583 — a scheduled automation's top-N sort has no nulls-placement concept
  // server-side (automationSortSchema is bare {field, direction}[], no whole-
  // sort empty-values setting). Hiding the section is cheaper and more honest
  // than rendering a toggle that would silently do nothing when clicked.
  showNulls = true,
  emptyLabel = 'Sort',
}: {
  /** #930 — what the button says while no sort is set. A record view passes "Manual order": with no sort the server returns position order, and a bare "Sort" left a list that runs 925, 924, 919, 915… looking unordered. */
  emptyLabel?: string;
  fields: Field[];
  sorts: SortSpec[];
  nulls?: NullsPlacement;
  onChange: (sorts: SortSpec[]) => void;
  onNullsChange: (nulls: NullsPlacement | undefined) => void;
  showNulls?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const byApiName = new Map(fields.map((f) => [f.apiName, f]));
  const sortableFields = fields.filter(
    (f) =>
      SORTABLE.has(f.type) &&
      isSortableFormula(f, byApiName) &&
      // #662/#680 — a MULTI user or relation field has no single value to order
      // by; offering it here would just 422 at save time (validateSorts,
      // records.service.ts's identical `(user || relation) && config.multi` check —
      // #680 found this picker was still missing the `relation` half of it).
      !((f.type === 'user' || f.type === 'relation') && f.config['multi'] === true) &&
      // #743 — a deprecated system field (`number`) must never be offered as a
      // NEW sort key. `byApiName` above stays unfiltered so an EXISTING sort
      // key still referencing it resolves its label correctly via `sortLabel`.
      isPickableField(f),
  );
  // MN-267: rollup is sortable now (real recompute-on-related-record-change
  // plumbing exists, so it's in SORTABLE_FIELD_TYPES); `lookup` is the one
  // still fully excluded (not in that shared list at all), and a formula
  // reaching into one inherits that same cross-record staleness and is
  // excluded too — see isSortableFormula above.
  const hasUnsortableComputedFields = fields.some(
    (f) => f.type === 'lookup' || (f.type === 'formula' && !isSortableFormula(f, byApiName)),
  );
  const sensors = useSortableSensors();

  function updateAt(i: number, next: SortSpec) {
    onChange(sorts.map((s, j) => (j === i ? next : s)));
  }
  function removeAt(i: number) {
    onChange(sorts.filter((_, j) => j !== i));
  }
  function addSort() {
    const field = nextSortField(sorts, sortableFields);
    if (!field) return;
    onChange([...sorts, { field: field.apiName, direction: 'asc' }]);
  }
  function onDragEnd(e: DragEndEvent) {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    onChange(reorderSorts(sorts, Number(active.id), Number(over.id)));
  }
  const canAddMore = sorts.length < MAX_SORTS && nextSortField(sorts, sortableFields) !== undefined;
  // #656 — a sort key is index-addressed ("0", "1"), which reads no better than
  // a raw id to a screen reader; name the field it actually sorts by instead.
  const sortLabel = (id: string) => byApiName.get(sorts[Number(id)]?.field ?? '')?.displayName;
  const sortDrag = useDragPresentation(
    sortLabel,
    { onDragEnd },
    sorts.map((_, i) => String(i)),
  );
  // #814 — this popover is a hand-rolled backdrop, not Radix, so it did not
  // inherit Escape-to-close. Esc during a keyboard drag belongs to dnd-kit
  // (it cancels the lift), so only close when no drag is active.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !sortDrag.activeId) {
        // #834 — claim it, so the record behind this popover does not also close.
        e.preventDefault();
        setOpen(false);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  });

  return (
    <span className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={cn(
          'flex items-center gap-1 rounded px-1.5 py-1 text-label hover:bg-hover',
          sorts.length ? 'text-ink' : 'text-muted',
        )}
      >
        <ArrowUpDown className="h-3.5 w-3.5" />
        {sorts.length ? `Sorted by ${sorts.length}` : emptyLabel}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-[var(--z-overlay-backdrop)]" onClick={() => setOpen(false)} />
          <div className="absolute left-0 top-full z-[var(--z-overlay)] mt-1 w-72 max-w-[calc(100vw-2rem)] rounded-[var(--radius-card)] border border-border-default bg-card shadow-[var(--shadow-popover)]">
            <div className="flex items-center justify-between border-b border-border-default px-3 py-2">
              {/* #427 — "Sort" read as if it sorted the board. It sorts CARDS; column
                  order lives in the Filter panel's Groups section. The old label is
                  why this was filed as a bug rather than a missing feature. */}
              <span className="text-meta font-semibold uppercase tracking-wider text-muted">Sort cards</span>
              <a
                href="https://docs.storyos.dev/concepts/views/#filters--sorts"
                target="_blank"
                rel="noreferrer"
                className="flex items-center gap-1 text-faint hover:text-ink"
                title="How sorting works on views"
              >
                <CircleHelp className="h-3.5 w-3.5" />
              </a>
            </div>

            {hasUnsortableComputedFields && (
              <p className="border-b border-border-default px-3 py-1.5 text-meta text-muted">
                Lookup fields, and formulas that reference a lookup, aren't sortable yet.
              </p>
            )}

            {sorts.length === 0 ? (
              <div className="px-3 py-6 text-center">
                <p className="mb-2 text-label text-muted">No sort yet — items show in manual order.</p>
                <button
                  type="button"
                  onClick={addSort}
                  disabled={sortableFields.length === 0}
                  className="mx-auto flex items-center gap-1 rounded px-1.5 py-1 text-label text-muted hover:text-ink disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <Plus className="h-3.5 w-3.5" /> Add your first sort
                </button>
              </div>
            ) : (
              <div className="max-h-64 overflow-y-auto p-1">
                <DndContext sensors={sensors} collisionDetection={closestCenter} {...sortDrag.contextProps}>
                  <SortableContext items={sorts.map((_, i) => String(i))} strategy={verticalListSortingStrategy}>
                    {sorts.map((sort, i) => (
                      <SortRow
                        key={i}
                        index={i}
                        sort={sort}
                        sorts={sorts}
                        fields={sortableFields}
                        onChange={(next) => updateAt(i, next)}
                        onRemove={() => removeAt(i)}
                      />
                    ))}
                  </SortableContext>
                  <DragPreview>
                    {sortDrag.activeId && (
                      <div className="rounded-[var(--radius-control)] border border-border-default bg-card px-2 py-1 text-label font-medium text-ink shadow-[var(--shadow-lifted)]">
                        {sortLabel(sortDrag.activeId) ?? ''}
                      </div>
                    )}
                  </DragPreview>
                </DndContext>
              </div>
            )}

            {sorts.length > 0 && (
              <div className="border-t border-border-default p-2">
                {showNulls && (
                  <div className="mb-1.5 flex items-center justify-between px-1">
                    <span className="text-meta text-muted">Empty values</span>
                    <EmptyPlacementToggle
                      value={nulls ?? 'last'}
                      onChange={(v) => onNullsChange(v === 'last' ? undefined : v)}
                    />
                  </div>
                )}
                {canAddMore && (
                  <button
                    type="button"
                    onClick={addSort}
                    className="flex items-center gap-1 rounded px-1 py-1 text-label text-muted hover:text-ink"
                  >
                    <Plus className="h-3 w-3" /> Add sort
                  </button>
                )}
              </div>
            )}
          </div>
        </>
      )}
    </span>
  );
}

/** Whole-sort empty-values placement (MN-252) — a two-button segmented toggle,
 * reusing ConnectorToggle's exact visual pattern (border/rounded/uppercase pill). */
function EmptyPlacementToggle({
  value,
  onChange,
}: {
  value: NullsPlacement;
  onChange: (v: NullsPlacement) => void;
}) {
  return (
    <span className="inline-flex overflow-hidden rounded-[var(--radius-control)] border border-border-default text-micro font-semibold uppercase leading-none">
      {(
        [
          ['last', 'Bottom'],
          ['first', 'Top'],
        ] as const
      ).map(([v, label]) => (
        <button
          key={v}
          type="button"
          onClick={() => onChange(v)}
          className={cn('px-1.5 py-0.5', value === v ? 'bg-accent-soft text-ink' : 'text-muted hover:text-ink')}
        >
          {label}
        </button>
      ))}
    </span>
  );
}

/** One draggable sort key: precedence label ("Sort by" / "Then by" — the sort
 * analog of ConditionRow's "Where" / And-Or toggle), field-type icon, field +
 * direction pickers, and a single remove (×) — sort rows have exactly one
 * secondary action, so (unlike ConditionRow) there's no "…" menu to reuse here. */
function SortRow({
  index,
  sort,
  sorts,
  fields,
  onChange,
  onRemove,
}: {
  index: number;
  sort: SortSpec;
  sorts: SortSpec[];
  fields: Field[];
  onChange: (next: SortSpec) => void;
  onRemove: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: String(index),
  });
  const field = fields.find((f) => f.apiName === sort.field);
  const Icon = fieldTypeIcon(field?.type ?? 'text');
  // A field already used by another key doesn't show up here — sorting twice by
  // the same field is a no-op precedence-wise and just confuses "explicit precedence".
  const usedElsewhere = new Set(sorts.filter((_, j) => j !== index).map((s) => s.field));
  const options = fields.filter((f) => f.apiName === sort.field || !usedElsewhere.has(f.apiName));

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(
        'group relative rounded px-1 py-1.5',
        // #656 — the dragged content now floats in the shared DragPreview
        // overlay, so this slot never competes for stacking order; it only
        // needs to mark itself as vacated (#409/#631).
        vacatedSlotClass(isDragging),
      )}
    >
      <div className="flex items-start gap-1.5">
        <button
          {...attributes}
          {...listeners}
          className="mt-1.5 shrink-0 cursor-grab text-faint opacity-0 hover:text-muted group-hover:opacity-100"
          title="Drag to reorder precedence"
        >
          <GripVertical className="h-3.5 w-3.5" />
        </button>

        <div className="min-w-0 flex-1">
          <div className="mb-1">
            <span className="text-meta font-semibold uppercase tracking-wider text-muted">
              {index === 0 ? 'Sort by' : 'Then by'}
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-1">
            <Icon className="h-3.5 w-3.5 shrink-0 text-faint" />
            <select
              className="max-w-28 flex-1 truncate rounded-[var(--radius-control)] border border-border-default bg-card px-1 py-0.5 text-label text-ink"
              value={sort.field}
              onChange={(e) => onChange({ ...sort, field: e.target.value })}
            >
              {options.map((f) => (
                <option key={f.id} value={f.apiName}>
                  {f.displayName}
                </option>
              ))}
            </select>
            <select
              className="rounded-[var(--radius-control)] border border-border-default bg-card px-1 py-0.5 text-label text-muted"
              value={sort.direction}
              onChange={(e) => onChange({ ...sort, direction: e.target.value as 'asc' | 'desc' })}
            >
              <option value="asc">{directionLabel(field?.type ?? 'text', 'asc', field?.options)}</option>
              <option value="desc">{directionLabel(field?.type ?? 'text', 'desc', field?.options)}</option>
            </select>
          </div>
        </div>

        <button
          type="button"
          onClick={onRemove}
          className="mt-1 shrink-0 rounded p-0.5 text-faint hover:bg-active hover:text-ink"
          title="Remove sort"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}

/**
 * What may never be toggled off.
 *
 * `title` — hiding it would leave rows unidentifiable.
 *
 * #408 — the previous version of this comment read "system timestamps never
 * render in grids or on cards", and that was FALSE: Created at and Updated at
 * are real field rows (`isSystem: true`) returned by the API for every database,
 * they render as ordinary columns, and they have always been in this list's
 * complement — so they are, and were, hideable.
 *
 * The comment mattered because it sent a reader looking for a rule that does not
 * exist. #408 was filed on the strength of it and does not reproduce: on a fresh
 * single-field database both timestamps appear in Hide fields, hiding one
 * removes the column, and the choice survives a reload. `created_by` is here
 * because views genuinely do not render it — a toggle that cannot change what
 * you see is worse than no toggle.
 *
 * #699 — `id` (the raw internal UUID, `isSystem: true`) joined this set for the
 * SAME reason `created_by` is here: no view ever renders it as a column, so its
 * toggle did nothing when clicked. Unlike `created_by`, `id` was actually
 * OFFERED before this fix — an unenforced rule, not an enforced one; this line
 * is what makes it real rather than a claim in a comment (which is exactly how
 * #699 itself was found: this same paragraph once asserted a rule the code
 * didn't implement).
 */
export const NON_TOGGLABLE = new Set(['title', 'created_by', 'id']);
