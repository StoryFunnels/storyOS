'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Check, GripVertical, Plus, X } from 'lucide-react';
import { api } from '@/lib/api';
import { CellDisplay, CellEditor, EmptyFieldAffordance, PressButton, formatNumberValue, isPercentNumberField } from '@/components/table-view/cells';
import { DbColorMarker, RelationEditor, patchRelationProjection } from '@/components/table-view/relation-cell';
import type { LinkChip } from '@/components/table-view/relation-cell';
import type { Field } from '@/components/table-view/use-table-data';
import { fieldTypeIcon } from '@/components/views/field-type-icon';
import { Popover, PopoverContent, PopoverParentAnchor } from '@/components/ui/popover';
import { recordHref, recordSegment } from '@/lib/records';
import { cn } from '@/lib/utils';
import { useDatabases, useSpaces } from '@/lib/queries';
import type { DatabaseSummary, Space } from '@/lib/queries';
import { qualifiedDatabaseLabel, resolveDatabaseIds, serializeDatabaseIds } from '@/lib/database-labels';
import { AUDIT_TYPES, NOT_INLINE, auditValue } from './entity-field-utils';
import type { VP } from './entity-field-utils';
import { FieldMenu } from './field-controls';
import { useOpenInSplit } from './split-panel-context';

/**
 * Remove a single link from a relation field, reusing the tested links-replace
 * endpoint + optimistic projection patch from RelationEditor so the sidebar chip
 * updates instantly (#176 inline chip remove ×).
 */
function useRemoveRelationLink(ws: string, db: string, recordId: string, field: Field) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (chips: LinkChip[]) => {
      const { error } = await api.PUT('/api/v1/workspaces/{ws}/databases/{db}/records/{rec}/links/{field}', {
        params: { path: { ws, db, rec: recordId, field: field.id } },
        body: { record_ids: chips.map((c) => c.id) },
      });
      if (error) throw error;
    },
    onMutate: async (chips) => {
      const recordsKey = ['records', ws, db];
      const recordKey = ['record', ws, db];
      await qc.cancelQueries({ queryKey: recordsKey });
      await qc.cancelQueries({ queryKey: recordKey });
      const previous = [
        ...qc.getQueriesData({ queryKey: recordsKey }),
        ...qc.getQueriesData({ queryKey: recordKey }),
      ];
      const patch = (old: unknown) => patchRelationProjection(old, recordId, field.apiName, chips);
      qc.setQueriesData({ queryKey: recordsKey }, patch);
      qc.setQueriesData({ queryKey: recordKey }, patch);
      return { previous };
    },
    onError: (_err, _vars, context) => {
      for (const [k, v] of (context?.previous ?? []) as Array<[unknown, unknown]>) {
        qc.setQueryData(k as never, v as never);
      }
      toast.error('Could not update links');
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ['records', ws, db] });
      void qc.invalidateQueries({ queryKey: ['record', ws, db] });
    },
  });
}

/**
 * Inline value renderer for scalar fields (sidebar, top strip, body). `cell`
 * wraps the editable value in a subtle bordered/hover cell (Fibery-parity
 * Properties panel, #176) so the value area reads as a clickable control.
 */
