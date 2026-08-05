'use client';

import { useState } from 'react';
import { ChevronRight, GripVertical } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { DndContext, PointerSensor, closestCenter, useSensor, useSensors } from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import type { Field } from '../table-view/use-table-data';
import { fieldTypeIcon } from './field-type-icon';

/**
 * #175 — the Fibery-parity Fields menu, shared by every surface that toggles
 * field/column visibility (the record-view field picker, the view toolbar's
 * Hide-fields panel, and the relation collection sub-table). Extracting it here
 * means those surfaces can't drift apart.
 *
 * Each row shows: a drag handle (when reorderable), a toggle switch that's
 * filled/coloured when the field is ON, the field-type icon, the field name, and
 * — where the field carries sub-options — a chevron affordance.
 *
 * Persistence is the caller's job: each surface wires `onToggle`/`onReorder` to
 * whatever mechanism it already uses (record `entity_hidden`/`entity_order`,
 * table `field.position`, or the collection view's `fields` array), so this
 * component owns only the presentation + the search/drag interactions.
 */
export function FieldsMenu({
  fields,
  isVisible,
  onToggle,
  onReorder,
  isReorderable,
  onOpenConfig,
  hasConfig,
  triggerIcon: TriggerIcon,
  triggerLabel,
  triggerActive = false,
  iconOnly = false,
  align = 'start',
  searchPlaceholder = 'Filter fields…',
  emptyLabel = 'No fields.',
}: {
  fields: Field[];
  isVisible: (field: Field) => boolean;
  onToggle: (field: Field, next: boolean) => void;
  /** When supplied, rows grow a drag handle; the caller persists the new order.
   * `activeId`/`overId` are `field.id`s, matching the table's reorder helper. */
  onReorder?: (activeId: string, overId: string) => void;
  /** Which rows may be dragged — defaults to "every non-system field" when
   * `onReorder` is supplied. System fields keep their fixed slots. */
  isReorderable?: (field: Field) => boolean;
  /** Chevron affordance: only rendered for fields where `hasConfig` is true. */
  onOpenConfig?: (field: Field) => void;
  hasConfig?: (field: Field) => boolean;
  triggerIcon: LucideIcon;
  triggerLabel: string;
  triggerActive?: boolean;
  /** Render the trigger as a uniform icon-only button (the record header's icon
   * cluster, #197) — `triggerLabel` becomes the tooltip instead of visible text. */
  iconOnly?: boolean;
  align?: 'start' | 'end';
  searchPlaceholder?: string;
  emptyLabel?: string;
}) {
  const [q, setQ] = useState('');
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  const canReorder = (field: Field) =>
    Boolean(onReorder) && (isReorderable ? isReorderable(field) : !field.isSystem);

  const list = fields.filter((f) => f.displayName.toLowerCase().includes(q.trim().toLowerCase()));
  const reorderableIds = onReorder ? list.filter(canReorder).map((f) => f.id) : [];

  const rows = list.map((field) => (
    <FieldRow
      key={field.id}
      field={field}
      on={isVisible(field)}
      reorderable={canReorder(field)}
      onToggle={(next) => onToggle(field, next)}
      onOpenConfig={onOpenConfig && hasConfig?.(field) ? () => onOpenConfig(field) : undefined}
    />
  ));

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {iconOnly ? (
          <button
            title={triggerLabel}
            aria-label={triggerLabel}
            className={cn(
              'inline-flex h-7 w-7 shrink-0 items-center justify-center rounded transition-colors hover:bg-hover hover:text-ink',
              triggerActive ? 'text-ink' : 'text-muted',
            )}
          >
            <TriggerIcon className="h-4 w-4" />
          </button>
        ) : (
          <button
            className={cn(
              'flex items-center gap-1 rounded px-1.5 py-1 text-[12px] hover:bg-hover hover:text-ink',
              triggerActive ? 'text-ink' : 'text-muted',
            )}
          >
            <TriggerIcon className="h-3.5 w-3.5" /> {triggerLabel}
          </button>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align={align} className="w-64">
        <input
          autoFocus
          placeholder={searchPlaceholder}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          // Radix menus grab keystrokes for typeahead — keep them in the box.
          onKeyDown={(e) => e.stopPropagation()}
          className="mb-1 w-full rounded border border-border-default bg-card px-2 py-1 text-[13px] text-ink outline-none placeholder:text-faint"
        />
        <div className="max-h-72 overflow-y-auto">
          {onReorder ? (
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragEnd={(e) => {
                if (e.over && e.active.id !== e.over.id) onReorder(String(e.active.id), String(e.over.id));
              }}
            >
              <SortableContext items={reorderableIds} strategy={verticalListSortingStrategy}>
                {rows}
              </SortableContext>
            </DndContext>
          ) : (
            rows
          )}
          {list.length === 0 && <p className="px-2 py-1.5 text-[12px] text-faint">{emptyLabel}</p>}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function FieldRow({
  field,
  on,
  reorderable,
  onToggle,
  onOpenConfig,
}: {
  field: Field;
  on: boolean;
  reorderable: boolean;
  onToggle: (next: boolean) => void;
  onOpenConfig?: () => void;
}) {
  // Always called (safe outside a DndContext — returns no-op refs); `disabled`
  // gates the actual drag, mirroring the table's HiddenFieldRow.
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: field.id,
    disabled: !reorderable,
  });
  const Icon = fieldTypeIcon(field.type);
  return (
    <div
      ref={reorderable ? setNodeRef : undefined}
      style={reorderable ? { transform: CSS.Transform.toString(transform), transition } : undefined}
      className={cn(
        'group/fm flex items-center gap-1 rounded px-1.5 py-1.5 text-[13px] text-ink hover:bg-hover',
        isDragging && 'opacity-50',
      )}
    >
      {reorderable ? (
        <button
          className="-ml-1 shrink-0 cursor-grab touch-none text-faint opacity-0 hover:text-muted group-hover/fm:opacity-100"
          title="Drag to reorder"
          onClick={(e) => e.preventDefault()}
          {...attributes}
          {...listeners}
        >
          <GripVertical className="h-3.5 w-3.5" />
        </button>
      ) : (
        <span className="w-2.5 shrink-0" />
      )}
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-label={`Show ${field.displayName}`}
        onClick={() => onToggle(!on)}
        className="flex min-w-0 flex-1 items-center gap-2 text-left"
      >
        <span
          className={cn(
            'flex h-4 w-7 shrink-0 items-center rounded-full px-0.5 transition-colors',
            on ? 'justify-end bg-accent' : 'justify-start bg-border-default',
          )}
        >
          <span className="h-3 w-3 rounded-full bg-card" />
        </span>
        <Icon className="h-3.5 w-3.5 shrink-0 text-faint" />
        <span className="truncate">{field.displayName}</span>
      </button>
      {onOpenConfig && (
        <button
          type="button"
          onClick={onOpenConfig}
          title="Field options"
          className="shrink-0 rounded p-0.5 text-faint opacity-0 hover:bg-active hover:text-ink group-hover/fm:opacity-100"
        >
          <ChevronRight className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}
