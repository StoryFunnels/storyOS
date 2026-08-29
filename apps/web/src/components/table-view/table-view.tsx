'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import Link from 'next/link';
import { Maximize2, Plus, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { DndContext, PointerSensor, closestCenter, useSensor, useSensors } from '@dnd-kit/core';
import type { DragEndEvent } from '@dnd-kit/core';
import { SortableContext, arrayMove, horizontalListSortingStrategy } from '@dnd-kit/sortable';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useShortcut, useWithShortcut } from '@/lib/shortcuts';
import { Dialog, DialogTrigger } from '@/components/ui/dialog';
import { CellDisplay, CellEditor, EmptyFieldAffordance, PressButton, cellToText, fieldValue } from './cells';
import { AddFieldDialog } from './add-field-dialog';
import { BatchBar } from './batch-bar';
import { HeaderCell } from './header-cell';
import { PASTE_WRONG_TARGET, coercePaste, resolvePasteSource } from './paste';
import { computeRangeBounds, hasCrossedDragThreshold, parseCellDataset, type Cursor } from './range-select';
import { RelationEditor } from './relation-cell';
import {
  useDatabase,
  useMembers,
  useRecordMutations,
  useRecordsInfinite,
} from './use-table-data';
import type { Field, RecordRow } from './use-table-data';
import type { ViewConfig } from '../views/use-view-state';
import { databaseNoun, recordHref, recordSegment } from '@/lib/records';
import { useOpenRecord } from '@/components/entity/split-panel-context';
import { systemFieldId } from '@storyos/schemas';
import { atLeast } from '@/lib/access';
import { cn } from '@/lib/utils';
import { DragPreview, useDragPresentation } from '@/components/ui/drag-presentation';
import { ViewQueryError } from '../views/query-error';

const ROW_HEIGHT = 32;
const DEFAULT_WIDTH = 180;
const TITLE_WIDTH = 260;
// #296: how far the pointer has to move before a mousedown-on-a-cell turns into
// a range-select drag rather than an ordinary click — same distance columnSensors'
// PointerSensor below already uses for drag-to-reorder-columns.
const DRAG_THRESHOLD = 6;

// The public id renders in the row gutter (Airtable-style), not as its own column.
/**
 * Field types the table never renders as a column.
 *
 * #408 — exported so the relationship with `NON_TOGGLABLE` can be ASSERTED
 * rather than assumed. The two lists encode halves of one rule ("what renders"
 * and "what may be turned off"), and the ticket's real complaint is that the
 * rule lives in two places plus a hand-added exception for `number`. A test now
 * pins the invariant that matters: anything the table RENDERS must be
 * TOGGLABLE, or it is a column nobody can turn off.
 */
export const HIDDEN_TYPES = new Set(['id', 'created_by']);
// checkbox toggles on click; rich_text edits on the record page; lookup is computed.
// Types with no inline editor. `rollup` was missing, which had two consequences:
// an empty rollup cell offered a fake "Add <field>" affordance, and double-clicking
// one opened an editor on a value the server computes and will never accept.
// created_by/updated_by are system columns for the same reason.
const NO_EDITOR = new Set([
  'checkbox', 'rich_text', 'lookup', 'rollup', 'button', 'formula',
  'created_at', 'updated_at', 'created_by', 'updated_by',
]);

/** #187: empty for the ghost-affordance check — null/blank, or an empty
 * multi-value (multi_select / user / relation) array. */
const isEmptyCellValue = (v: unknown): boolean =>
  v == null || v === '' || (Array.isArray(v) && v.length === 0);

// #296: resolves "which cell is the pointer over right now" from raw client
// coordinates during a drag — a mousemove event has no React target for the
// cell you're currently hovering, unlike a click, so we read it back off the
// DOM via the data-row/data-col attributes each cell renders below. The
// string→number parsing itself lives in parseCellDataset (range-select.ts)
// so it's unit-testable without a DOM.
function cellFromPoint(x: number, y: number): Cursor | null {
  const target = (document.elementFromPoint(x, y) as HTMLElement | null)?.closest<HTMLElement>(
    '[data-row][data-col]',
  );
  return parseCellDataset(target?.dataset);
}