function ScalarValue({ field, cell, record, ws, db, rec, members, memberNames, memberImages, readOnly, onCommit }: VP & { field: Field; cell?: boolean }) {
  const [editing, setEditing] = useState(false);
  const value = AUDIT_TYPES.has(field.type) ? auditValue(field, record) : record.values[field.apiName];
  const databases = useDatabases(ws);
  const spaces = useSpaces(ws);
  const removeLink = useRemoveRelationLink(ws, db, record.id, field);
  // #146: a single-relation chip on the record page opens its target in the
  // split side panel (desktop ≥ md); a no-op elsewhere / on mobile.
  const openInSplit = useOpenInSplit();

  // MN-126: audit fields are read-only and sourced from the record row. CellDisplay
  // already renders created_at/updated_at as datetimes and created_by as a person.
  if (AUDIT_TYPES.has(field.type)) {
    return value === undefined || value === null ? (
      <span className="text-[13px] text-faint">—</span>
    ) : (
      <CellDisplay field={field} value={value} memberNames={memberNames} memberImages={memberImages} />
    );
  }

  if (field.type === 'relation') {
    // Single reference (collections render as their own body section).
    const chips = (value as LinkChip[]) ?? [];
    return (
      <div className="relative flex flex-wrap items-center gap-1">
        {chips.map((chip) => (
          // #176: consistent chip control — the title opens the target (split
          // panel / navigation), the × unlinks it (only when editable). The ×
          // is a sibling of the link, never nested, so their clicks can't reach
          // each other.
          <span
            key={chip.id}
            className="inline-flex max-w-full items-center gap-1 rounded border border-border-default bg-hover px-1.5 py-0.5 text-[12px] text-ink hover:border-border-strong"
          >
            <Link
              href={recordHref(ws, field.relation!.target_database_id, chip)}
              onClick={openInSplit({
                db: field.relation!.target_database_id,
                rec: recordSegment(chip),
                title: chip.title,
                number: chip.number,
              })}
              className="flex min-w-0 items-center gap-1 truncate hover:underline"
            >
              <DbColorMarker color={field.relation?.target_database_color} />
              <span className="truncate">{chip.title || 'Untitled'}</span>
            </Link>
            {!readOnly && (
              <button
                type="button"
                aria-label={`Remove ${chip.title || 'Untitled'}`}
                className="shrink-0 text-faint hover:text-error"
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  removeLink.mutate(chips.filter((c) => c.id !== chip.id));
                }}
              >
                <X className="h-3 w-3" />
              </button>
            )}
          </span>
        ))}
        {!readOnly && (
          <button
            className="inline-flex items-center gap-0.5 rounded border border-dashed border-border-default px-1.5 py-0.5 text-[12px] text-muted hover:border-border-strong hover:text-ink"
            onClick={() => setEditing(true)}
          >
            <Plus className="h-3 w-3" /> {chips.length === 0 && 'Add'}
          </button>
        )}
        {editing && (
          <RelationEditor ws={ws} db={db} recordId={record.id} field={field} current={chips} onDone={() => setEditing(false)} />
        )}
      </div>
    );
  }
  if (field.apiName === 'target_databases') {
    // #105: the #317 fix swapped raw UUIDs for qualified "Space / Database"
    // chips but dropped every edit affordance, leaving the field read-only in
    // the record panel. Restore editing: chips open a multi-database picker
    // that persists through the same record-update mutation (onCommit) the
    // field used before, while keeping the qualified labels and the red
    // "Unavailable database" chip for dangling ids.
    const targets = resolveDatabaseIds(value, databases.data ?? [], spaces.data ?? []);
    const selectedIds = targets.map((target) => target.id);
    const save = (ids: string[]) => onCommit(field, serializeDatabaseIds(ids));
    return (
      <div className="relative flex flex-wrap items-center gap-1">
        {targets.map((target) => (
          <span
            key={target.id}
            className={cn(
              'inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[12px]',
              target.missing
                ? 'border-error/40 bg-error/5 text-error'
                : 'border-border-default bg-hover text-ink',
              !readOnly && 'cursor-pointer hover:border-border-strong',
            )}
            onClick={readOnly ? undefined : () => setEditing(true)}
          >
            {target.label}
            {!readOnly && (
              <button
                type="button"
                aria-label={`Remove ${target.label}`}
                className="text-faint hover:text-ink"
                onClick={(event) => {
                  event.stopPropagation();
                  save(selectedIds.filter((id) => id !== target.id));
                }}
              >
                <X className="h-3 w-3" />
              </button>
            )}
          </span>
        ))}
        {targets.length === 0 && readOnly && <span className="text-[13px] text-faint">Empty</span>}
        {!readOnly && (
          <button
            type="button"
            className="inline-flex items-center gap-0.5 rounded border border-dashed border-border-default px-1.5 py-0.5 text-[12px] text-muted hover:border-border-strong hover:text-ink"
            onClick={() => setEditing(true)}
          >
            <Plus className="h-3 w-3" /> {targets.length === 0 && 'Add'}
          </button>
        )}
        {editing && (
          <DatabasePicker
            databases={databases.data ?? []}
            spaces={spaces.data ?? []}
            selected={selectedIds}
            onToggle={save}
            onClose={() => setEditing(false)}
          />
        )}
      </div>
    );
  }
  if (field.type === 'button') return <PressButton ws={ws} db={db} recordId={rec} field={field} disabled={readOnly} />;
  if (editing) {
    // relative anchor so absolute-positioned option lists / pickers drop under the field
    return (
      <div className="relative min-h-6">
        <CellEditor
          ws={ws}
          db={db}
          field={field}
          value={value}
          members={members}
          onCommit={(next) => {
            setEditing(false);
            onCommit(field, next);
          }}
          // MN-279: multi-select toggles persist immediately without closing
          // the popover — bypasses the setEditing(false) above.
          onToggleImmediate={(next) => onCommit(field, next)}
          onCancel={() => setEditing(false)}
        />
      </div>
    );
  }
  const empty = value === undefined || value === null || value === '';
  // Inline-editable when not read-only and not a computed/audit type (NOT_INLINE).
  const editableInline = !readOnly && !NOT_INLINE.has(field.type);
  return (
    <div
      className={cn(
        'min-h-6 min-w-0',
        // #176: subtle bordered/hover cell so the value reads as an editable
        // control. Transparent by default; the border + hover only earn their
        // place when the value can actually be edited.
        // #206: -mx-1.5 bleeds the cell's inner padding outward so the value's
        // text left edge stays flush with the label row (and with chip values,
        // which have no cell) — the box breathes without shifting the value.
        cell && '-mx-1.5 rounded-[var(--radius-control)] border border-transparent px-1.5 py-1 transition-colors',
        cell && editableInline && 'hover:border-border-default hover:bg-hover/60',
        editableInline && 'cursor-pointer',
      )}
      onClick={() => {
        if (!editableInline) return;
        if (field.type === 'checkbox') onCommit(field, !(value === true));
        else setEditing(true);
      }}
    >
      {empty ? (
        // #176/#187: empty renders as a faint, clickable ghost affordance inside
        // the cell ("Add/Set <field>"), not dead gray text. Computed / read-only
        // fields show a neutral em dash instead (no fake affordance).
        <EmptyFieldAffordance field={field} editable={editableInline} />
      ) : isPercentNumberField(field) ? (
        // #179: a percent-formatted number renders as a value + subtle filled
        // track (Fibery parity) — only for explicitly percent-formatted number
        // fields, never guessed from a raw number.
        <PercentBar field={field} value={value} />
      ) : PROSE_TYPES.has(field.type) ? (
        <ClampedValue>
          {/* #317: ws lets CellDisplay resolve agent-config ref ids (database /
              state_field / state_option) to labels instead of raw UUIDs. */}
          <CellDisplay field={field} value={value} memberNames={memberNames} memberImages={memberImages} ws={ws} wrap />
        </ClampedValue>
      ) : (
        <CellDisplay field={field} value={value} memberNames={memberNames} memberImages={memberImages} ws={ws} />
      )}
    </div>
  );
}

