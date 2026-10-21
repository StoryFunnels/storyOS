'use client';

import { useMemo, useState } from 'react';
import { GripVertical, Plus, SlidersHorizontal, X } from 'lucide-react';
import { DndContext, closestCenter } from '@dnd-kit/core';
import type { DragEndEvent } from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  DragPreview,
  useDragPresentation,
  useSortableSensors,
  vacatedSlotClass,
} from '@/components/ui/drag-presentation';
import { Segmented } from '@/components/ui/segmented';
import { cn } from '@/lib/utils';
import type { Field } from '../table-view/use-table-data';
import { isHierarchyField } from '../table-view/use-hierarchy';
import {
  countHiddenFields,
  isFieldVisible,
  toggleFieldVisibility,
} from '../table-view/number-column';
import { calendarDateDisabledReason, isCalendarDateField } from './calendar-date-fields';
import { isCoverField } from './cover-fields';
import { listGroupDisabledReason } from './groupable-fields';
import { FieldsMenu } from './fields-menu';
import { groupingPatch } from './view-grouping';
import type { ViewConfig } from './use-view-state';

/* #739 T8 — hoisted so the array identity is stable across renders (Segmented takes a readonly list). */
const ROW_HEIGHT_OPTIONS = [
  { value: '28', label: '28' },
  { value: '32', label: '32' },
  { value: '40', label: '40' },
] as const;

function GalleryNoCoverFieldNotice() {
  return (
    <p className="px-2 py-1 text-label italic text-muted">
      No cover control: this database has no attachment or URL field. Add one to use this view.
    </p>
  );
}

const SECTION =
  'block px-2 pb-0.5 pt-1.5 text-meta font-semibold uppercase tracking-wider text-muted';
const FIELD_SELECT =
  'h-7 min-w-0 max-w-[10rem] rounded-[var(--radius-control)] border border-border-default bg-card px-1.5 text-label text-ink';

function SelectRow({
  label,
  value,
  onChange,
  children,
  title,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  children: React.ReactNode;
  title?: string;
}) {
  return (
    <label
      className="flex items-center justify-between gap-3 px-2 py-1 text-label text-ink"
      title={title}
    >
      <span className="shrink-0">{label}</span>
      <select className={FIELD_SELECT} value={value} onChange={(e) => onChange(e.target.value)}>
        {children}
      </select>
    </label>
  );
}

/**
 * #964 — DISPLAY: how the view looks. Everything that used to sit loose in the toolbar (Cards, Hide
 * fields, Row height, Nest by, Cover, Date field, End field, Colour by) is one click into this menu,
 * and each view type gets only the controls it can use. Nothing here is new capability: each row
 * writes the same `ViewConfig` key the old toolbar control wrote (API-first: no capability lives
 * only in the UI).
 *
 * "Fields" on a table opens the shared FieldsMenu (search, toggle, reorder, system columns) from
 * this menu, so it is two clicks, not a second copy of that list nested in a popover.
 */
