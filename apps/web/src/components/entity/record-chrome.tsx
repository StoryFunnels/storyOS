'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Copy, CopyPlus, MoreHorizontal, SlidersHorizontal, Star, Trash2, Plus } from 'lucide-react';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { Dialog, DialogTrigger } from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { AddFieldDialog } from '@/components/table-view/add-field-dialog';
import type { Field } from '@/components/table-view/use-table-data';
import { useFavorites } from '@/components/sidebar';
import { AUDIT_TYPES } from './entity-field-utils';
import { useSetFieldConfig } from './field-controls';

export function HiddenFieldRow({ ws, db, field }: { ws: string; db: string; field: Field }) {
  const setConfig = useSetFieldConfig(ws, db);
  // Clear every reason it could be hidden: an explicit hide, hide-when-empty, or
  // the audit-field default (MN-126, which keys off entity_hidden !== false).
  const reveal = () =>
    setConfig.mutate({ fieldId: field.id, config: { entity_hidden: false, hide_when_empty: false } });
  const reason =
    field.config?.['entity_hidden'] === true || AUDIT_TYPES.has(field.type) ? '' : ' (empty)';
  return (
    <div className="flex min-h-7 items-center justify-between py-0.5">
      <span className="truncate text-[12px] text-faint">
        {field.displayName}
        {reason}
      </span>
      <button className="text-[12px] text-info underline-offset-2 hover:underline" onClick={reveal}>
        Show
      </button>
    </div>
  );
}

/** "+ Add a field" — schema growth from the record page (creates a NEW field). */
export function AddFieldRow({ ws, db }: { ws: string; db: string }) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button className="flex items-center gap-1.5 py-1 text-[12px] text-faint hover:text-ink">
          <Plus className="h-3.5 w-3.5" /> New field
        </button>
      </DialogTrigger>
      {open && <AddFieldDialog ws={ws} db={db} onDone={() => setOpen(false)} />}
    </Dialog>
  );
}

/** Star toggle in the header — adds/removes this record from the sidebar Favorites (MN-075). */
export function StarButton({ ws, rec }: { ws: string; rec: string }) {
  const qc = useQueryClient();
  const favorites = useFavorites(ws);
  const starred = (favorites.data ?? []).some((f) => f.target_type === 'record' && f.target_id === rec);
  const toggle = useMutation({
    mutationFn: async () => {
      if (starred) {
        const { error } = await api.DELETE('/api/v1/workspaces/{ws}/favorites/{type}/{id}', {
          params: { path: { ws, type: 'record', id: rec } },
        } as never);
        if (error) throw error;
      } else {
        const { error } = await api.POST('/api/v1/workspaces/{ws}/favorites', {
          params: { path: { ws } },
          body: { target_type: 'record', target_id: rec } as never,
        } as never);
        if (error) throw error;
      }
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['favorites', ws] }),
  });
  return (
    <button
      onClick={() => toggle.mutate()}
      title={starred ? 'Unstar' : 'Star'}
      className="rounded p-1 text-muted hover:bg-hover hover:text-ink"
    >
      <Star className={cn('h-4 w-4', starred && 'fill-[var(--accent)] text-[var(--accent)]')} />
    </button>
  );
}

/** Header Actions menu: duplicate, copy link, delete (MN-074). */
export function RecordActions({
  ws,
  db,
  rec,
  readOnly,
  canCreate,
}: {
  ws: string;
  db: string;
  rec: string;
  readOnly: boolean;
  canCreate: boolean;
}) {
  const router = useRouter();
  const qc = useQueryClient();

  const duplicate = useMutation({
    mutationFn: async () => {
      const { data, error } = await api.POST(
        '/api/v1/workspaces/{ws}/databases/{db}/records/{rec}/duplicate',
        { params: { path: { ws, db, rec } } } as never,
      );
      if (error) throw error;
      return data as unknown as { id: string };
    },
    onSuccess: (r) => {
      toast.success('Record duplicated');
      void qc.invalidateQueries({ queryKey: ['records', ws, db] });
      router.push(`/w/${ws}/d/${db}/r/${r.id}`);
    },
    onError: () => toast.error('Could not duplicate'),
  });

  const remove = useMutation({
    mutationFn: async () => {
      const { error } = await api.DELETE('/api/v1/workspaces/{ws}/databases/{db}/records/{rec}', {
        params: { path: { ws, db, rec } },
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success('Record moved to trash');
      router.push(`/w/${ws}/d/${db}`);
      // Drop the deleted record's queries (don't refetch a 404); refresh the list.
      qc.removeQueries({ predicate: (query) => Array.isArray(query.queryKey) && query.queryKey.includes(rec) });
      void qc.invalidateQueries({ queryKey: ['records', ws, db] });
    },
    onError: () => toast.error('Could not delete'),
  });

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      toast.success('Link copied');
    } catch {
      toast.error('Could not copy link');
    }
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button className="rounded p-1 text-muted hover:bg-hover hover:text-ink" title="Actions">
          <MoreHorizontal className="h-4 w-4" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {canCreate && (
          <DropdownMenuItem onSelect={() => duplicate.mutate()}>
            <CopyPlus className="mr-2 h-3.5 w-3.5" /> Duplicate
          </DropdownMenuItem>
        )}
        <DropdownMenuItem onSelect={copyLink}>
          <Copy className="mr-2 h-3.5 w-3.5" /> Copy link
        </DropdownMenuItem>
        {!readOnly && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem className="text-error" onSelect={() => remove.mutate()}>
              <Trash2 className="mr-2 h-3.5 w-3.5" /> Delete
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** "Fields" popover: one place to toggle which fields show on the record (MN-074). */
export function FieldsPopover({ ws, db, fields }: { ws: string; db: string; fields: Field[] }) {
  const setConfig = useSetFieldConfig(ws, db);
  const [q, setQ] = useState('');
  const list = fields.filter((f) => f.displayName.toLowerCase().includes(q.trim().toLowerCase()));
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button className="flex items-center gap-1.5 rounded px-2 py-1 text-[13px] text-muted hover:bg-hover hover:text-ink">
          <SlidersHorizontal className="h-3.5 w-3.5" /> Fields
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <input
          autoFocus
          placeholder="Filter fields…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.stopPropagation()}
          className="mb-1 w-full rounded border border-border-default bg-card px-2 py-1 text-[13px] text-ink outline-none placeholder:text-faint"
        />
        <div className="max-h-72 overflow-y-auto">
          {list.map((f) => {
            const shown = f.config?.['entity_hidden'] !== true;
            return (
              <DropdownMenuItem
                key={f.id}
                onSelect={(e) => {
                  e.preventDefault();
                  setConfig.mutate({ fieldId: f.id, config: { entity_hidden: shown } });
                }}
              >
                <span
                  className={cn(
                    'flex h-4 w-7 shrink-0 items-center rounded-full px-0.5 transition-colors',
                    shown ? 'justify-end bg-accent' : 'justify-start bg-border-default',
                  )}
                >
                  <span className="h-3 w-3 rounded-full bg-card" />
                </span>
                <span className="truncate">{f.displayName}</span>
              </DropdownMenuItem>
            );
          })}
          {list.length === 0 && <p className="px-2 py-1.5 text-[12px] text-faint">No fields.</p>}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
