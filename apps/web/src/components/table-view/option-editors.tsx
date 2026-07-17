'use client';

import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import type { DragEndEvent } from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
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
import type { Field } from './use-table-data';
import { ColorDot, nextColor, useFieldMutations } from './field-dialog-shared';
import type { OptionDraft } from './field-dialog-shared';

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
          <ColorDot
            color={option.color}
            onPick={(color) => onChange(options.map((o) => (o.key === option.key ? { ...o, color } : o)))}
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
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

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
    mutationFn: async ({ id, ...body }: { id: string; label?: string; color?: string; position?: number }) => {
      const { error } = await api.PATCH(
        '/api/v1/workspaces/{ws}/databases/{db}/fields/{field}/options/{option}',
        { params: { path: { ws, db, field: field.id, option: id } }, body: body as never },
      );
      if (error) throw error;
    },
    onSuccess: invalidate,
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

  async function onDragEnd(event: DragEndEvent) {
    const from = options.findIndex((o) => o.id === event.active.id);
    const to = options.findIndex((o) => o.id === event.over?.id);
    if (from < 0 || to < 0 || from === to) return;
    const next = arrayMove(options, from, to);
    // Persist a clean 0..n sequence; lists are small.
    for (let i = 0; i < next.length; i++) {
      if (next[i]!.id !== options[i]?.id) {
        await patchOption.mutateAsync({ id: next[i]!.id, position: i });
      }
    }
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

  return (
    <div className="flex flex-col gap-1.5">
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={options.map((o) => o.id)} strategy={verticalListSortingStrategy}>
          {options.map((option) => (
            <SortableOptionRow
              key={option.id}
              option={option}
              onRecolor={(color) => patchOption.mutate({ id: option.id, color })}
              onRename={(label) => patchOption.mutate({ id: option.id, label })}
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
    </div>
  );
}

function SortableOptionRow({
  option,
  onRecolor,
  onRename,
  onRemove,
}: {
  option: { id: string; label: string; color: string };
  onRecolor: (color: string) => void;
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
        {...attributes}
        {...listeners}
      >
        <GripVertical className="h-3.5 w-3.5" />
      </button>
      <ColorDot color={option.color} onPick={onRecolor} />
      <Input
        className="h-8"
        defaultValue={option.label}
        onBlur={(e) => {
          const label = e.target.value.trim();
          if (label && label !== option.label) onRename(label);
        }}
        onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
      />
      <button type="button" className="p-1 text-faint hover:text-error" onClick={onRemove}>
        <Trash2 className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
