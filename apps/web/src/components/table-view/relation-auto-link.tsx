'use client';

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link2, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';

interface ComparableField {
  id: string;
  api_name: string;
  display_name: string;
  type: string;
}
interface RelationDetail {
  cardinality: 'one_to_many' | 'many_to_many';
  database_a_id: string;
  database_b_id: string;
  auto_link: { conditions: Array<{ field_a_id: string; field_b_id: string }>; case_sensitive?: boolean } | null;
  comparable_fields_a: ComparableField[];
  comparable_fields_b: ComparableField[];
}

/** A single field-to-field match condition, oriented to the field you opened. */
interface RuleRow {
  thisId: string;
  otherId: string;
}

/**
 * Auto-link rule editor (MN-085): match a field on this database to a field on the
 * linked one; records whose values match get linked automatically. Rules are stored
 * on the relation as A/B pairs — we orient them to "this side" vs "linked side" so
 * the editor reads naturally whichever end you opened.
 */
export function RelationAutoLink({ ws, relationId, side }: { ws: string; relationId: string; side: 'a' | 'b' }) {
  const qc = useQueryClient();
  const detailQuery = useQuery({
    queryKey: ['relation-detail', ws, relationId],
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/workspaces/{ws}/relations/{rel}', {
        params: { path: { ws, rel: relationId } },
      });
      if (error) throw error;
      return data as unknown as RelationDetail;
    },
  });

  const [rows, setRows] = useState<RuleRow[]>([]);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const [summary, setSummary] = useState<string | null>(null);

  const detail = detailQuery.data;
  const thisFields = (side === 'a' ? detail?.comparable_fields_a : detail?.comparable_fields_b) ?? [];
  const otherFields = (side === 'a' ? detail?.comparable_fields_b : detail?.comparable_fields_a) ?? [];

  useEffect(() => {
    if (!detail || hydrated) return;
    const initial = (detail.auto_link?.conditions ?? []).map((c) => ({
      thisId: side === 'a' ? c.field_a_id : c.field_b_id,
      otherId: side === 'a' ? c.field_b_id : c.field_a_id,
    }));
    setRows(initial);
    setCaseSensitive(detail.auto_link?.case_sensitive ?? false);
    setHydrated(true);
  }, [detail, hydrated, side]);

  const toBody = () => {
    const complete = rows.filter((r) => r.thisId && r.otherId);
    if (complete.length === 0) return { auto_link: null };
    return {
      auto_link: {
        conditions: complete.map((r) => ({
          field_a: side === 'a' ? r.thisId : r.otherId,
          field_b: side === 'a' ? r.otherId : r.thisId,
        })),
        case_sensitive: caseSensitive,
      },
    };
  };

  const saveRules = async () => {
    const { error } = await api.PATCH('/api/v1/workspaces/{ws}/relations/{rel}', {
      params: { path: { ws, rel: relationId } },
      body: toBody() as never,
    });
    if (error) throw error;
    await qc.invalidateQueries({ queryKey: ['relation-detail', ws, relationId] });
  };

  const save = useMutation({
    mutationFn: saveRules,
    onSuccess: () => toast.success('Auto-link rules saved'),
    onError: () => toast.error('Could not save the rules'),
  });

  const run = useMutation({
    mutationFn: async () => {
      await saveRules(); // run what's on screen
      const { data, error } = await api.POST('/api/v1/workspaces/{ws}/relations/{rel}/auto-link', {
        params: { path: { ws, rel: relationId } },
      });
      if (error) throw error;
      return data as unknown as { created: number; ambiguous: number; unmatched: number; matched: number };
    },
    onSuccess: (r) => {
      setSummary(`Linked ${r.created} record${r.created === 1 ? '' : 's'} · ${r.ambiguous} ambiguous · ${r.unmatched} unmatched`);
      if (detail) {
        void qc.invalidateQueries({ queryKey: ['records', ws, detail.database_a_id] });
        void qc.invalidateQueries({ queryKey: ['records', ws, detail.database_b_id] });
        void qc.invalidateQueries({ queryKey: ['record', ws, detail.database_a_id] });
        void qc.invalidateQueries({ queryKey: ['record', ws, detail.database_b_id] });
        void qc.invalidateQueries({ queryKey: ['collection', ws] });
      }
    },
    onError: (e: unknown) => {
      const msg = e && typeof e === 'object' && 'message' in e ? String((e as { message: unknown }).message) : 'Run failed';
      toast.error(msg);
    },
  });

  if (detailQuery.isLoading) return <p className="text-[12px] text-faint">Loading auto-link…</p>;
  if (!detail) return null;

  const selectCls =
    'h-8 min-w-0 flex-1 rounded-md border border-border-default bg-surface px-2 text-[13px] text-ink';

  return (
    <div className="flex flex-col gap-2 rounded-md border border-border-default bg-surface-subtle/40 p-3">
      <div className="flex items-center gap-2">
        <Link2 className="h-3.5 w-3.5 text-faint" />
        <span className="text-[13px] font-medium text-ink">Auto-link by matching fields</span>
      </div>
      <p className="text-[12px] text-faint">
        Link records automatically when every condition matches. Only text, email, url, number and date
        fields can be matched. {detail.cardinality === 'one_to_many' && 'Ambiguous matches (several targets) are skipped, never guessed.'}
      </p>

      {rows.map((row, i) => (
        <div key={i} className="flex items-center gap-1.5">
          <select
            className={selectCls}
            value={row.thisId}
            onChange={(e) => setRows(rows.map((r, j) => (j === i ? { ...r, thisId: e.target.value } : r)))}
          >
            <option value="">This field…</option>
            {thisFields.map((f) => (
              <option key={f.id} value={f.id}>{f.display_name}</option>
            ))}
          </select>
          <span className="text-[12px] text-faint">=</span>
          <select
            className={selectCls}
            value={row.otherId}
            onChange={(e) => setRows(rows.map((r, j) => (j === i ? { ...r, otherId: e.target.value } : r)))}
          >
            <option value="">Linked field…</option>
            {otherFields.map((f) => (
              <option key={f.id} value={f.id}>{f.display_name}</option>
            ))}
          </select>
          <button
            type="button"
            className="p-1 text-faint hover:text-error"
            onClick={() => setRows(rows.filter((_, j) => j !== i))}
            aria-label="Remove condition"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}

      <div className="flex items-center justify-between">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => setRows([...rows, { thisId: '', otherId: '' }])}
          disabled={rows.length >= 5}
        >
          <Plus className="mr-1 h-3.5 w-3.5" /> Add condition
        </Button>
        <label className="flex items-center gap-1.5 text-[12px] text-muted">
          <input type="checkbox" checked={caseSensitive} onChange={(e) => setCaseSensitive(e.target.checked)} />
          Case-sensitive
        </label>
      </div>

      <div className="flex items-center gap-2 border-t border-border-default pt-2">
        <Button type="button" variant="secondary" size="sm" onClick={() => save.mutate()} disabled={save.isPending}>
          Save rules
        </Button>
        <Button
          type="button"
          size="sm"
          onClick={() => run.mutate()}
          disabled={run.isPending || rows.every((r) => !r.thisId || !r.otherId)}
        >
          {run.isPending ? 'Running…' : 'Run now'}
        </Button>
        {summary && <span className="text-[12px] text-muted">{summary}</span>}
      </div>
    </div>
  );
}
