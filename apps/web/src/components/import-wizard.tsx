'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { API_URL } from '@/lib/api';
import { useDatabase } from '@/components/table-view/use-table-data';
import { Button } from '@/components/ui/button';
import { DialogContent } from '@/components/ui/dialog';

interface Inferred {
  column: string;
  type: string;
}
type Destination =
  | { kind: 'title' }
  | { kind: 'existing'; field_id: string }
  | { kind: 'new'; display_name: string; type: string }
  | { kind: 'relation'; field_id: string }
  | { kind: 'skip' };

interface DryRun {
  rows: number;
  will_create: number;
  new_fields: Array<{ display_name: string; type: string }>;
  warnings: Array<{ row: number; column: string; message: string }>;
  warnings_total: number;
}

const NEW_TYPES = ['text', 'number', 'date', 'checkbox', 'select', 'email', 'url'];

async function post(ws: string, db: string, file: File, mapping: unknown, dryRun: boolean) {
  const form = new FormData();
  form.append('mapping', JSON.stringify(mapping));
  form.append('dry_run', String(dryRun));
  form.append('file', file);
  const res = await fetch(`${API_URL}/api/v1/workspaces/${ws}/databases/${db}/import`, {
    method: 'POST',
    credentials: 'include',
    body: form,
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body?.error?.message ?? 'Import failed');
  return body;
}

/** CSV import wizard (MN-052): upload → map → dry-run → import → summary. */
export function ImportWizard({ ws, db, onDone }: { ws: string; db: string; onDone: () => void }) {
  const router = useRouter();
  const qc = useQueryClient();
  const database = useDatabase(ws, db);
  const [file, setFile] = useState<File | null>(null);
  const [inferred, setInferred] = useState<Inferred[]>([]);
  const [sampleRows, setSampleRows] = useState<string[][]>([]);
  const [mapping, setMapping] = useState<Map<string, Destination>>(new Map());
  const [dryRun, setDryRun] = useState<DryRun | null>(null);
  const [result, setResult] = useState<{ created: number; warnings_total: number } | null>(null);
  const [busy, setBusy] = useState(false);

  const existingFields = (database.data?.fields ?? []).filter(
    (f) => !f.isSystem && !['title', 'lookup', 'button', 'created_at', 'updated_at', 'created_by'].includes(f.type),
  );
  const relationFields = (database.data?.fields ?? []).filter((f) => f.type === 'relation');

  async function onUpload(f: File) {
    setBusy(true);
    try {
      const boot = await post(ws, db, f, [], true);
      setFile(f);
      setInferred(boot.inferred);
      setSampleRows(boot.sample_rows ?? []);
      const initial = new Map<string, Destination>();
      boot.inferred.forEach((c: Inferred, i: number) => {
        initial.set(c.column, i === 0 ? { kind: 'title' } : { kind: 'new', display_name: c.column, type: c.type });
      });
      setMapping(initial);
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function mappingArray() {
    return [...mapping.entries()].map(([column, to]) => ({ column, to }));
  }

  async function runDry() {
    setBusy(true);
    try {
      setDryRun(await post(ws, db, file!, mappingArray(), true));
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function commit() {
    setBusy(true);
    try {
      const res = await post(ws, db, file!, mappingArray(), false);
      setResult(res);
      void qc.invalidateQueries();
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const step = result ? 4 : dryRun ? 3 : file ? 2 : 1;

  return (
    <DialogContent title={`Import CSV into "${database.data?.name ?? '…'}"`} className="max-w-2xl">
      <div className="flex max-h-[75vh] flex-col gap-4 overflow-y-auto pr-1">
        {step === 1 && (
          <label className="flex h-36 cursor-pointer flex-col items-center justify-center gap-2 rounded-[var(--radius-card)] border border-dashed border-border-strong text-[13px] text-muted hover:bg-hover">
            {busy ? 'Parsing…' : 'Click to choose a .csv file (≤10MB)'}
            <input
              type="file"
              accept=".csv,text/csv"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void onUpload(f);
              }}
            />
          </label>
        )}

        {step === 2 && (
          <>
            <p className="text-[13px] text-muted">
              Map each column. Exactly one column must be the record title.
            </p>
            <div className="overflow-hidden rounded-[var(--radius-card)] border border-border-default">
              {inferred.map((c) => {
                const to = mapping.get(c.column) ?? { kind: 'skip' as const };
                const sample = sampleRows.map((r) => r[inferred.indexOf(c)]).filter(Boolean).slice(0, 2).join(', ');
                const encoded =
                  to.kind === 'title' ? 'title'
                  : to.kind === 'skip' ? 'skip'
                  : to.kind === 'existing' ? `existing:${to.field_id}`
                  : to.kind === 'relation' ? `relation:${to.field_id}`
                  : `new:${to.type}`;
                return (
                  <div key={c.column} className="flex items-center gap-3 border-b border-border-default px-3 py-2 last:border-b-0">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[13px] font-medium text-ink">{c.column}</p>
                      <p className="truncate text-[11px] text-faint">{sample}</p>
                    </div>
                    <select
                      className="h-8 w-56 rounded-[var(--radius-control)] border border-border-default bg-card px-2 text-[13px] text-ink"
                      value={encoded}
                      onChange={(e) => {
                        const v = e.target.value;
                        const next = new Map(mapping);
                        if (v === 'title') next.set(c.column, { kind: 'title' });
                        else if (v === 'skip') next.set(c.column, { kind: 'skip' });
                        else if (v.startsWith('existing:')) next.set(c.column, { kind: 'existing', field_id: v.slice(9) });
                        else if (v.startsWith('relation:')) next.set(c.column, { kind: 'relation', field_id: v.slice(9) });
                        else if (v.startsWith('new:')) next.set(c.column, { kind: 'new', display_name: c.column, type: v.slice(4) });
                        setMapping(next);
                      }}
                    >
                      <option value="title">→ Record title</option>
                      <optgroup label="New field">
                        {NEW_TYPES.map((t) => (
                          <option key={t} value={`new:${t}`}>
                            ＋ New {t} field
                          </option>
                        ))}
                      </optgroup>
                      {existingFields.length > 0 && (
                        <optgroup label="Existing field">
                          {existingFields.map((f) => (
                            <option key={f.id} value={`existing:${f.id}`}>
                              {f.displayName}
                            </option>
                          ))}
                        </optgroup>
                      )}
                      {relationFields.length > 0 && (
                        <optgroup label="Link by title via relation">
                          {relationFields.map((f) => (
                            <option key={f.id} value={`relation:${f.id}`}>
                              🔗 {f.displayName}
                            </option>
                          ))}
                        </optgroup>
                      )}
                      <option value="skip">Don't import</option>
                    </select>
                  </div>
                );
              })}
            </div>
          </>
        )}

        {step === 3 && dryRun && (
          <>
            <div className="rounded-[var(--radius-card)] border border-border-default bg-canvas p-4">
              <p className="text-[14px] font-medium text-ink">
                {dryRun.will_create} of {dryRun.rows} rows will import
                {dryRun.new_fields.length > 0 && ` · ${dryRun.new_fields.length} new fields`}
                {dryRun.warnings_total > 0 && ` · ${dryRun.warnings_total} warnings`}
              </p>
              {dryRun.warnings.length > 0 && (
                <div className="mt-2 max-h-40 overflow-y-auto">
                  {dryRun.warnings.map((w, i) => (
                    <p key={i} className="text-[12px] text-muted">
                      Row {w.row} · {w.column}: {w.message}
                    </p>
                  ))}
                </div>
              )}
            </div>
          </>
        )}

        {step === 4 && result && (
          <div className="rounded-[var(--radius-card)] border border-border-default bg-canvas p-4 text-center">
            <p className="text-[15px] font-semibold text-ink">Imported {result.created} records 🎉</p>
            {result.warnings_total > 0 && (
              <p className="mt-1 text-[12px] text-muted">{result.warnings_total} cells were dropped with warnings.</p>
            )}
          </div>
        )}

        <div className="flex justify-between gap-2">
          <span>
            {step === 2 && (
              <Button type="button" variant="ghost" size="sm" onClick={() => { setFile(null); setDryRun(null); }}>
                ← Different file
              </Button>
            )}
            {step === 3 && (
              <Button type="button" variant="ghost" size="sm" onClick={() => setDryRun(null)}>
                ← Fix mapping
              </Button>
            )}
          </span>
          <span className="flex gap-2">
            <Button type="button" variant="secondary" onClick={onDone}>
              {step === 4 ? 'Close' : 'Cancel'}
            </Button>
            {step === 2 && (
              <Button type="button" disabled={busy} onClick={runDry}>
                {busy ? 'Checking…' : 'Check import'}
              </Button>
            )}
            {step === 3 && (
              <Button type="button" disabled={busy} onClick={commit}>
                {busy ? 'Importing…' : `Import ${dryRun?.will_create} records`}
              </Button>
            )}
            {step === 4 && (
              <Button type="button" onClick={() => { onDone(); router.push(`/w/${ws}/d/${db}`); }}>
                Open database
              </Button>
            )}
          </span>
        </div>
      </div>
    </DialogContent>
  );
}
