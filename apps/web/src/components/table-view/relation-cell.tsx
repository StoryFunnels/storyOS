'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, X } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import type { Field } from './use-table-data';

export interface LinkChip {
  id: string;
  title: string;
}

export function RelationChips({ chips }: { chips: LinkChip[] }) {
  return (
    <span className="flex gap-1 overflow-hidden">
      {chips.map((chip) => (
        <span
          key={chip.id}
          className="inline-flex max-w-40 items-center truncate rounded border border-border-default bg-hover px-1.5 py-0.5 text-[12px] text-ink"
        >
          <span className="truncate">{chip.title || 'Untitled'}</span>
        </span>
      ))}
    </span>
  );
}

/**
 * The record picker (C8): searches the target database by title, links via
 * the links endpoints (PUT replace), supports inline target creation.
 * Single-pick for the many-side of one_to_many, multi otherwise.
 */
export function RelationEditor({
  ws,
  db,
  recordId,
  field,
  current,
  onDone,
}: {
  ws: string;
  db: string;
  recordId: string;
  field: Field;
  current: LinkChip[];
  onDone: () => void;
}) {
  const qc = useQueryClient();
  const relation = field.relation!;
  const single = relation.cardinality === 'one_to_many' && relation.side === 'a';
  const targetDb = relation.target_database_id;

  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<LinkChip[]>(current);
  const ref = useRef<HTMLDivElement>(null);

  const results = useQuery({
    queryKey: ['record-picker', ws, targetDb, search],
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/workspaces/{ws}/databases/{db}/records', {
        params: { path: { ws, db: targetDb }, query: { q: search || undefined, limit: 20 } },
      });
      if (error) throw error;
      return (data as unknown as { data: Array<{ id: string; title: string }> }).data;
    },
  });

  const save = useMutation({
    mutationFn: async (ids: string[]) => {
      const { error } = await api.PUT(
        '/api/v1/workspaces/{ws}/databases/{db}/records/{rec}/links/{field}',
        {
          params: { path: { ws, db, rec: recordId, field: field.id } },
          body: { record_ids: ids },
        },
      );
      if (error) throw error;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['records', ws, db] });
      void qc.invalidateQueries({ queryKey: ['records', ws, targetDb] });
      void qc.invalidateQueries({ queryKey: ['record', ws, db, recordId] });
      onDone();
    },
    onError: () => toast.error('Could not update links'),
  });

  const createTarget = useMutation({
    mutationFn: async (name: string) => {
      const { data, error } = await api.POST('/api/v1/workspaces/{ws}/databases/{db}/records', {
        params: { path: { ws, db: targetDb } },
        body: { values: { name } },
      });
      if (error) throw error;
      return data as unknown as { id: string; title: string };
    },
    onSuccess: (created) => {
      pick({ id: created.id, title: created.title });
      setSearch('');
      void qc.invalidateQueries({ queryKey: ['record-picker', ws, targetDb] });
    },
  });

  function pick(chip: LinkChip) {
    if (single) {
      save.mutate([chip.id]);
      return;
    }
    setSelected((prev) =>
      prev.some((c) => c.id === chip.id) ? prev.filter((c) => c.id !== chip.id) : [...prev, chip],
    );
  }

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        if (single) onDone();
        else save.mutate(selected.map((c) => c.id));
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [single, selected, onDone, save]);

  const selectedIds = useMemo(() => new Set(selected.map((c) => c.id)), [selected]);
  const exactMatch = results.data?.some((r) => r.title.toLowerCase() === search.trim().toLowerCase());

  return (
    <div
      ref={ref}
      className="absolute left-0 top-full z-30 mt-0.5 w-72 rounded-[var(--radius-card)] border border-border-default bg-card shadow-[0_4px_12px_rgba(15,23,41,0.08)]"
      onKeyDown={(e) => e.key === 'Escape' && onDone()}
    >
      {!single && selected.length > 0 && (
        <div className="flex flex-wrap gap-1 border-b border-border-default p-2">
          {selected.map((chip) => (
            <span
              key={chip.id}
              className="inline-flex items-center gap-1 rounded border border-border-default bg-hover px-1.5 py-0.5 text-[12px] text-ink"
            >
              {chip.title || 'Untitled'}
              <button onClick={() => pick(chip)} className="text-faint hover:text-error">
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
      )}
      <input
        autoFocus
        placeholder={`Search or create ${relation.target_database_name ?? 'records'}…`}
        className="w-full border-b border-border-default bg-card px-3 py-2 text-[13px] text-ink outline-none placeholder:text-faint"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />
      <div className="max-h-56 overflow-y-auto p-1">
        {(results.data ?? []).map((row) => (
          <button
            key={row.id}
            className={cn(
              'flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-[13px] text-ink hover:bg-hover',
              selectedIds.has(row.id) && 'bg-hover',
            )}
            onClick={() => pick(row)}
          >
            <span className="truncate">{row.title || 'Untitled'}</span>
            {!single && selectedIds.has(row.id) && <span className="text-[11px] text-muted">linked</span>}
          </button>
        ))}
        {search.trim() && !exactMatch ? (
          <button
            className="flex w-full items-center gap-1.5 rounded px-2 py-1.5 text-left text-[13px] text-info hover:bg-hover"
            onClick={() => createTarget.mutate(search.trim())}
          >
            <Plus className="h-3.5 w-3.5" /> Create “{search.trim()}”
          </button>
        ) : (
          !search.trim() && (
            <p className="flex items-center gap-1.5 px-2 py-1.5 text-[12px] text-faint">
              <Plus className="h-3.5 w-3.5" /> Type a name to create a new one
            </p>
          )
        )}
      </div>
      <div className="flex justify-between border-t border-border-default px-2 py-1.5">
        <button className="text-[12px] text-muted hover:text-ink" onClick={() => save.mutate([])}>
          Clear
        </button>
        {!single && (
          <button
            className="text-[12px] text-ink underline"
            onClick={() => save.mutate(selected.map((c) => c.id))}
          >
            Done
          </button>
        )}
      </div>
    </div>
  );
}