export function TableView({
  ws,
  db,
  readOnly,
  schemaEditable = !readOnly,
  queryBody,
  hiddenFieldIds,
  columnWidths,
  onColumnResize,
  config,
  onPatch,
}: {
  ws: string;
  db: string;
  readOnly: boolean;
  schemaEditable?: boolean;
  queryBody?: Record<string, unknown>;
  hiddenFieldIds?: string[];
  columnWidths?: Record<string, number>;
  onColumnResize?: (fieldId: string, width: number) => void;
  /** View config + patch, so column headers can filter/sort by their field (MN-225). */
  config?: ViewConfig;
  onPatch?: (updates: Partial<ViewConfig>) => void;
}) {
  // #396 — platform-correct: ⌘ on a Mac, Ctrl elsewhere.
  const newRecordTitle = useWithShortcut('New record', 'new-record');
  const database = useDatabase(ws, db);
  // #149 — the operator's word for a row ("task"), not "record".
  const noun = databaseNoun(database.data?.name);
  const records = useRecordsInfinite(ws, db, queryBody);
  const { updateRecord, createRecord, deleteRecord } = useRecordMutations(ws, db);

  const fields = useMemo(
    () =>
      (database.data?.fields ?? []).filter(
        (f) => !HIDDEN_TYPES.has(f.type) && !(hiddenFieldIds ?? []).includes(f.id),
      ),
    [database.data, hiddenFieldIds],
  );
  // #289 — the public id renders in the row GUTTER, not as a column, so
  // hidden_field_ids couldn't reach it and it was the one visible column nobody
  // could turn off. The Fields picker now offers it via the canonical system-field
  // id (`__sys_number`), and this is where that choice takes effect. Falls back to
  // a real `number` field row's id when the database has one.
  const numberHidden = useMemo(() => {
    const hidden = new Set(hiddenFieldIds ?? []);
    if (hidden.has(systemFieldId('number'))) return true;
    const real = (database.data?.fields ?? []).find((f) => f.apiName === 'number');
    return real ? hidden.has(real.id) : false;
  }, [hiddenFieldIds, database.data]);

  const hasUserField = fields.some((f) => f.type === 'user');
  const members = useMembers(ws, hasUserField && !readOnly);
  const memberList = useMemo(
    () => (members.data ?? []).map((m) => ({ id: m.user.id, name: m.user.name, image: m.user.image })),
    [members.data],
  );
  const memberNames = useMemo(() => new Map(memberList.map((m) => [m.id, m.name])), [memberList]);
  const memberImages = useMemo(() => new Map(memberList.map((m) => [m.id, m.image])), [memberList]);
  // MN-294: cellToText (copy-to-clipboard) has no member data of its own — it's a
  // pure {field,value} function — so resolve a user id to the same display name
  // CellDisplay already shows on screen, via the same memberNames map.
  const resolveMemberName = useCallback((id: string) => memberNames.get(id) ?? id, [memberNames]);

  const rows = useMemo(
    () => (records.data?.pages ?? []).flatMap((page) => page.data),
    [records.data],
  );

  const [widths, setWidths] = useState<Record<string, number>>({});
  const [cursor, setCursor] = useState<Cursor | null>(null);
  // MN-285: the far corner of a shift-click/shift-arrow cell range, anchored at
  // `cursor`. Null means "just the one cell" — the pre-existing behavior.
  const [rangeEnd, setRangeEnd] = useState<Cursor | null>(null);
  const [editing, setEditing] = useState(false);
  const [addingField, setAddingField] = useState<null | { type?: string; relationId?: string }>(null);

  // First column frozen by default; per-user, per-database preference (MN-083).
  const pinKey = `storyos:pin-first:${db}`;
  const [pinned, setPinned] = useState(true);
  useEffect(() => {
    if (typeof window !== 'undefined') setPinned(window.localStorage.getItem(pinKey) !== '0');
  }, [pinKey]);
  const togglePinned = () => {
    setPinned((p) => {
      const next = !p;
      if (typeof window !== 'undefined') window.localStorage.setItem(pinKey, next ? '1' : '0');
      return next;
    });
  };

  // Drag-to-reorder columns → writes field.position (MN-083).
  const qc = useQueryClient();
  const columnSensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const reorderColumns = useMutation({
    mutationFn: async (moves: Array<{ fieldId: string; position: number }>) => {
      for (const m of moves) {
        const { error } = await api.PATCH('/api/v1/workspaces/{ws}/databases/{db}/fields/{field}', {
          params: { path: { ws, db, field: m.fieldId } },
          body: { position: m.position },
        });
        if (error) throw error;
      }
    },
    onSettled: () => void qc.invalidateQueries({ queryKey: ['database', ws, db] }),
  });
  function onColumnDragEnd(event: DragEndEvent) {
    if (!event.over || event.active.id === event.over.id) return;
    // The frozen leading columns (id, title) stay put; reorder happens among the rest.
    const rest = fields.slice(frozenCount);
    const from = rest.findIndex((f) => f.id === event.active.id);
    const to = rest.findIndex((f) => f.id === event.over!.id);
    if (from < 0 || to < 0) return;
    const next = [...fields.slice(0, frozenCount), ...arrayMove(rest, from, to)];
    const moves = next
      .map((f, i) => ({ f, i }))
      .filter(({ f }) => !f.isSystem)
      .map(({ f, i }) => ({ fieldId: f.id, position: i }));
    if (moves.length) reorderColumns.mutate(moves);
  }
  const gridRef = useRef<HTMLDivElement>(null);
  const router = useRouter();
  // #199 — the ONE decision about whether a row opens beside the table or replaces
  // it. Shared with My Work, the other views and the relation links inside a record.
  const openRecord = useOpenRecord('swap');

  // MN-050: multi-select + batch edit
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const anchorRef = useRef<number | null>(null);
  const toggleSelect = useCallback(
    (rowIndex: number, shift: boolean) => {
      setSelected((prev) => {
        const next = new Set(prev);
        const allRows = (records.data?.pages ?? []).flatMap((p) => p.data);
        if (shift && anchorRef.current !== null) {
          const [lo, hi] = [Math.min(anchorRef.current, rowIndex), Math.max(anchorRef.current, rowIndex)];
          for (let i = lo; i <= hi; i++) {
            const id = allRows[i]?.id;
            if (id) next.add(id);
          }
        } else {
          const id = allRows[rowIndex]?.id;
          if (!id) return next;
          if (next.has(id)) next.delete(id);
          else next.add(id);
          anchorRef.current = rowIndex;
        }
        return next;
      });
    },
    [records.data],
  );

  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 20,
  });

  // Infinite scroll: fetch the next page as the tail approaches.
  const virtualItems = virtualizer.getVirtualItems();
  useEffect(() => {
    const last = virtualItems[virtualItems.length - 1];
    if (!last) return;
    if (last.index >= rows.length - 30 && records.hasNextPage && !records.isFetchingNextPage) {
      void records.fetchNextPage();
    }
  }, [virtualItems, rows.length, records]);

  const widthOf = useCallback(
    (field: Field) =>
      widths[field.id] ??
      columnWidths?.[field.id] ??
      // The id column starts narrow (a compact number gutter) but is resizable (MN-087).
      (field.type === 'id' ? 56 : field.type === 'title' ? TITLE_WIDTH : DEFAULT_WIDTH),
    [widths, columnWidths],
  );

  const valueOf = (row: RecordRow, field: Field): unknown =>
    fieldValue(row, field);

  // Leading non-reorderable columns stay frozen when pinned: the public id (MN-087)
  // then the title. Everything after is draggable. If the id column is hidden, only
  // the title freezes.
  const frozenCount = useMemo(() => {
    let n = 0;
    for (const f of fields) {
      if (f.type === 'id' || f.type === 'title') n++;
      else break;
    }
    return n;
  }, [fields]);
  // Cumulative left offset (after the 56px gutter) for each frozen column.
  const frozenLeft = useCallback(
    (colIndex: number) => 56 + fields.slice(0, colIndex).reduce((sum, f) => sum + widthOf(f), 0),
    [fields, widthOf],
  );

  // #251 Column virtualization — only render non-frozen columns visible in the
  // horizontal scroll window. Frozen columns (id + title) always render.
  const nonFrozenFields = useMemo(
    () => fields.slice(frozenCount),
    [fields, frozenCount],
  );
  const frozenTotalWidth = useMemo(
    () => 56 + fields.slice(0, frozenCount).reduce((sum, f) => sum + widthOf(f), 0),
    [fields, frozenCount, widthOf],
  );
  const columnVirtualizer = useVirtualizer({
    horizontal: true,
    count: nonFrozenFields.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => widthOf(nonFrozenFields[i]!),
    paddingStart: frozenTotalWidth,
    overscan: 3,
  });

  /*
   * #409/#412/#415 — the shared drag presentation for column reordering.
   *
   * The header used to stay in the flow with a pointer-following transform, so
   * two labels painted on the same pixels mid-drag — the header literally read
   * "Stagunt". `columnLabel` is also what fixes #415 here: columns are keyed by
   * field uuid, so dnd-kit's stock announcements read out hex.
   */
  const columnLabel = (id: string) => fields.find((f) => f.id === id)?.displayName;
  const columnDrag = useDragPresentation(
    columnLabel,
    { onDragEnd: onColumnDragEnd },
    fields.slice(frozenCount).map((f) => f.id),
  );

  /*
   * #410 — the body must preview the SAME order the header previews.
   *
   * Only the header cells sit inside the `SortableContext`, so dnd-kit gave them
   * a preview transform while the virtualized rows below kept rendering straight
   * from `fields`. Mid-drag the grid therefore stated, in plain sight, that
   * Amount = "New" and Stage = "1,200" — with one record it looks like a glitch;
   * with a screenful it looks like the data moved.
   *
   * Recomputed on `over` CHANGE, not per pointermove: `over` only flips when the
   * pointer crosses a column boundary, so this is a handful of renders per drag
   * rather than one per mouse event (AC4's concern).
   *
   * The frozen leading columns are excluded, exactly as `onColumnDragEnd` does —
   * they never move, and including them would let a drop preview a position the
   * commit cannot produce.
   */
  const previewFields = useMemo(() => {
    const { activeId, overId } = columnDrag;
    if (!activeId || !overId || activeId === overId) return fields;
    const head = fields.slice(0, frozenCount);
    const rest = fields.slice(frozenCount);
    const from = rest.findIndex((f) => f.id === activeId);
    const to = rest.findIndex((f) => f.id === overId);
    if (from < 0 || to < 0) return fields;
    return [...head, ...arrayMove(rest, from, to)];
  }, [fields, frozenCount, columnDrag]);


  function commitEdit(row: RecordRow, field: Field, value: unknown) {
    setEditing(false);
    const current = valueOf(row, field) ?? null;
    if (JSON.stringify(current) === JSON.stringify(value)) return;
    updateRecord.mutate({ rec: row.id, values: { [field.apiName]: value } });
    scrollRef.current?.focus();
  }

  // The rectangular cell range spanning `cursor` (the anchor) to `rangeEnd` (the
  // far corner), normalized to top-left/bottom-right. Null when there's no active
  // range — i.e. every existing single-cell code path is unaffected (MN-285).
  // #296: `rangeEnd` may have been set by shift+click, shift+arrow, or a mouse
  // drag — computeRangeBounds (range-select.ts) doesn't know or care which.
  const rangeBounds = useMemo(() => computeRangeBounds(cursor, rangeEnd), [cursor, rangeEnd]);

  // #296: mousedown-on-a-cell + drag + release range selection — the mouse
  // counterpart to MN-285's shift+click/shift+arrow, feeding the exact same
  // cursor/rangeEnd state (not a parallel selection mechanism). A mousedown
  // only remembers where it started; nothing changes yet, so an ordinary
  // click (no movement past DRAG_THRESHOLD) still runs the click handler
  // below completely untouched — including #293's relation-chip link-through
  // and the title row's "Open" link, both of which already stop propagation
  // on their own click today. Only once the pointer has moved past the
  // threshold do we treat it as a real drag: anchor the range at the
  // mousedown cell (like a fresh, non-shift click would) and grow the far
  // corner from there as the pointer moves.
  const dragAnchorRef = useRef<{ row: number; col: number; x: number; y: number } | null>(null);
  const draggingRef = useRef(false);
  // Swallows the single click that follows a real drag's mouseup, so
  // whatever the pointer happens to land on (a cell, a relation chip, the
  // title's "Open" link, a row button, …) doesn't also fire its own click on
  // top of the range we just finished dragging out.
  const suppressClickRef = useRef(false);
  const [dragSelecting, setDragSelecting] = useState(false);

  const handleDragMove = useCallback((e: MouseEvent) => {
    const anchor = dragAnchorRef.current;
    if (!anchor) return;
    if (!draggingRef.current) {
      if (!hasCrossedDragThreshold(anchor, e.clientX, e.clientY, DRAG_THRESHOLD)) return;
      draggingRef.current = true;
      setDragSelecting(true);
      setEditing(false);
      setCursor({ row: anchor.row, col: anchor.col });
    }
    const cell = cellFromPoint(e.clientX, e.clientY);
    if (cell) setRangeEnd((prev) => (prev && prev.row === cell.row && prev.col === cell.col ? prev : cell));
  }, []);

  const handleDragUp = useCallback(() => {
    window.removeEventListener('mousemove', handleDragMove);
    window.removeEventListener('mouseup', handleDragUp);
    if (draggingRef.current) {
      suppressClickRef.current = true;
      scrollRef.current?.focus();
    }
    draggingRef.current = false;
    dragAnchorRef.current = null;
    setDragSelecting(false);
  }, [handleDragMove]);

  // Belt-and-suspenders: if the component unmounts mid-drag (e.g. navigating
  // away while the mouse is still down), don't leak the window listeners.
  useEffect(() => {
    return () => {
      window.removeEventListener('mousemove', handleDragMove);
      window.removeEventListener('mouseup', handleDragUp);
    };
  }, [handleDragMove, handleDragUp]);

  // Copy/paste a cell value between cells (MN-15). Keeps the raw copied value +
  // source field so same-type paste is exact; falls back to the clipboard text.
  const copiedRef = useRef<{ field: Field; value: unknown } | null>(null);
  // MN-285: a rectangular multi-cell copy — a grid of the same {field,value}
  // shape, kept separate from `copiedRef` so the original single-cell path
  // above (and its exact error messaging) is untouched when there's no range.
  const copiedRangeRef = useRef<Array<Array<{ field: Field; value: unknown }>> | null>(null);
  const READONLY_TYPES = ['id', 'created_at', 'updated_at', 'created_by', 'lookup', 'rollup', 'formula'];

  function copyCell() {
    if (!cursor) return;
    const row = rows[cursor.row];
    const field = fields[cursor.col];
    if (!row || !field) return;
    const value = valueOf(row, field) ?? null;
    copiedRef.current = { field, value };
    void navigator.clipboard?.writeText(cellToText(field, value, resolveMemberName)).catch(() => {});
    toast.success('Copied');
  }

  async function pasteCell() {
    if (!cursor || readOnly) return;
    const row = rows[cursor.row];
    const target = fields[cursor.col];
    if (!row || !target) return;
    if (READONLY_TYPES.includes(target.type)) {
      toast.error(`${target.displayName} is read-only`);
      return;
    }
    let text = '';
    try {
      text = await navigator.clipboard.readText();
    } catch {
      /* clipboard read blocked — fall back to the in-app copied value */
    }
    const value = coercePaste(target, text, copiedRef.current);
    if (value === PASTE_WRONG_TARGET) {
      toast.error(
        target.type === 'relation'
          ? 'Paste into a relation only from a relation pointing at the same database'
          : `Can't paste into a ${target.displayName}`,
      );
      return;
    }
    if (value === undefined) {
      toast.error(`Can't paste into a ${target.type} field`);
      return;
    }
    commitEdit(row, target, value);
  }

  // MN-285: copy every cell in the selected range as a TSV block (system
  // clipboard) + the raw {field,value} grid (in-app, for exact same-type paste).
  function copyRange() {
    if (!cursor || !rangeBounds) return;
    const { r0, r1, c0, c1 } = rangeBounds;
    const grid: Array<Array<{ field: Field; value: unknown }>> = [];
    const textRows: string[] = [];
    for (let r = r0; r <= r1; r++) {
      const row = rows[r];
      const gridRow: Array<{ field: Field; value: unknown }> = [];
      const textCols: string[] = [];
      for (let c = c0; c <= c1; c++) {
        const field = fields[c];
        if (!row || !field) continue;
        const value = valueOf(row, field) ?? null;
        gridRow.push({ field, value });
        textCols.push(cellToText(field, value, resolveMemberName));
      }
      grid.push(gridRow);
      textRows.push(textCols.join('\t'));
    }
    copiedRangeRef.current = grid;
    void navigator.clipboard?.writeText(textRows.join('\n')).catch(() => {});
    const count = grid.reduce((n, gr) => n + gr.length, 0);
    toast.success(`Copied ${count} cell${count === 1 ? '' : 's'}`);
  }

  // MN-285: fill a destination range (explicit, or — pasting a multi-cell copy
  // onto a single cursor cell — anchored at the cursor and sized to the copied
  // block) by tiling the copied grid / pasted clipboard text with wraparound,
  // the same "repeat the pattern" rule spreadsheets use for fill-paste. Cells
  // the target field can't accept are skipped rather than blocking the batch —
  // the single-cell path above is what still surfaces a precise per-field error.
  async function pasteRange() {
    if (!cursor || readOnly) return;
    // MN-292: see resolvePasteSource — folds a lone single-cell copy in as a
    // 1x1 grid so a range fill-down keeps full field fidelity instead of
    // silently dropping to lossy clipboard text.
    const inSession = resolvePasteSource(copiedRangeRef.current, copiedRef.current);
    let clipboardGrid: string[][] | null = null;
    if (!inSession) {
      let text = '';
      try {
        text = await navigator.clipboard.readText();
      } catch {
        /* clipboard read blocked — nothing to tile from */
      }
      if (text) clipboardGrid = text.replace(/\r/g, '').split('\n').map((line) => line.split('\t'));
    }
    const srcRows = inSession?.length ?? clipboardGrid?.length ?? 1;
    const srcCols = inSession?.[0]?.length ?? clipboardGrid?.[0]?.length ?? 1;
    const r0 = rangeBounds?.r0 ?? cursor.row;
    const c0 = rangeBounds?.c0 ?? cursor.col;
    const r1 = rangeBounds?.r1 ?? Math.min(rows.length - 1, cursor.row + srcRows - 1);
    const c1 = rangeBounds?.c1 ?? Math.min(fields.length - 1, cursor.col + srcCols - 1);

    let applied = 0;
    for (let r = r0; r <= r1; r++) {
      const row = rows[r];
      if (!row) continue;
      for (let c = c0; c <= c1; c++) {
        const target = fields[c];
        if (!target || READONLY_TYPES.includes(target.type)) continue;
        const sr = (r - r0) % srcRows;
        const sc = (c - c0) % srcCols;
        const copiedCell = inSession?.[sr]?.[sc] ?? null;
        const text = clipboardGrid ? clipboardGrid[sr]?.[sc] ?? '' : '';
        const value = coercePaste(target, text, copiedCell);
        if (value === PASTE_WRONG_TARGET || value === undefined) continue;
        const current = valueOf(row, target) ?? null;
        if (JSON.stringify(current) === JSON.stringify(value)) continue;
        updateRecord.mutate({ rec: row.id, values: { [target.apiName]: value } });
        applied++;
      }
    }
    if (applied > 0) toast.success(`Pasted ${applied} cell${applied === 1 ? '' : 's'}`);
    else toast.error('Nothing to paste there');
    scrollRef.current?.focus();
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (editing || rows.length === 0) return;
    // #200 data-loss guard: React portals bubble keydown through the React tree,
    // so a field-edit/formula dialog's Cmd+A (or Cmd+C/V, arrows, etc.) would
    // otherwise hit the grid and select/mutate every row behind the modal. Ignore
    // any key event originating in a dialog, menu, listbox, or editable control.
    const target = e.target as HTMLElement | null;
    if (target?.closest('input, textarea, select, [contenteditable="true"], [role="dialog"], [role="menu"], [role="listbox"]')) {
      return;
    }
    const max: Cursor = { row: rows.length - 1, col: fields.length - 1 };
    // MN-285: plain arrow moves the single-cell cursor and drops any active range
    // (matching a plain click); shift+arrow instead grows the range's far corner,
    // anchored at the existing cursor.
    const move = (dr: number, dc: number, extend: boolean) => {
      e.preventDefault();
      if (extend && cursor) {
        setRangeEnd((prev) => {
          const anchor = prev ?? cursor;
          const next = {
            row: Math.min(max.row, Math.max(0, anchor.row + dr)),
            col: Math.min(max.col, Math.max(0, anchor.col + dc)),
          };
          virtualizer.scrollToIndex(next.row);
          if (next.col >= frozenCount) columnVirtualizer.scrollToIndex(next.col - frozenCount);
          return next;
        });
        return;
      }
      setRangeEnd(null);
      setCursor((prev) => {
        const base = prev ?? { row: 0, col: 0 };
        const next = {
          row: Math.min(max.row, Math.max(0, base.row + dr)),
          col: Math.min(max.col, Math.max(0, base.col + dc)),
        };
        virtualizer.scrollToIndex(next.row);
        if (next.col >= frozenCount) columnVirtualizer.scrollToIndex(next.col - frozenCount);
        return next;
      });
    };
    // A multi-cell in-app copy that hasn't been consumed by a range paste yet —
    // lets a single-cell Cmd+V still fill-paste a previously copied block,
    // anchored at the cursor (see pasteRange's destination-sizing fallback).
    const hasRangeCopy = (copiedRangeRef.current?.length ?? 0) > 1 || (copiedRangeRef.current?.[0]?.length ?? 0) > 1;
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'c' && cursor) {
      e.preventDefault();
      if (rangeBounds) copyRange();
      else copyCell();
    } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'v' && cursor && !readOnly) {
      e.preventDefault();
      if (rangeBounds || hasRangeCopy) void pasteRange();
      else void pasteCell();
    } else if (e.key === 'ArrowDown') move(1, 0, e.shiftKey);
    else if (e.key === 'ArrowUp') move(-1, 0, e.shiftKey);
    else if (e.key === 'ArrowRight') move(0, 1, e.shiftKey);
    else if (e.key === 'Tab') move(0, 1, false);
    else if (e.key === 'ArrowLeft') move(0, -1, e.shiftKey);
    else if (e.key === 'Escape' && (selected.size > 0 || rangeEnd)) {
      setSelected(new Set());
      setRangeEnd(null);
    } else if (e.key.toLowerCase() === 'x' && cursor && !readOnly) {
      e.preventDefault();
      toggleSelect(cursor.row, e.shiftKey);
    } else if (e.key.toLowerCase() === 'e' && cursor) {
      const row = rows[cursor.row];
      // #199 — the keyboard's "open" goes through the same entry point the Open
      // chip uses, so `e` and a click cannot disagree about whether a record opens
      // in the split panel. A keyboard event carries no mouse button, so it is
      // always an unmodified primary "click" as far as `useOpenRecord` is concerned.
      if (row)
        openRecord(
          { db, rec: recordSegment(row), title: row.title, number: row.number },
          { button: 0, preventDefault: () => {} },
          () => router.push(recordHref(ws, db, row)),
        );
    } else if (e.key.toLowerCase() === 'a' && (e.metaKey || e.ctrlKey) && !readOnly) {
      e.preventDefault();
      setSelected(new Set(rows.map((r) => r.id)));
    } else if (e.key === 'Enter' && cursor && !readOnly) {
      e.preventDefault();
      setRangeEnd(null);
      const field = fields[cursor.col]!;
      if (field.type === 'checkbox') {
        const row = rows[cursor.row]!;
        commitEdit(row, field, !(valueOf(row, field) === true));
      } else if (!NO_EDITOR.has(field.type)) {
        setEditing(true);
      }
    }
  }

  useShortcut('n', () => {
    if (readOnly) return;
    createRecord.mutate(
      {},
      {
        onSuccess: () => {
          setCursor({ row: rows.length, col: 0 });
          setEditing(true);
          requestAnimationFrame(() => virtualizer.scrollToIndex(rows.length));
        },
      },
    );
  });

  if (database.isLoading) return <p className="p-6 text-sm text-muted">Loading…</p>;

  const totalWidth =
    fields.reduce((sum, f) => sum + widthOf(f), 0) + 56 + (schemaEditable ? 110 : 0);

  // #251 Column virtualization: which non-frozen columns to render this frame.
  // During a column drag, dnd-kit needs every item mounted, so skip windowing.
  const virtualCols = columnVirtualizer.getVirtualItems();
  const isDraggingCol = !!columnDrag.activeId;
  const firstVCol = virtualCols[0];
  const lastVCol = virtualCols[virtualCols.length - 1];
  const colLeftSpacer =
    isDraggingCol || !firstVCol ? 0 : firstVCol.start - frozenTotalWidth;
  const colRightSpacer =
    isDraggingCol || !lastVCol
      ? 0
      : columnVirtualizer.getTotalSize() - (lastVCol.start + lastVCol.size);

  // #251 — cell renderer extracted so frozen and non-frozen columns share
  // one render path (field-surfaces.md: never duplicate render logic).
  function renderBodyCell(field: Field, colIndex: number, rowIdx: number, row: RecordRow) {
    const isCursor = cursor?.row === rowIdx && cursor?.col === colIndex;
    const isCellEditing = isCursor && editing;
    const inRange =
      rangeBounds !== null &&
      rowIdx >= rangeBounds.r0 &&
      rowIdx <= rangeBounds.r1 &&
      colIndex >= rangeBounds.c0 &&
      colIndex <= rangeBounds.c1;
    return (
      <div
        key={field.id}
        data-row={rowIdx}
        data-col={colIndex}
        style={{
          width: widthOf(field),
          ...(pinned && colIndex < frozenCount
            ? { left: frozenLeft(colIndex) }
            : {}),
        }}
        className={cn(
          'relative flex shrink-0 items-center overflow-visible border-r border-border-default px-2',
          isCursor && 'z-20 ring-2 ring-inset ring-[var(--accent)]',
          pinned &&
            colIndex < frozenCount &&
            cn(
              'sticky z-10',
              colIndex === frozenCount - 1 &&
                'shadow-[2px_0_4px_-2px_rgba(15,23,41,0.12)]',
              selected.has(row.id)
                ? 'bg-accent-soft'
                : 'bg-card group-hover:bg-hover',
            ),
          inRange && !isCursor && 'z-10 bg-accent-soft/60',
        )}
        onMouseDown={(e) => {
          suppressClickRef.current = false;
          if (e.button !== 0 || e.shiftKey || isCellEditing) return;
          dragAnchorRef.current = {
            row: rowIdx,
            col: colIndex,
            x: e.clientX,
            y: e.clientY,
          };
          window.addEventListener('mousemove', handleDragMove);
          window.addEventListener('mouseup', handleDragUp);
        }}
        onClick={(e) => {
          if (e.shiftKey && cursor) {
            setRangeEnd({ row: rowIdx, col: colIndex });
            scrollRef.current?.focus();
            return;
          }
          setRangeEnd(null);
          setCursor({ row: rowIdx, col: colIndex });
          scrollRef.current?.focus();
          if (readOnly) return;
          if (field.type === 'checkbox') {
            commitEdit(row, field, !(valueOf(row, field) === true));
          } else if (
            field.type !== 'title' &&
            field.type !== 'id' &&
            field.type !== 'select' &&
            field.type !== 'workflow' &&
            field.type !== 'relation' &&
            !NO_EDITOR.has(field.type)
          ) {
            setEditing(true);
          }
        }}
        onDoubleClick={() => {
          if (
            !readOnly &&
            (field.type === 'title' ||
              field.type === 'select' ||
              field.type === 'workflow' ||
              field.type === 'relation')
          ) {
            setRangeEnd(null);
            setCursor({ row: rowIdx, col: colIndex });
            setEditing(true);
          }
        }}
      >
        {isCellEditing && field.type === 'relation' ? (
          <RelationEditor
            ws={ws}
            db={db}
            recordId={row.id}
            field={field}
            current={
              (valueOf(row, field) as Array<{
                id: string;
                title: string;
              }>) ?? []
            }
            onDone={() => {
              setEditing(false);
              scrollRef.current?.focus();
            }}
          />
        ) : isCellEditing && !NO_EDITOR.has(field.type) ? (
          <CellEditor
            ws={ws}
            db={db}
            rec={row.id}
            field={field}
            value={valueOf(row, field)}
            members={memberList}
            onCommit={(value) => commitEdit(row, field, value)}
            onCancel={() => {
              setEditing(false);
              scrollRef.current?.focus();
            }}
          />
        ) : field.type === 'button' ? (
          <PressButton
            ws={ws}
            db={db}
            recordId={row.id}
            field={field}
            disabled={readOnly}
            onPressed={() => updateRecord.reset()}
          />
        ) : isEmptyCellValue(valueOf(row, field)) &&
          !readOnly &&
          field.type !== 'id' &&
          field.type !== 'title' &&
          !NO_EDITOR.has(field.type) ? (
          <EmptyFieldAffordance field={field} editable />
        ) : (
          <>
            <CellDisplay
              field={field}
              value={valueOf(row, field)}
              memberNames={memberNames}
              memberImages={memberImages}
              ws={ws}
            />
            {field.type === 'title' && (
              <Link
                href={recordHref(ws, db, row)}
                // #199 — opens beside the table in the split panel on desktop; the
                // `href` still carries cmd/middle-click to a new tab, and below `md`
                // the default navigation runs unchanged.
                onClick={(e) => {
                  e.stopPropagation();
                  openRecord({ db, rec: recordSegment(row), title: row.title, number: row.number }, e);
                }}
                className="absolute right-1.5 top-1/2 flex -translate-y-1/2 items-center gap-1 rounded border border-border-default bg-card px-1.5 py-0.5 text-[11px] font-medium text-muted opacity-0 shadow-sm hover:text-ink group-hover:opacity-100"
              >
                <Maximize2 className="h-3 w-3" /> Open
              </Link>
            )}
          </>
        )}
      </div>
    );
  }

  // #346 — a rejected query must never render as an empty view. Placed after every
  // hook so the early return cannot change hook order.
  if (records.isError) return <ViewQueryError error={records.error} onRetry={() => void records.refetch()} />;
  return (
    <div className="relative flex h-full flex-col">
      <div
        ref={scrollRef}
        className="min-h-0 flex-1 overflow-auto"
        tabIndex={0}
        onKeyDown={onKeyDown}
        onClickCapture={(e) => {
          // #296: swallow exactly the one click that follows a real
          // drag-select's mouseup — see handleDragUp — regardless of what
          // element it landed on (capture runs before any nested onClick,
          // including the relation-chip/title-link ones that stop
          // propagation on themselves).
          if (suppressClickRef.current) {
            suppressClickRef.current = false;
            e.preventDefault();
            e.stopPropagation();
          }
        }}
      >
        <div
          ref={gridRef}
          style={{ width: totalWidth }}
          className={cn('outline-none', dragSelecting && 'select-none')}
        >
          {/* Header */}
          <div className="sticky top-0 z-20 flex border-b border-border-default bg-app">
            <div className={cn('flex w-14 shrink-0 items-center justify-center bg-app text-[11px] font-medium text-faint', pinned && 'sticky left-0 z-30')}>
              #
            </div>
            {fields.slice(0, frozenCount).map((field, i) => (
              <HeaderCell
                key={field.id}
                ws={ws}
                db={db}
                field={field}
                fields={fields}
                width={widthOf(field)}
                readOnly={!schemaEditable}
                sticky={pinned}
                stickyLeft={frozenLeft(i)}
                stickyZ={30 + (frozenCount - i)}
                isFirst={i === 0}
                pinned={pinned}
                onTogglePin={i === 0 ? togglePinned : undefined}
                config={config}
                onPatch={onPatch}
                onResize={(w) => {
                  setWidths((prev) => ({ ...prev, [field.id]: w }));
                  onColumnResize?.(field.id, w);
                }}
              />
            ))}
            <DndContext
              sensors={columnSensors}
              collisionDetection={closestCenter}
              {...columnDrag.contextProps}
            >
              <SortableContext items={nonFrozenFields.map((f) => f.id)} strategy={horizontalListSortingStrategy}>
                {colLeftSpacer > 0 && <div key="__hdr-l" style={{ width: colLeftSpacer, flexShrink: 0 }} />}
                {(isDraggingCol
                  ? nonFrozenFields
                  : virtualCols.map((vc) => nonFrozenFields[vc.index]!)
                ).map((field) => (
                  <HeaderCell
                    key={field.id}
                    ws={ws}
                    db={db}
                    field={field}
                    fields={fields}
                    width={widthOf(field)}
                    readOnly={!schemaEditable}
                    reorderable={schemaEditable}
                    config={config}
                    onPatch={onPatch}
                    onAddLookup={(id) => setAddingField({ type: 'lookup', relationId: id })}
                    onResize={(w) => {
                      setWidths((prev) => ({ ...prev, [field.id]: w }));
                      onColumnResize?.(field.id, w);
                    }}
                  />
                ))}
                {colRightSpacer > 0 && <div key="__hdr-r" style={{ width: colRightSpacer, flexShrink: 0 }} />}
              </SortableContext>
              <DragPreview>
                {columnDrag.activeId && (
                  <div className="rounded-[var(--radius-control)] border border-border-default bg-card px-2 py-1 text-[12px] font-medium text-ink shadow-[0_8px_24px_rgba(15,23,41,0.25)]">
                    {columnLabel(columnDrag.activeId) ?? ''}
                  </div>
                )}
              </DragPreview>
            </DndContext>
            {schemaEditable && (
              <Dialog open={addingField !== null} onOpenChange={(open) => setAddingField(open ? {} : null)}>
                <DialogTrigger asChild>
                  <button className="flex h-8 w-[110px] shrink-0 items-center gap-1.5 border-r border-border-default px-2 text-[12px] font-medium text-muted hover:bg-hover hover:text-ink">
                    <Plus className="h-3.5 w-3.5" /> New field
                  </button>
                </DialogTrigger>
                {addingField && (
                  <AddFieldDialog
                    ws={ws}
                    db={db}
                    initialType={addingField.type}
                    initialRelationId={addingField.relationId}
                    onDone={() => setAddingField(null)}
                  />
                )}
              </Dialog>
            )}
          </div>

          {/* Virtualized rows */}
          <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
            {virtualItems.map((item) => {
              const row = rows[item.index]!;
              return (
                <div
                  key={row.id}
                  className={cn('group absolute left-0 flex w-full border-b border-border-default hover:bg-hover', selected.has(row.id) ? 'bg-accent-soft' : 'bg-card')}
                  style={{ top: item.start, height: ROW_HEIGHT }}
                >
                  <div
                    className={cn(
                      'relative flex w-14 shrink-0 items-center justify-center',
                      pinned && 'sticky left-0 z-10',
                      selected.has(row.id) ? 'bg-accent-soft' : 'bg-card group-hover:bg-hover',
                    )}
                  >
                    {/* Public id in the gutter by default (MN-087) — fades to row actions on
                        hover, and can be hidden entirely from Fields (#289). */}
                    {row.number !== null && !numberHidden && (
                      <span
                        className={cn(
                          'text-[11px] tabular-nums text-faint',
                          selected.size > 0 ? 'opacity-0' : 'group-hover:opacity-0',
                        )}
                      >
                        {row.number}
                      </span>
                    )}
                    <div
                      className={cn(
                        'absolute inset-0 flex items-center justify-center gap-0.5',
                        selected.size > 0 ? 'opacity-100' : 'opacity-0 group-hover:opacity-100',
                      )}
                    >
                      {!readOnly && (
                        <input
                          type="checkbox"
                          className="h-3 w-3 cursor-pointer"
                          checked={selected.has(row.id)}
                          onClick={(e) => {
                            e.stopPropagation();
                            toggleSelect(item.index, (e.nativeEvent as MouseEvent).shiftKey);
                          }}
                          readOnly
                        />
                      )}
                      {/* The labelled "Open" affordance on the title cell is the single way
                          to expand a row (#90) — no duplicate icon here. */}
                      {!readOnly && (
                        <button
                          title={`Delete ${noun}`}
                          className="rounded p-0.5 text-faint hover:text-error"
                          onClick={() => deleteRecord.mutate(row.id)}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </div>
                  </div>
                  {/* #251 Column virtualization: frozen always, non-frozen windowed.
                       #410 — during drag, preview order so values stay under their headers. */}
                  {fields.slice(0, frozenCount).map((field, i) =>
                    renderBodyCell(field, i, item.index, row),
                  )}
                  {colLeftSpacer > 0 && (
                    <div key="__cl" style={{ width: colLeftSpacer, flexShrink: 0 }} />
                  )}
                  {(isDraggingCol
                    ? previewFields
                        .slice(frozenCount)
                        .map((f) => ({ field: f, colIndex: fields.indexOf(f) }))
                    : virtualCols.map((vc) => ({
                        field: nonFrozenFields[vc.index]!,
                        colIndex: frozenCount + vc.index,
                      }))
                  ).map(({ field, colIndex }) =>
                    renderBodyCell(field, colIndex, item.index, row),
                  )}
                  {colRightSpacer > 0 && (
                    <div key="__cr" style={{ width: colRightSpacer, flexShrink: 0 }} />
                  )}
                </div>
              );
            })}
          </div>

          {/* + New row */}
          {!readOnly && (
            <button
              // #254 — the tooltip names the shortcut, from the shared registry.
              title={newRecordTitle}
              className="flex h-8 w-full items-center gap-2 px-3 text-[13px] text-muted hover:bg-hover"
              onClick={() => {
                createRecord.mutate(
                  {},
                  {
                    onSuccess: () => {
                      setCursor({ row: rows.length, col: 0 });
                      setEditing(true);
                      requestAnimationFrame(() => virtualizer.scrollToIndex(rows.length));
                    },
                  },
                );
              }}
            >
              <Plus className="h-3.5 w-3.5" /> New
            </button>
          )}
        </div>
      </div>

      {!readOnly && selected.size > 0 && (
        <BatchBar
          ws={ws}
          db={db}
          fields={fields.filter((f) => !NO_EDITOR.has(f.type) && f.type !== 'relation' && !f.isSystem)}
          relationFields={fields.filter((f) => f.type === 'relation')}
          buttonFields={fields.filter((f) => f.type === 'button')}
          exportFields={fields.filter((f) => f.type !== 'button')}
          members={memberList}
          selected={[...selected]}
          selectedRows={rows.filter((r) => selected.has(r.id))}
          moreUnloaded={Boolean(records.hasNextPage)}
          canDelete={atLeast(database.data?.my_access, 'editor')}
          onClear={() => setSelected(new Set())}
        />
      )}
    </div>
  );
}