/** Sidebar prose fields that should wrap rather than clip (MN-132). */
const PROSE_TYPES = new Set(['text', 'email', 'url', 'rich_text']);

/**
 * #105: a searchable multi-database picker for the agent `target_databases`
 * field. No shared multi-database picker existed (the integrations pages use
 * single-select native `<select>`s), so this is the minimal one. It mirrors the
 * MN-279 multi-select popover: each toggle persists immediately via `onToggle`
 * (parent saves the comma-separated id list) while the popover stays open.
 * Databases are shown with their qualified "Space / Database" label so
 * duplicate names stay distinguishable.
 */
function DatabasePicker({
  databases,
  spaces,
  selected,
  onToggle,
  onClose,
}: {
  databases: DatabaseSummary[];
  spaces: Space[];
  selected: string[];
  onToggle: (ids: string[]) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const trimmed = query.trim().toLowerCase();
  const options = databases
    .map((database) => ({ id: database.id, label: qualifiedDatabaseLabel(database, spaces) }))
    .filter((option) => (trimmed ? option.label.toLowerCase().includes(trimmed) : true))
    .sort((a, b) => a.label.localeCompare(b.label));

  const toggle = (id: string) =>
    onToggle(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);

  return (
    <Popover open onOpenChange={(open) => !open && onClose()}>
      <PopoverParentAnchor />
      <PopoverContent
        className="flex max-h-80 w-64 flex-col gap-1 p-1"
        onClick={(e) => e.stopPropagation()}
      >
        <input
          autoFocus
          value={query}
          placeholder="Search databases…"
          className="w-full rounded border border-border-default bg-card px-2 py-1 text-[13px] text-ink outline-none placeholder:text-faint"
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="max-h-60 overflow-y-auto">
          {options.map((option) => {
            const isSelected = selected.includes(option.id);
            return (
              <button
                key={option.id}
                type="button"
                className="flex w-full items-center justify-between gap-2 rounded px-2 py-1.5 text-left text-[13px] text-ink hover:bg-hover"
                onClick={() => toggle(option.id)}
              >
                <span className="flex min-w-0 items-center gap-2">
                  <input type="checkbox" readOnly checked={isSelected} />
                  <span className="truncate">{option.label}</span>
                </span>
                {isSelected && <Check className="h-3.5 w-3.5 shrink-0 text-accent" />}
              </button>
            );
          })}
          {options.length === 0 && (
            <p className="px-2 py-1.5 text-[12px] text-faint">No databases</p>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

/**
 * MN-132: wrap a long value to a few lines, with expand-on-click. Measures whether
 * the content actually overflows the clamp so the toggle only shows when it earns
 * its place. Clicking the toggle must not open the field editor — hence stopPropagation.
 */
function ClampedValue({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setOverflows(el.scrollHeight > el.clientHeight + 1);
  }, [children, expanded]);

  return (
    <div className="min-w-0">
      <div ref={ref} className={cn('min-w-0', !expanded && 'line-clamp-4')}>
        {children}
      </div>
      {(overflows || expanded) && (
        <button
          type="button"
          className="mt-0.5 text-[11px] text-muted hover:text-ink"
          onClick={(e) => {
            e.stopPropagation();
            setExpanded((v) => !v);
          }}
        >
          {expanded ? 'Show less' : 'Show more'}
        </button>
      )}
    </div>
  );
}

/**
 * #179: percent value + a subtle progress track. The value stores the percentage
 * itself (57 → 57%), so the fill is `clamp(value, 0, 100)%`. Track uses the
 * neutral border token; the fill uses --accent — matching the panel's token
 * language without introducing a new colour. `aria-hidden` on the bar: the
 * formatted number above it is the accessible value, the bar is decoration.
 */
function PercentBar({ field, value }: { field: Field; value: unknown }) {
  const n = Number(value);
  const fill = Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : 0;
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[13px] tabular-nums text-ink-secondary">{formatNumberValue(field, value)}</span>
      <div className="h-1 w-full overflow-hidden rounded-full bg-[var(--border-default)]" aria-hidden>
        <div className="h-full rounded-full bg-[var(--accent)] transition-[width]" style={{ width: `${fill}%` }} />
      </div>
    </div>
  );
}

/**
 * #206: a field's identity — its type icon + label — must read identically
 * wherever the field is placed (sidebar, top strip, body). Same icon size
 * (h-3.5), same gap, same label style. Single source so the three placements
 * can't drift apart. The #176 type icon lives here.
 */
const FIELD_LABEL_CLS = 'text-[12px] font-medium text-muted';

function FieldTypeGlyph({ type, className }: { type: string; className?: string }) {
  const Icon = fieldTypeIcon(type);
  return <Icon className={cn('h-3.5 w-3.5 shrink-0 text-faint', className)} aria-hidden />;
}

/** Compact draggable property in the right sidebar (label above value). */
export function SidebarField({ field, schemaEditable, onToggleZone, topDivider, ...vp }: VP & { field: Field; topDivider?: boolean }) {
  const sortable = useSortable({ id: field.id, disabled: !schemaEditable });
  const style = { transform: CSS.Transform.toString(sortable.transform), transition: sortable.transition };
  return (
    <div
      ref={sortable.setNodeRef}
      style={style}
      className={cn(
        'group relative rounded-md py-1.5 pl-1.5 pr-1.5 hover:bg-hover/50',
        // #179: a hairline + a touch more breathing room above the first system
        // field (created/updated/by) sets the read-only audit block apart from
        // the user's own properties without a heavy divider.
        topDivider && 'mt-1.5 border-t border-border-default/60 pt-2.5',
        sortable.isDragging && 'z-10 bg-card opacity-80 shadow-sm',
      )}
    >
      {/* #209: drag grip pulled OUT of the label's flow (absolute) so it no
          longer indents the label past the value. Appears on row hover. */}
      {schemaEditable && (
        <button
          aria-label="Drag to reorder"
          title="Drag to reorder"
          className={cn(
            'absolute left-0.5 top-2 z-10 flex h-5 w-5 touch-none items-center justify-center rounded text-faint opacity-0 transition-opacity hover:bg-hover hover:text-muted group-hover:opacity-100',
            sortable.isDragging ? 'cursor-grabbing' : 'cursor-grab',
          )}
          {...sortable.attributes}
          {...sortable.listeners}
          onClick={(e) => e.stopPropagation()}
        >
          <GripVertical className="h-3.5 w-3.5" />
        </button>
      )}
      {/* #209: two-column layout — the type icon lives in a fixed gutter, and the
          label text + value stack in the second column so they share ONE left
          edge. The value cell's -mx-1.5 (below) now bleeds relative to this
          column, landing the value flush under the label — no more drift. */}
      <div className="flex gap-1.5">
        <FieldTypeGlyph type={field.type} className="mt-[3px]" />
        <div className="min-w-0 flex-1">
          <div className="mb-0.5 flex items-center gap-1">
            {/* #174: labels stay text-muted (readable); #176: Title-case-ish, not
                all-caps, for Fibery parity. #206: shared label style. */}
            <span className={cn('flex-1 truncate', FIELD_LABEL_CLS)}>{field.displayName}</span>
            {schemaEditable && <FieldMenu field={field} onToggleZone={onToggleZone} ws={vp.ws} db={vp.db} />}
          </div>
          <ScalarValue field={field} cell schemaEditable={schemaEditable} onToggleZone={onToggleZone} {...vp} />
        </div>
      </div>
    </div>
  );
}

/** Pinned essential in the top strip (label + value inline). */
export function TopChip({ field, schemaEditable, onToggleZone, ...vp }: VP & { field: Field }) {
  const sortable = useSortable({ id: field.id, disabled: !schemaEditable });
  const style = { transform: CSS.Transform.toString(sortable.transform), transition: sortable.transition };
  return (
    <div
      ref={sortable.setNodeRef}
      style={style}
      className={cn(
        'group flex items-center gap-1.5 rounded-md border border-border-default bg-card px-2.5 py-1.5',
        schemaEditable && (sortable.isDragging ? 'cursor-grabbing' : 'cursor-grab'),
        sortable.isDragging && 'z-10 opacity-80 shadow-sm',
      )}
      {...(schemaEditable ? sortable.attributes : {})}
      {...(schemaEditable ? sortable.listeners : {})}
    >
      {schemaEditable && (
        <GripVertical
          aria-hidden
          className="-ml-1.5 h-3.5 w-3.5 shrink-0 text-faint opacity-0 transition-opacity group-hover:opacity-100"
        />
      )}
      {/* #206: same type icon + label treatment as the sidebar / body — a field
          reads identically wherever it's placed. (The top strip already means
          "pinned"; the type icon replaces the redundant pin glyph.) */}
      <span className="flex items-center gap-1">
        <FieldTypeGlyph type={field.type} />
        <span className={FIELD_LABEL_CLS}>{field.displayName}</span>
      </span>
      <div onPointerDown={(e) => e.stopPropagation()}>
        <ScalarValue field={field} schemaEditable={schemaEditable} onToggleZone={onToggleZone} {...vp} />
      </div>
      {schemaEditable && (
        <span onPointerDown={(e) => e.stopPropagation()}>
          <FieldMenu field={field} onToggleZone={onToggleZone} ws={vp.ws} db={vp.db} />
        </span>
      )}
    </div>
  );
}

/** A scalar field the user moved into the main body (full-width, label left). */
export function BodyScalar({ field, schemaEditable, onToggleZone, ...vp }: VP & { field: Field }) {
  return (
    <div className="group mb-4 flex items-start gap-3 border-b border-border-default pb-3">
      {/* #206: same type icon + label treatment as the sidebar / top strip. */}
      <span className={cn('flex w-40 shrink-0 items-center gap-1 pt-0.5', FIELD_LABEL_CLS)}>
        <FieldTypeGlyph type={field.type} />
        <span className="truncate">{field.displayName}</span>
        {schemaEditable && <FieldMenu field={field} onToggleZone={onToggleZone} ws={vp.ws} db={vp.db} />}
      </span>
      <div className="min-w-0 flex-1">
        <ScalarValue field={field} schemaEditable={schemaEditable} onToggleZone={onToggleZone} {...vp} />
      </div>
    </div>
  );
}
