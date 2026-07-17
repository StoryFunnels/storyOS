'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { GripVertical, Pin, Plus } from 'lucide-react';
import { CellDisplay, CellEditor, PressButton } from '@/components/table-view/cells';
import { RelationEditor } from '@/components/table-view/relation-cell';
import type { LinkChip } from '@/components/table-view/relation-cell';
import type { Field } from '@/components/table-view/use-table-data';
import { recordHref } from '@/lib/records';
import { cn } from '@/lib/utils';
import { AUDIT_TYPES, NOT_INLINE, auditValue } from './entity-field-utils';
import type { VP } from './entity-field-utils';
import { FieldMenu, useSetFieldConfig } from './field-controls';
import { CollapseToggle } from './collection-section';

/** Inline value renderer for scalar fields (sidebar, top strip, body). */
function ScalarValue({ field, record, ws, db, rec, members, memberNames, memberImages, readOnly, onCommit }: VP & { field: Field }) {
  const [editing, setEditing] = useState(false);
  const value = AUDIT_TYPES.has(field.type) ? auditValue(field, record) : record.values[field.apiName];

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
          <Link
            key={chip.id}
            href={recordHref(ws, field.relation!.target_database_id, chip)}
            className="inline-flex max-w-full items-center truncate rounded border border-border-default bg-hover px-1.5 py-0.5 text-[12px] text-ink hover:border-border-strong"
          >
            {chip.title || 'Untitled'}
          </Link>
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
          <RelationEditor ws={ws} db={db} recordId={rec} field={field} current={chips} onDone={() => setEditing(false)} />
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
          field={field}
          value={value}
          members={members}
          onCommit={(next) => {
            setEditing(false);
            onCommit(field, next);
          }}
          onCancel={() => setEditing(false)}
        />
      </div>
    );
  }
  const empty = value === undefined || value === null || value === '';
  return (
    <div
      className={cn('min-h-6 min-w-0', !readOnly && !NOT_INLINE.has(field.type) && 'cursor-pointer')}
      onClick={() => {
        if (readOnly || NOT_INLINE.has(field.type)) return;
        if (field.type === 'checkbox') onCommit(field, !(value === true));
        else setEditing(true);
      }}
    >
      {empty ? (
        <span className="text-[13px] text-faint">Empty</span>
      ) : PROSE_TYPES.has(field.type) ? (
        <ClampedValue>
          <CellDisplay field={field} value={value} memberNames={memberNames} memberImages={memberImages} wrap />
        </ClampedValue>
      ) : (
        <CellDisplay field={field} value={value} memberNames={memberNames} memberImages={memberImages} />
      )}
    </div>
  );
}

/** Sidebar prose fields that should wrap rather than clip (MN-132). */
const PROSE_TYPES = new Set(['text', 'email', 'url', 'rich_text']);

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

/** Compact draggable property in the right sidebar (label above value). */
export function SidebarField({ field, schemaEditable, onToggleZone, ...vp }: VP & { field: Field }) {
  const sortable = useSortable({ id: field.id, disabled: !schemaEditable });
  const style = { transform: CSS.Transform.toString(sortable.transform), transition: sortable.transition };
  const collapsed = field.config?.['entity_collapsed'] === true;
  const setConfig = useSetFieldConfig(vp.ws, vp.db);
  return (
    <div
      ref={sortable.setNodeRef}
      style={style}
      className={cn(
        'group rounded-md px-1.5 py-1.5 hover:bg-hover/50',
        sortable.isDragging && 'z-10 bg-card opacity-80 shadow-sm',
      )}
    >
      <div className="mb-0.5 flex items-center gap-1">
        {schemaEditable && (
          <button
            className="-ml-1 cursor-grab touch-none text-faint opacity-0 hover:text-muted group-hover:opacity-100"
            {...sortable.attributes}
            {...sortable.listeners}
            onClick={(e) => e.stopPropagation()}
          >
            <GripVertical className="h-3 w-3" />
          </button>
        )}
        <CollapseToggle
          collapsed={collapsed}
          onToggle={() => setConfig.mutate({ fieldId: field.id, config: { entity_collapsed: !collapsed } })}
        />
        <span className="flex-1 truncate text-[11px] font-medium uppercase tracking-wide text-faint">
          {field.displayName}
        </span>
        {schemaEditable && <FieldMenu field={field} onToggleZone={onToggleZone} ws={vp.ws} db={vp.db} />}
      </div>
      {!collapsed && <ScalarValue field={field} schemaEditable={schemaEditable} onToggleZone={onToggleZone} {...vp} />}
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
        'group flex items-center gap-2 rounded-md border border-border-default bg-card px-2.5 py-1.5',
        sortable.isDragging && 'z-10 opacity-80 shadow-sm',
      )}
      {...(schemaEditable ? sortable.attributes : {})}
      {...(schemaEditable ? sortable.listeners : {})}
    >
      <span className="flex items-center gap-1 text-[11px] font-medium uppercase tracking-wide text-faint">
        <Pin className="h-3 w-3 text-accent" /> {field.displayName}
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
      <span className="flex w-40 shrink-0 items-center gap-1 pt-0.5 text-[12px] font-medium uppercase tracking-wide text-faint">
        {field.displayName}
        {schemaEditable && <FieldMenu field={field} onToggleZone={onToggleZone} ws={vp.ws} db={vp.db} />}
      </span>
      <div className="min-w-0 flex-1">
        <ScalarValue field={field} schemaEditable={schemaEditable} onToggleZone={onToggleZone} {...vp} />
      </div>
    </div>
  );
}
