'use client';

import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { DndContext, closestCenter } from '@dnd-kit/core';
import type { DragEndEvent } from '@dnd-kit/core';
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { GripVertical, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { Select } from '@/components/ui/select';
import { STATE_CATEGORY_OPTIONS, categoryEditable } from '@/lib/state-category-labels';
import type { StateCategory } from '@storyos/schemas';
import type { Field } from './use-table-data';
import { OptionAppearance, nextColor, useFieldMutations } from './field-dialog-shared';
import type { OptionDraft } from './field-dialog-shared';
import { choiceDirectionLabels, reorderedIds } from '../views/option-order';
import { useDragPresentation, useSortableSensors } from '@/components/ui/drag-presentation';

let draftKey = 0;

/** Draft options for a field being created: color dot, Enter-to-add, auto palette. */
export function DraftOptionsEditor({
  options,
  onChange,
}: {
  options: OptionDraft[];
  onChange: (options: OptionDraft[]) => void;
}) {
  const [pending, setPending] = useState('');

  function addPending() {
    const label = pending.trim();
    if (!label) return;
    if (options.some((o) => o.label.toLowerCase() === label.toLowerCase())) {
      toast.error('That option already exists');
      return;
    }
    onChange([...options, { key: draftKey++, label, color: nextColor(options.map((o) => o.color)) }]);
    setPending('');
  }

  return (
    <div className="flex flex-col gap-1.5">
      {options.map((option) => (
        <div key={option.key} className="flex items-center gap-2">
          <OptionAppearance
            icon={option.icon}
            color={option.color}
            onChange={(patch) =>
              onChange(
                options.map((o) =>
                  o.key === option.key
                    ? {
                        ...o,
                        ...(patch.color !== undefined && patch.color !== null ? { color: patch.color } : {}),
                        ...(patch.icon !== undefined ? { icon: patch.icon } : {}),
                      }
                    : o,
                ),
              )
            }
          />
          <Input
            className="h-8"
            value={option.label}
            onChange={(e) =>
              onChange(options.map((o) => (o.key === option.key ? { ...o, label: e.target.value } : o)))
            }
          />
          <button
            type="button"
            className="p-1 text-faint hover:text-error"
            onClick={() => onChange(options.filter((o) => o.key !== option.key))}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}
      <div className="flex items-center gap-2">
        <Input
          className="h-8"
          placeholder={options.length === 0 ? 'First option…' : 'Add another…'}
          value={pending}
          onChange={(e) => setPending(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              addPending();
            }
          }}
        />
        <Button type="button" variant="secondary" size="sm" onClick={addPending} disabled={!pending.trim()}>
          <Plus className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
}

/** Options on an existing field: rename inline, recolor via palette, drag to reorder, delete. */
export function LiveOptionsEditor({ ws, db, field }: { ws: string; db: string; field: Field }) {
  const confirm = useConfirm();
  const { invalidate } = useFieldMutations(ws, db);
  const options = field.options ?? [];
  const [pending, setPending] = useState('');
  const sensors = useSortableSensors();

  const addOption = useMutation({
    mutationFn: async (label: string) => {
      const { error } = await api.POST(
        '/api/v1/workspaces/{ws}/databases/{db}/fields/{field}/options',
        {
          params: { path: { ws, db, field: field.id } },
          body: { label, color: nextColor(options.map((o) => o.color)) } as never,
        },
      );
      if (error) throw error;
    },
    onSuccess: invalidate,
    onError: () => toast.error('Could not add the option'),
  });

  const patchOption = useMutation({
    mutationFn: async ({ id, ...body }: { id: string; label?: string; color?: string; icon?: string | null; position?: number; category?: StateCategory | null }) => {
      const { error } = await api.PATCH(
        '/api/v1/workspaces/{ws}/databases/{db}/fields/{field}/options/{option}',
        { params: { path: { ws, db, field: field.id, option: id } }, body: body as never },
      );
      if (error) throw error;
    },
    onSuccess: invalidate,
    onError: () => toast.error('Could not save that'),
  });

  // #963 — ONE atomic call per drag: POST .../options/reorder takes the full ordered id list (#961), so a
  // half-applied reorder cannot exist. Then the field, its views' rows and a board's columns refetch once
  // (`invalidate` covers the database's field.options and the records' sort that follows them).
  // The path is cast until PR 1149's generated SDK lands on main.
  const reorder = useMutation({
    mutationFn: async (order: string[]) => {
      const { error } = await api.POST(
        '/api/v1/workspaces/{ws}/databases/{db}/fields/{field}/options/reorder' as never,
        { params: { path: { ws, db, field: field.id } }, body: { order } } as never,
      );
      if (error) throw new Error('reorder failed');
    },
    onSettled: invalidate,
    onError: () => toast.error('Could not save the new order'),
  });

  const removeOption = useMutation({
    mutationFn: async (id: string) => {
      const res = await api.DELETE(
        '/api/v1/workspaces/{ws}/databases/{db}/fields/{field}/options/{option}',
        { params: { path: { ws, db, field: field.id, option: id } }, body: { confirm: false } },
      );
      if (res.error) {
        const message = (res.error as { error?: { message?: string } }).error?.message ?? '';
        if (message.includes('confirm')) {
          if (
            await confirm({
              title: 'Clear option',
              message: `${message.split('.')[0]}. Clear it from those records?`,
              confirmLabel: 'Clear',
              danger: true,
            })
          ) {
            const forced = await api.DELETE(
              '/api/v1/workspaces/{ws}/databases/{db}/fields/{field}/options/{option}',
              { params: { path: { ws, db, field: field.id, option: id } }, body: { confirm: true } },
            );
            if (forced.error) throw forced.error;
            return;
          }
          return;
        }
        throw res.error;
      }
    },
    onSuccess: invalidate,
  });

  function onDragEnd(event: DragEndEvent) {
    const from = options.findIndex((o) => o.id === event.active.id);
    const to = options.findIndex((o) => o.id === event.over?.id);
    const order = reorderedIds(
      options.map((o) => o.id),
      from,
      to,
    );
    if (order) reorder.mutate(order);
  }

  function addPending() {
    const label = pending.trim();
    if (!label) return;
    if (options.some((o) => o.label.toLowerCase() === label.toLowerCase())) {
      toast.error('That option already exists');
      return;
    }
    addOption.mutate(label);
    setPending('');
  }

  // #985 — an option is announced by its label, never its uuid.
  const optionDrag = useDragPresentation(
    (id) => options.find((o) => o.id === id)?.label,
    { onDragEnd },
    options.map((o) => o.id),
  );

  return (
    <div className="flex flex-col gap-1.5">
      <DndContext sensors={sensors} collisionDetection={closestCenter} {...optionDrag.contextProps}>
        <SortableContext items={options.map((o) => o.id)} strategy={verticalListSortingStrategy}>
          {options.map((option, index) => (
            <SortableOptionRow
              key={option.id}
              position={index + 1}
              option={option}
              onRecolor={(color) => patchOption.mutate({ id: option.id, color })}
              onSetIcon={(icon) => patchOption.mutate({ id: option.id, icon })}
              onRename={(label) => patchOption.mutate({ id: option.id, label })}
              categoryMode={categoryEditable(field.type)}
              onSetCategory={(category) => patchOption.mutate({ id: option.id, category })}
              onRemove={() => removeOption.mutate(option.id)}
            />
          ))}
        </SortableContext>
      </DndContext>
      <div className="flex items-center gap-2 pl-6">
        <Input
          className="h-8"
          placeholder={options.length === 0 ? 'First option…' : 'Add another…'}
          value={pending}
          onChange={(e) => setPending(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              addPending();
            }
          }}
        />
        <Button type="button" variant="secondary" size="sm" onClick={addPending} disabled={!pending.trim()}>
          <Plus className="h-3.5 w-3.5" />
        </Button>
      </div>
      {/* #963 — the numbers are this editor's alone: they ARE the sort order and the board's column
          order, and records never show them. Say so where the numbers are. */}
      {options.length > 1 && (
        <p className="pl-6 text-label text-muted">
          Sorts {choiceDirectionLabels(options)?.asc}. Drag to reorder. Records never see these numbers, only this editor does.
        </p>
      )}
    </div>
  );
}

function SortableOptionRow({
  position,
  option,
  onRecolor,
  onSetIcon,
  onRename,
  categoryMode,
  onSetCategory,
  onRemove,
}: {
  /** #1017 — how this field's options carry a state category: always (workflow), optionally (select), never. */
  categoryMode: 'required' | 'optional' | null;
  onSetCategory: (category: StateCategory | null) => void;
  /** #963 — 1-based place in the order; visible only in this editor. */
  position: number;
  option: { id: string; label: string; color: string; icon?: string | null; category?: StateCategory | null };
  onRecolor: (color: string) => void;
  /** #202 — set/clear this option's curated icon. */
  onSetIcon: (icon: string | null) => void;
  onRename: (label: string) => void;
  onRemove: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: option.id,
  });
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn('flex items-center gap-2', isDragging && 'z-10 opacity-70')}
    >
      <button
        type="button"
        className="cursor-grab touch-none p-0.5 text-faint hover:text-muted"
        aria-label={`Drag to reorder ${option.label}`}
        {...attributes}
        {...listeners}
      >
        <GripVertical className="h-3.5 w-3.5" />
      </button>
      <span className="w-4 shrink-0 text-right text-label tabular-nums text-muted" aria-label={`Position ${position}`}>
        {position}
      </span>
      <OptionAppearance
        icon={option.icon}
        color={option.color}
        onChange={(patch) => {
          if (patch.color !== undefined && patch.color !== null) onRecolor(patch.color);
          // #202: `null` clears the icon; the API treats undefined as "leave alone".
          if (patch.icon !== undefined) onSetIcon(patch.icon);
        }}
      />
      <Input
        className="h-8"
        defaultValue={option.label}
        onBlur={(e) => {
          const label = e.target.value.trim();
          if (label && label !== option.label) onRename(label);
        }}
        onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
      />
      {/* #1017 — what KIND of state this is. Finished (Done / Canceled) is what My Work, "Assigned to me" and overdue
          read, so it is a choice here, not a guess from the label. A workflow option always has one; a select's may be
          left unset. */}
      {categoryMode && (
        <Select
          size="sm"
          className="w-32 shrink-0"
          aria-label={`State category of ${option.label}`}
          value={option.category ?? ''}
          onChange={(e) => onSetCategory(e.target.value === '' ? null : (e.target.value as StateCategory))}
        >
          {categoryMode === 'optional' && <option value="">No category</option>}
          {STATE_CATEGORY_OPTIONS.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </Select>
      )}
      <button type="button" className="p-1 text-faint hover:text-error" onClick={onRemove}>
        <Trash2 className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
