'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { AlertTriangle } from 'lucide-react';
import { api } from '@/lib/api';
import type { Field, RecordRow } from '@/components/table-view/use-table-data';

interface SelectDrift {
  select_field: { id: string; api_name: string; display_name: string };
  matched_option: { id: string; label: string };
  missing_count: number;
  missing_records: Array<{ id: string; title: string; number: number | null }>;
}

/**
 * MN-286: a database can carry both a select field ("Project") and a relation
 * field ("Epic") that mean the same grouping, with nothing keeping them in
 * sync — a record can carry the select label without the relation link,
 * invisible in this exact collection view. Surfaces that gap on the PARENT
 * record's own linked-collection section (e.g. a Project's "Issues" list)
 * and offers a one-click bulk-link fix. Renders nothing when there's no
 * plausible select↔relation pairing or no drift — the common case.
 */
export function SelectDriftBanner({
  ws,
  field,
  record,
  readOnly,
}: {
  ws: string;
  field: Field;
  record: RecordRow;
  readOnly: boolean;
}) {
  const relationId = field.relation?.id;
  const qc = useQueryClient();

  const drift = useQuery({
    queryKey: ['select-drift', ws, relationId, record.id],
    enabled: Boolean(relationId),
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/workspaces/{ws}/relations/{rel}/select-drift', {
        params: { path: { ws, rel: relationId! }, query: { record_id: record.id } },
      });
      if (error) throw error;
      return (data as unknown as { drift: SelectDrift | null }).drift;
    },
  });

  const reconcile = useMutation({
    mutationFn: async () => {
      const { data, error } = await api.POST('/api/v1/workspaces/{ws}/relations/{rel}/select-drift/reconcile', {
        params: { path: { ws, rel: relationId! } },
        body: { record_id: record.id },
      });
      if (error) throw error;
      return data as unknown as { linked: number; failed: Array<{ record_id: string; message: string }> };
    },
    onSuccess: (result) => {
      toast.success(`Linked ${result.linked} matching record${result.linked === 1 ? '' : 's'}`);
      if (result.failed.length) {
        toast.error(`Couldn't link ${result.failed.length} of them — they may already be linked elsewhere`);
      }
      void qc.invalidateQueries({ queryKey: ['select-drift', ws, relationId, record.id] });
      void qc.invalidateQueries({ queryKey: ['collection', ws, field.relation?.target_database_id, record.id, field.id] });
      void qc.invalidateQueries({ queryKey: ['records', ws] });
      void qc.invalidateQueries({ queryKey: ['record', ws] });
    },
    onError: () => toast.error('Could not link the matching records'),
  });

  const d = drift.data;
  if (!d) return null;

  const plural = d.missing_count === 1 ? '' : 's';
  return (
    <div className="mb-1.5 flex flex-wrap items-center gap-2 rounded-[var(--radius-card)] border border-border-default bg-card px-3 py-2 text-[12px]">
      <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-warning" />
      <span className="text-warning">
        {d.missing_count} record{plural} {d.missing_count === 1 ? 'has' : 'have'}{' '}
        <strong>{d.select_field.display_name}</strong> = &ldquo;{d.matched_option.label}&rdquo; but{' '}
        {d.missing_count === 1 ? "isn't" : "aren't"} linked here.
      </span>
      {!readOnly && (
        <button
          className="ml-auto shrink-0 rounded px-1.5 py-0.5 font-medium text-info hover:bg-hover disabled:opacity-50"
          onClick={() => reconcile.mutate()}
          disabled={reconcile.isPending}
        >
          {reconcile.isPending ? 'Linking…' : `Link ${d.missing_count} matching record${plural}`}
        </button>
      )}
    </div>
  );
}