export function DisplayMenu({
  viewType,
  fields,
  rendered,
  numberEntry,
  systemDateEntries,
  config,
  onPatch,
  databaseId,
  onReorderFields,
}: {
  viewType: string;
  /** The database's own fields. */
  fields: Field[];
  /** Fields a view may show or hide (see ViewToolbar's `rendered`). */
  rendered: Field[];
  /** The synthetic permanent-number field, when the database has no real one. */
  numberEntry?: Field;
  /** Created / Last edited, offered on a table, off by default. */
  systemDateEntries: Field[];
  config: ViewConfig;
  onPatch: (updates: Partial<ViewConfig>) => void;
  databaseId?: string;
  onReorderFields?: (activeId: string, overId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [fieldsOpen, setFieldsOpen] = useState(false);

  const isTable = viewType === 'table';
  const hasCards = ['board', 'calendar', 'gallery', 'list', 'feed'].includes(viewType);
  const showsColorBy = ['list', 'feed', 'timeline', 'calendar'].includes(viewType);
  const colorFields = fields.filter((f) => f.type === 'select' || f.type === 'workflow');
  const hierarchyFields = fields.filter((f) => databaseId && isHierarchyField(f, databaseId));

  // The table's Fields list: ID first (an ordinary column there, #739), rich text absent (#739 T3),
  // the system date columns offered after the real fields and off by default (#739 AC3).
  const tableFields = useMemo(
    () => [
      ...(numberEntry ? [numberEntry] : []),
      ...rendered.filter((f) => f.type !== 'rich_text'),
      ...systemDateEntries,
    ],
    [numberEntry, rendered, systemDateEntries],
  );
  // #964 — a view type whose renderer reads `hidden_field_ids` MUST have its picker here: a timeline's left
  // panel does (timeline-view.tsx `leftFields`), so its Fields… lives in Display too — a setting the renderer
  // honours and the UI cannot write is the renderer/picker mismatch field-surfaces.md calls the bug.
  //
  // The timeline lists its REAL ID column first. The old Hide-fields button offered a "Row gutter · Show ID"
  // toggle there instead, but that wrote the synthetic `__sys_number` key, which the timeline never reads (its
  // ID column is the database's real `id` field, filtered by its own id): a switch that did nothing. Offering
  // the real field makes the one control that exists actually hide the column.
  const hasFieldsMenu = isTable || viewType === 'timeline';
  const timelineIdField = fields.find((f) => f.type === 'id');
  const fieldsMenuList = isTable
    ? tableFields
    : [...(timelineIdField ? [timelineIdField] : []), ...rendered];
  const hiddenCount = useMemo(
    () => countHiddenFields(config.hidden_field_ids, new Set(fieldsMenuList.map((f) => f.id))),
    [config.hidden_field_ids, fieldsMenuList],
  );

  // #702 — list and feed render the permanent number inline; board, calendar and gallery render it nowhere.
  const gutterEntry = viewType === 'list' || viewType === 'feed' ? numberEntry : undefined;

  const nothingToConfigure = !isTable && !hasCards && !showsColorBy && !(viewType === 'gallery');
  if (viewType === 'form' || viewType === 'dashboard' || nothingToConfigure) return null;

  const colorValue = config.color_by_field_id ?? '';

  return (
    <span className="relative inline-flex">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label="Display"
            className="flex items-center gap-1 rounded-[var(--radius-control)] px-1.5 py-1 text-label text-muted hover:bg-hover hover:text-ink"
          >
            <SlidersHorizontal className="h-3.5 w-3.5" />
            <span className="tb-display">Display</span>
          </button>
        </PopoverTrigger>
        <PopoverContent className="max-h-[28rem] w-72 overflow-y-auto p-1">
          {hasFieldsMenu && (
            <>
              <span className={SECTION}>Columns</span>
              <button
                type="button"
                className="flex w-full items-center justify-between rounded-[var(--radius-chip)] px-2 py-1.5 text-left text-label text-ink hover:bg-hover"
                onClick={() => {
                  setOpen(false);
                  setFieldsOpen(true);
                }}
              >
                Fields…
                <span className="text-muted">
                  {hiddenCount ? `${hiddenCount} hidden` : 'All shown'}
                </span>
              </button>
              {isTable && (
                <>
                  <div className="flex items-center justify-between gap-3 px-2 py-1 text-label text-ink">
                    <span>Row height</span>
                    <Segmented
                      label="Row height"
                      size="sm"
                      value={String(config.row_height ?? 32) as '28' | '32' | '40'}
                      onChange={(v) => onPatch({ row_height: Number(v) as 28 | 32 | 40 })}
                      options={ROW_HEIGHT_OPTIONS}
                    />
                  </div>
                  {hierarchyFields.length > 0 && (
                    // #233 — only once the database has an eligible self-relation: an empty picker is a
                    // worse answer than no picker.
                    <SelectRow
                      label="Nest by"
                      value={config.hierarchy_field_id ?? ''}
                      onChange={(v) => onPatch({ hierarchy_field_id: v || undefined })}
                    >
                      <option value="">Flat</option>
                      {hierarchyFields.map((f) => (
                        <option key={f.id} value={f.id}>
                          {f.displayName}
                        </option>
                      ))}
                    </SelectRow>
                  )}
                </>
              )}
            </>
          )}

          {viewType === 'gallery' && (
            <>
              <span className={SECTION}>Cover</span>
              {/* #391 / #754 — with an attachment field, the ordinary picker; without one, say so and
                  say what fixes it, instead of the control silently disappearing. */}
              {fields.some(isCoverField) ? (
                <SelectRow
                  label="Cover field"
                  value={config.cover_field_id ?? ''}
                  onChange={(v) => onPatch({ cover_field_id: v || undefined })}
                >
                  <option value="">None</option>
                  {fields.filter(isCoverField).map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.displayName}
                    </option>
                  ))}
                </SelectRow>
              ) : (
                <GalleryNoCoverFieldNotice />
              )}
            </>
          )}

          {viewType === 'calendar' && (
            <>
              <span className={SECTION}>Calendar</span>
              <SelectRow
                label="Date field"
                value={config.date_field_id ?? ''}
                onChange={(v) => onPatch({ date_field_id: v })}
              >
                {/* #808 — every date-capable field is listed; one that makes a read-only calendar is
                    disabled WITH the reason, before the choice rather than in a banner after it. */}
                {fields.filter(isCalendarDateField).map((f) => {
                  const reason = calendarDateDisabledReason(f);
                  return (
                    <option key={f.id} value={f.id} disabled={reason !== null}>
                      {f.displayName}
                      {reason ? ` — ${reason}` : ''}
                    </option>
                  );
                })}
              </SelectRow>
              {/* #470 — an OPTIONAL second date field giving a day/week event its real end time. Only
                  worth showing in day/week mode: in month mode nothing reads it. */}
              {(config.calendar_mode === 'day' || config.calendar_mode === 'week') && (
                <SelectRow
                  label="End field"
                  value={config.calendar_end_date_field_id ?? ''}
                  onChange={(v) => onPatch({ calendar_end_date_field_id: v || undefined })}
                  title="End date field (optional: sets event height)"
                >
                  <option value="">None (1h blocks)</option>
                  {fields
                    .filter((f) => f.id !== config.date_field_id && isCalendarDateField(f))
                    .map((f) => {
                      const reason = calendarDateDisabledReason(f);
                      return (
                        <option key={f.id} value={f.id} disabled={reason !== null}>
                          {f.displayName}
                          {reason ? ` — ${reason}` : ''}
                        </option>
                      );
                    })}
                </SelectRow>
              )}
            </>
          )}

          {viewType === 'list' && (
            <>
              <span className={SECTION}>Grouping</span>
              {/* The way to START grouping a list. Once on, the Group chip in the toolbar owns it. */}
              <SelectRow
                label="Group by"
                value={config.group_by_field_id ?? ''}
                onChange={(v) =>
                  onPatch(
                    groupingPatch({
                      viewType,
                      config,
                      fieldId: v,
                      isDateField: fields.find((f) => f.id === v)?.type === 'date',
                    }),
                  )
                }
              >
                <option value="">None</option>
                {fields.map((f) => {
                  const reason = listGroupDisabledReason(f);
                  return (
                    <option key={f.id} value={f.id} disabled={reason !== null}>
                      {f.displayName}
                      {reason ? ` — ${reason}` : ''}
                    </option>
                  );
                })}
              </SelectRow>
            </>
          )}

          {showsColorBy && colorFields.length > 0 && (
            <>
              <span className={SECTION}>Colour</span>
              <SelectRow
                label="Colour by"
                value={colorValue}
                onChange={(v) => onPatch({ color_by_field_id: v || undefined })}
              >
                <option value="">None</option>
                {colorFields.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.displayName}
                  </option>
                ))}
              </SelectRow>
            </>
          )}

          {hasCards && (
            <>
              {(viewType === 'board' || viewType === 'gallery') && (
                <>
                  <span className={SECTION}>Card size</span>
                  <div className="flex gap-1 px-2 pb-1.5">
                    {(['small', 'medium', 'large'] as const).map((opt) => (
                      <button
                        key={opt}
                        type="button"
                        onClick={() => onPatch({ card_size: opt })}
                        className={cn(
                          'flex-1 rounded-[var(--radius-control)] border px-1.5 py-1 text-label',
                          (config.card_size ?? 'medium') === opt
                            ? 'border-[var(--accent)] bg-accent-soft text-ink'
                            : 'border-border-default text-muted hover:bg-hover',
                        )}
                      >
                        {opt === 'small' ? 'S' : opt === 'medium' ? 'M' : 'L'}
                      </button>
                    ))}
                  </div>
                </>
              )}
              <span className={cn(SECTION, 'mt-1 border-t border-border-default pt-2')}>
                {viewType === 'calendar' ? 'Event fields' : 'Card fields'}
              </span>
              <CardFieldPicker
                fields={rendered}
                shown={config.card_field_ids}
                onChange={(card_field_ids) => onPatch({ card_field_ids })}
              />
              {gutterEntry && (
                <RowGutterToggle
                  shown={isFieldVisible(config.hidden_field_ids, gutterEntry.id)}
                  onChange={(next) =>
                    onPatch({
                      hidden_field_ids: toggleFieldVisibility(
                        config.hidden_field_ids,
                        gutterEntry.id,
                        next,
                      ),
                    })
                  }
                />
              )}
            </>
          )}
        </PopoverContent>
      </Popover>
      {hasFieldsMenu && (
        <FieldsMenu
          anchorOnly
          open={fieldsOpen}
          onOpenChange={setFieldsOpen}
          fields={fieldsMenuList}
          isVisible={(f) => isFieldVisible(config.hidden_field_ids, f.id)}
          onToggle={(f, next) =>
            onPatch({
              hidden_field_ids: toggleFieldVisibility(config.hidden_field_ids, f.id, next),
            })
          }
          onReorder={onReorderFields}
          triggerIcon={SlidersHorizontal}
          triggerLabel="Fields"
        />
      )}
    </span>
  );
}

