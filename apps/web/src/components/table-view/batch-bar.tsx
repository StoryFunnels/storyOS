'use client';

import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { CellEditor, cellToText } from './cells';
import { useFieldMutations } from './field-dialog-shared';
import type { Field, RecordRow } from './use-table-data';

/** Escape one CSV cell (quotes, commas, newlines). */
function csvCell(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/**
 * MN-050 → MN-197: floating selection bar. FIXED to the viewport (the old
 * `absolute bottom-4` anchored to the grid container, which on a long table is
 * thousands of pixels tall — the bar rendered below the fold and looked missing).
 * Now a real bulk surface: set field (with an overwrite warning), link to a
 * record, duplicate, copy TSV, export CSV, run a button, trash with Undo.
 */
export function BatchBar({
  ws,
  db,
  fields,
  relationFields,
  buttonFields,
  exportFields,
  members,
  selected,
  selectedRows,
  moreUnloaded,
  canDelete,
  onClear,
}: {
  ws: string;
  db: string;
  fields: Field[];
  relationFields: Field[];
  buttonFields: Field[];
  exportFields: Field[];
  members: Array<{ id: string; name: string; image?: string | null }>;
  selected: string[];
  selectedRows: RecordRow[];
  moreUnloaded: boolean;
  canDelete: boolean;
  onClear: () => void;
}) {
  const { invalidate } = useFieldMutations(ws, db);
  const confirm = useConfirm();
  const [settingField, setSettingField] = useState<Field | null>(null);
  const [linkingField, setLinkingField] = useState<Field | null>(null);
  const [busy, setBusy] = useState(false);

  /** MN-197: how many of the selection already carry a value — the overwrite blast radius. */
  const overwriteCount = useMemo(() => {
    if (!settingField) return 0;
    return selectedRows.filter((r) => {
      const v = r.values[settingField.apiName];
      return v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && v.length === 0);
    }).length;
  }, [settingField, selectedRows]);

  function reportBatch(result: { updated: number; failed: Array<{ message: string }> }) {
    invalidate();
    if (result.failed.length > 0) {
      const reasons = [...new Set(result.failed.map((f) => f.message))].slice(0, 3).join(' · ');
      toast.warning(`Updated ${result.updated}, ${result.failed.length} failed — ${reasons}`);
    } else {
      toast.success(`Updated ${result.updated} record${result.updated === 1 ? '' : 's'}`);
    }
  }

  async function applyValues(values: Record<string, unknown>) {
    setBusy(true);
    const { data, error } = await api.PATCH('/api/v1/workspaces/{ws}/databases/{db}/records/batch', {
      params: { path: { ws, db } },
      body: { record_ids: selected, values } as never,
    });
    setBusy(false);
    setSettingField(null);
    setLinkingField(null);
    if (error) {
      toast.error('Batch update failed');
      return;
    }
    reportBatch(data as unknown as { updated: number; failed: Array<{ message: string }> });
  }

  async function trashAll() {
    // Undo covers a small mistake; above 25 a misclick is a catastrophe — confirm.
    if (
      selected.length > 25 &&
      !(await confirm({
        title: `Move ${selected.length} records to trash?`,
        message: 'They can be restored from the trash for 30 days.',
        confirmLabel: 'Move to trash',
        danger: true,
      }))
    ) {
      return;
    }
    setBusy(true);
    const { data, error } = await api.POST('/api/v1/workspaces/{ws}/databases/{db}/records/batch-delete', {
      params: { path: { ws, db } },
      body: { record_ids: selected } as never,
    });
    setBusy(false);
    if (error) {
      toast.error('Could not move to trash');
      return;
    }
    const result = data as unknown as { deleted: number; record_ids: string[] };
    invalidate();
    onClear();
    toast.success(`${result.deleted} moved to trash`, {
      action: {
        label: 'Undo',
        onClick: async () => {
          await api.POST('/api/v1/workspaces/{ws}/databases/{db}/records/batch-restore', {
            params: { path: { ws, db } },
            body: { record_ids: result.record_ids } as never,
          });
          invalidate();
        },
      },
    });
  }

  async function duplicateAll() {
    setBusy(true);
    const results = await Promise.allSettled(
      selected.map((rec) =>
        api.POST('/api/v1/workspaces/{ws}/databases/{db}/records/{rec}/duplicate' as never, {
          params: { path: { ws, db, rec } },
        } as never),
      ),
    );
    setBusy(false);
    invalidate();
    const ok = results.filter((r) => r.status === 'fulfilled' && !(r.value as { error?: unknown }).error).length;
    toast[ok === selected.length ? 'success' : 'warning'](
      `Duplicated ${ok} of ${selected.length} record${selected.length === 1 ? '' : 's'}`,
    );
  }

  async function runButton(field: Field) {
    setBusy(true);
    const results = await Promise.allSettled(
      selected.map((rec) =>
        api.POST('/api/v1/workspaces/{ws}/databases/{db}/records/{rec}/buttons/{field}/press' as never, {
          params: { path: { ws, db, rec, field: field.id } },
        } as never),
      ),
    );
    setBusy(false);
    invalidate();
    const ok = results.filter((r) => r.status === 'fulfilled' && !(r.value as { error?: unknown }).error).length;
    toast[ok === selected.length ? 'success' : 'warning'](
      `${field.displayName}: ran on ${ok} of ${selected.length} record${selected.length === 1 ? '' : 's'}`,
    );
  }

  /** Rows × fields as text — title first, buttons excluded. */
  function tabularData(): { header: string[]; body: string[][] } {
    return {
      header: ['Title', ...exportFields.map((f) => f.displayName)],
      body: selectedRows.map((r) => [
        r.title,
        ...exportFields.map((f) => cellToText(f, r.values[f.apiName])),
      ]),
    };
  }

  async function copyTsv() {
    const { header, body } = tabularData();
    const tsv = [header, ...body].map((cols) => cols.map((c) => c.replace(/\t/g, ' ')).join('\t')).join('\n');
    await navigator.clipboard.writeText(tsv);
    toast.success(`Copied ${body.length} row${body.length === 1 ? '' : 's'} — paste into Sheets or Slack`);
  }

  function exportCsv() {
    const { header, body } = tabularData();
    const csv = [header, ...body].map((cols) => cols.map(csvCell).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `selection-${selectedRows.length}-records.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="pointer-events-none fixed bottom-4 left-1/2 z-40 -translate-x-1/2">
      <div className="pointer-events-auto relative flex items-center gap-2 rounded-full border border-border-default bg-card px-4 py-2 shadow-[0_8px_24px_rgba(15,23,41,0.18)]">
        <span className="text-[13px] font-medium text-ink">
          {selected.length} selected
          {moreUnloaded && (
            <span className="ml-1 font-normal text-faint" title="Scroll to load more rows, then select again to include them.">
              · of loaded rows
            </span>
          )}
        </span>
        <span className="h-4 w-px bg-border-default" />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button className="rounded px-1.5 py-0.5 text-[13px] text-ink-secondary hover:bg-hover" disabled={busy}>
              Set field ▾
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent className="max-h-64 overflow-y-auto">
            {fields.map((field) => (
              <DropdownMenuItem key={field.id} onSelect={() => setSettingField(field)}>
                {field.displayName}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        {relationFields.length > 0 && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button className="rounded px-1.5 py-0.5 text-[13px] text-ink-secondary hover:bg-hover" disabled={busy}>
                Link to ▾
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent className="max-h-64 overflow-y-auto">
              {relationFields.map((field) => (
                <DropdownMenuItem key={field.id} onSelect={() => setLinkingField(field)}>
                  {field.displayName}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button className="rounded px-1.5 py-0.5 text-[13px] text-ink-secondary hover:bg-hover" disabled={busy}>
              More ▾
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            {canDelete && <DropdownMenuItem onSelect={() => void duplicateAll()}>Duplicate</DropdownMenuItem>}
            <DropdownMenuItem onSelect={() => void copyTsv()}>Copy as TSV</DropdownMenuItem>
            <DropdownMenuItem onSelect={exportCsv}>Export CSV</DropdownMenuItem>
            {buttonFields.map((field) => (
              <DropdownMenuItem key={field.id} onSelect={() => void runButton(field)}>
                Run “{field.displayName}”
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        {canDelete && (
          <button className="rounded px-1.5 py-0.5 text-[13px] text-error hover:bg-hover" onClick={() => void trashAll()} disabled={busy}>
            Move to trash
          </button>
        )}
        <button className="rounded px-1.5 py-0.5 text-[13px] text-muted hover:bg-hover" onClick={onClear}>
          Clear
        </button>

        {settingField && (
          <div className="absolute bottom-full left-1/2 mb-2 w-64 -translate-x-1/2 rounded-[var(--radius-card)] border border-border-default bg-card p-2 shadow-[0_8px_24px_rgba(15,23,41,0.15)]">
            <p className="mb-1.5 text-[12px] font-medium text-muted">
              Set “{settingField.displayName}” on {selected.length} records
            </p>
            {overwriteCount > 0 && (
              <p className="mb-1.5 text-[12px] text-warning">
                {overwriteCount} of {selected.length} already have a value — applying overwrites them.
              </p>
            )}
            <div className="relative min-h-8">
              <CellEditor
                field={settingField}
                value={null}
                members={members}
                onCommit={(value) => void applyValues({ [settingField.apiName]: value })}
                onCancel={() => setSettingField(null)}
              />
            </div>
          </div>
        )}

        {linkingField && (
          <BulkLinkPicker
            ws={ws}
            field={linkingField}
            count={selected.length}
            onPick={(targetId) => void applyValues({ [linkingField.apiName]: [targetId] })}
            onCancel={() => setLinkingField(null)}
          />
        )}
      </div>
    </div>
  );
}

/**
 * MN-197: bulk "link to" — pick ONE target record in the relation's target
 * database and set it on every selected record (assign 17 issues to an epic in
 * one action). Replace semantics, same as naming a relation in an update.
 */
function BulkLinkPicker({
  ws,
  field,
  count,
  onPick,
  onCancel,
}: {
  ws: string;
  field: Field;
  count: number;
  onPick: (targetId: string) => void;
  onCancel: () => void;
}) {
  const [search, setSearch] = useState('');
  const targetDb = field.relation?.target_database_id ?? '';
  const results = useQuery({
    queryKey: ['bulk-link-picker', ws, targetDb, search],
    enabled: Boolean(targetDb),
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/workspaces/{ws}/databases/{db}/records', {
        params: { path: { ws, db: targetDb }, query: { q: search || undefined, limit: 20 } },
      });
      if (error) throw error;
      return (data as unknown as { data: Array<{ id: string; title: string }> }).data;
    },
  });

  return (
    <div className="absolute bottom-full left-1/2 mb-2 w-72 -translate-x-1/2 rounded-[var(--radius-card)] border border-border-default bg-card p-2 shadow-[0_8px_24px_rgba(15,23,41,0.15)]">
      <p className="mb-1.5 text-[12px] font-medium text-muted">
        Link {count} record{count === 1 ? '' : 's'} via “{field.displayName}” — replaces existing links
      </p>
      <input
        autoFocus
        className="mb-1 h-8 w-full rounded-md border border-border-default bg-card px-2 text-[13px] text-ink"
        placeholder={`Search ${field.relation?.target_database_name ?? 'records'}…`}
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onCancel();
        }}
      />
      <div className="max-h-48 overflow-y-auto">
        {(results.data ?? []).map((r) => (
          <button
            key={r.id}
            className="block w-full truncate rounded px-2 py-1 text-left text-[13px] text-ink hover:bg-hover"
            onClick={() => onPick(r.id)}
          >
            {r.title || 'Untitled'}
          </button>
        ))}
        {results.data?.length === 0 && <p className="px-2 py-1 text-[12px] text-faint">No matches.</p>}
      </div>
    </div>
  );
}
