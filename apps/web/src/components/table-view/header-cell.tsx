'use client';

import { useRef, useState } from 'react';
import { GripVertical, MoreHorizontal, Pin, PinOff } from 'lucide-react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Dialog } from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { ChangeTypeDialog } from './change-type-dialog';
import { EditFieldDialog } from './edit-field-dialog';
import { useDeleteField } from './field-dialog-shared';
import type { Field } from './use-table-data';

export function HeaderCell({
  ws,
  db,
  field,
  width,
  readOnly,
  onResize,
  stickyZ,
  reorderable = false,
  sticky = false,
  stickyLeft,
  isFirst = false,
  pinned = false,
  onTogglePin,
  onAddLookup,
}: {
  ws: string;
  db: string;
  field: Field;
  width: number;
  readOnly: boolean;
  onResize: (width: number) => void;
  onAddLookup?: (relationFieldId: string) => void;
  reorderable?: boolean;
  sticky?: boolean;
  stickyLeft?: number;
  stickyZ?: number;
  isFirst?: boolean;
  pinned?: boolean;
  onTogglePin?: () => void;
}) {
  const startRef = useRef<{ x: number; width: number } | null>(null);
  const [dialog, setDialog] = useState<'edit' | 'change-type' | null>(null);
  const deleteField = useDeleteField({ ws, db, field, onDone: () => setDialog(null) });
  const canManage = !readOnly && field.type !== 'title' && !field.isSystem;
  const sortable = useSortable({ id: field.id, disabled: !reorderable });

  const style: React.CSSProperties = {
    width,
    transform: reorderable ? CSS.Transform.toString(sortable.transform) : undefined,
    transition: reorderable ? sortable.transition : undefined,
    ...(sticky ? { position: 'sticky', left: stickyLeft, zIndex: stickyZ ?? 30 } : {}),
  };

  return (
    <div
      ref={reorderable ? sortable.setNodeRef : undefined}
      style={style}
      className={cn(
        'group/header relative flex h-8 shrink-0 items-center justify-between border-r border-border-default px-2 text-[12px] font-medium text-muted',
        sticky && 'bg-app shadow-[2px_0_4px_-2px_rgba(15,23,41,0.12)]',
        sortable.isDragging && 'z-40 opacity-70',
      )}
    >
      <span className="flex min-w-0 items-center gap-1">
        {reorderable && (
          <button
            className="-ml-1 cursor-grab touch-none text-faint opacity-0 hover:text-muted group-hover/header:opacity-100"
            {...sortable.attributes}
            {...sortable.listeners}
            title="Drag to reorder"
          >
            <GripVertical className="h-3 w-3" />
          </button>
        )}
        <span className="truncate">{field.displayName}</span>
      </span>
      {isFirst && onTogglePin && (
        <button
          className="rounded p-0.5 text-faint opacity-0 hover:bg-active hover:text-ink group-hover/header:opacity-100"
          title={pinned ? 'Unfreeze column' : 'Freeze column'}
          onClick={onTogglePin}
        >
          {pinned ? <PinOff className="h-3 w-3" /> : <Pin className="h-3 w-3" />}
        </button>
      )}
      {canManage && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button className="rounded p-0.5 opacity-0 hover:bg-active group-hover/header:opacity-100">
              <MoreHorizontal className="h-3.5 w-3.5" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuItem onSelect={() => setDialog('edit')}>Edit field</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setDialog('change-type')}>Change type</DropdownMenuItem>
            {field.type === 'relation' && onAddLookup && (
              <DropdownMenuItem onSelect={() => onAddLookup(field.id)}>Add field from linked records</DropdownMenuItem>
            )}
            <DropdownMenuItem className="text-error" onSelect={() => deleteField.mutate()}>
              Delete field
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      <Dialog open={dialog !== null} onOpenChange={(open) => !open && setDialog(null)}>
        {dialog === 'edit' && (
          <EditFieldDialog
            ws={ws}
            db={db}
            field={field}
            onDone={() => setDialog(null)}
            onChangeType={() => setDialog('change-type')}
          />
        )}
        {dialog === 'change-type' && (
          <ChangeTypeDialog ws={ws} db={db} field={field} onDone={() => setDialog(null)} />
        )}
      </Dialog>
      <div
        className="absolute -right-0.5 top-0 z-40 h-full w-1.5 cursor-col-resize hover:bg-accent"
        onPointerDown={(e) => {
          startRef.current = { x: e.clientX, width };
          (e.target as HTMLElement).setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          if (!startRef.current) return;
          onResize(Math.max(48, startRef.current.width + (e.clientX - startRef.current.x)));
        }}
        onPointerUp={() => {
          startRef.current = null;
        }}
      />
    </div>
  );
}