/** Shown card fields (draggable, ordered) + a list to add more (MN-151). */
function CardFieldPicker({
  fields,
  shown,
  onChange,
}: {
  fields: Field[];
  shown: string[];
  onChange: (ids: string[]) => void;
}) {
  const sensors = useSortableSensors();
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
  const cardFieldLabel = (id: string) => fields.find((f) => f.id === id)?.displayName;
  const cardFieldDrag = useDragPresentation(cardFieldLabel, { onDragEnd }, shown);

  return (
    <>
      {shownFields.length > 0 && (
        <>
          <div className="px-2 pb-0.5 pt-1 text-meta font-semibold uppercase tracking-wider text-muted">
            Shown · drag to reorder
          </div>
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            {...cardFieldDrag.contextProps}
          >
            <SortableContext items={shown} strategy={verticalListSortingStrategy}>
              {shownFields.map((field) => (
                <SortableCardField
                  key={field.id}
                  field={field}
                  onRemove={() => onChange(shown.filter((id) => id !== field.id))}
                />
              ))}
            </SortableContext>
            <DragPreview>
              {cardFieldDrag.activeId && (
                <div className="rounded-[var(--radius-control)] border border-border-default bg-card px-2 py-1 text-label font-medium text-ink shadow-[var(--shadow-lifted)]">
                  {cardFieldLabel(cardFieldDrag.activeId) ?? ''}
                </div>
              )}
            </DragPreview>
          </DndContext>
        </>
      )}
      {available.length > 0 && (
        <>
          <div className="px-2 pb-0.5 pt-1.5 text-meta font-semibold uppercase tracking-wider text-muted">
            Add
          </div>
          {available.map((field) => (
            <button
              key={field.id}
              onClick={() => onChange([...shown, field.id])}
              className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-body text-muted hover:bg-hover hover:text-ink"
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
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: field.id,
  });
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      // #656 — this was the fourth sortable in this file with NO drag styling at
      // all; it now gets the same floating-preview + vacated-slot treatment as
      // the other three.
      className={cn(
        'group flex items-center gap-2 rounded px-2 py-1.5 text-body text-ink hover:bg-hover',
        vacatedSlotClass(isDragging),
      )}
    >
      <button
        {...attributes}
        {...listeners}
        className="cursor-grab text-faint hover:text-muted"
        title="Drag to reorder"
      >
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

/**
 * #699 AC2 / #702 — the "Row gutter" section: one control for the synthetic
 * permanent-number field, shared by every surface that actually renders it
 * (table view's Hide-fields footer, and the Cards picker on the OTHER view
 * types that render it inline — currently list and feed; #702 found
 * board/calendar/gallery render it nowhere, so they get no control at all
 * rather than one with no effect). Extracted so a future surface that starts
 * rendering the number reuses this instead of re-casing the toggle a third
 * time (field-surfaces.md's rule).
 */
function RowGutterToggle({
  shown,
  onChange,
}: {
  shown: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <div className="mt-1 border-t border-border-default pt-1">
      <p className="px-1.5 pb-1 text-meta font-medium uppercase tracking-wide text-muted">
        Row gutter
      </p>
      <button
        type="button"
        role="switch"
        aria-checked={shown}
        onClick={() => onChange(!shown)}
        className="flex w-full items-center gap-2 rounded px-1.5 py-1.5 text-left text-body text-ink hover:bg-hover"
      >
        <span
          className={cn(
            'flex h-4 w-7 shrink-0 items-center rounded-full px-0.5 transition-colors',
            shown ? 'justify-end bg-accent' : 'justify-start bg-border-default',
          )}
        >
          <span className="h-3 w-3 rounded-full bg-card" />
        </span>
        {/* #743 — "ID" only; "Number" is the pre-#743 label and must not
            reappear anywhere in the UI now that the field is visible by
            default. */}
        <span className="truncate">Show ID in the row gutter</span>
      </button>
    </div>
  );
}
