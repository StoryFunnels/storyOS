'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import posthog from 'posthog-js';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { IMPORTABLE_FIELD_TYPES } from '@storyos/schemas';
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

/**
 * #375 — DERIVED from the shared schema, not re-listed here.
 *
 * This was a hardcoded seven while the product had sixteen, so rich text,
 * workflow, multi-select and person could not be created on import at all —
 * with nothing on screen indicating anything was missing.
 */
const NEW_TYPES = IMPORTABLE_FIELD_TYPES;

/** Human labels — the raw enum reads as "New rich_text field" otherwise. */
const TYPE_LABEL: Record<string, string> = {
  text: 'Text',
  rich_text: 'Rich text',
  number: 'Number',
  checkbox: 'Checkbox',
  date: 'Date',
  select: 'Select',
  multi_select: 'Multi-select',
  workflow: 'Workflow (status)',
  url: 'URL',
  email: 'Email',
  color: 'Color',
  user: 'Person',
};

/**
 * #373 — a failed import used to surface as `body?.error?.message`, i.e. the
 * single string "Record values validation failed". StoryOS validation errors
 * carry a `details` array with the path and reason for EVERY problem, and that
 * array was dropped one line before it would have been displayed.
 *
 * The information needed to find the bad cell existed, crossed the network, and
 * was thrown away — which turned a five-second fix into a debugging session. The
 * shape of the mistake is treating a structured error as a string; the same
 * class as #343, where MCP write tools discarded the parts of a response they
 * did not happen to use.
 */
export class ImportError extends Error {
  readonly details: Array<{ path?: string; message: string }>;
  constructor(message: string, details: Array<{ path?: string; message: string }> = []) {
    super(message);
    this.name = 'ImportError';
    this.details = details;
  }
}

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
  if (!res.ok) {
    const err = body?.error ?? {};
    const details = Array.isArray(err.details) ? err.details : [];
    throw new ImportError(err.message ?? 'Import failed', details);
  }
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
  /**
   * #373 — kept in STATE, not only in a toast. A toast cannot be scrolled when
   * many rows fail and cannot be selected, and people paste these into support
   * conversations. It disappears exactly when you go looking for it again.
   */
  const [failure, setFailure] = useState<ImportError | null>(null);

  const existingFields = (database.data?.fields ?? []).filter(
    (f) => !f.isSystem && !['title', 'lookup', 'button', 'created_at', 'updated_at', 'created_by'].includes(f.type),
  );
  const relationFields = (database.data?.fields ?? []).filter((f) => f.type === 'relation');
  /**
   * #375 — a database may have AT MOST ONE workflow field (#172), enforced
   * server-side. Offering a second would let the user map a column, click
   * through the whole wizard, and collect a 422 at the very end — the exact
   * shape of failure this ticket exists to remove. Filtered out rather than
   * offered-and-rejected.
   */
  const hasWorkflow = (database.data?.fields ?? []).some((f) => f.type === 'workflow');
  const offerableTypes = NEW_TYPES.filter((t) => t !== 'workflow' || !hasWorkflow);

  async function onUpload(f: File) {
    setBusy(true);
    setFailure(null);
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
      const err = error instanceof ImportError ? error : new ImportError((error as Error).message);
      setFailure(err);
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  }

  function mappingArray() {
    return [...mapping.entries()].map(([column, to]) => ({ column, to }));
  }

  async function runDry() {
    setBusy(true);
    setFailure(null);
    try {
      setDryRun(await post(ws, db, file!, mappingArray(), true));
    } catch (error) {
      const err = error instanceof ImportError ? error : new ImportError((error as Error).message);
      setFailure(err);
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function commit() {
    setBusy(true);
    setFailure(null);
    try {
      const res = await post(ws, db, file!, mappingArray(), false);
      setResult(res);
      void qc.invalidateQueries();
      posthog.capture('csv_import_completed', {
        records_created: res.created,
        warnings_total: res.warnings_total,
      });
    } catch (error) {
      const err = error instanceof ImportError ? error : new ImportError((error as Error).message);
      setFailure(err);
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  }

  const step = result ? 4 : dryRun ? 3 : file ? 2 : 1;

  return (
    <DialogContent title={`Import CSV into "${database.data?.name ?? '…'}"`} className="max-w-2xl">
      {/* #376 — the footer used to live INSIDE this scroll container, so the
          actions were not reliably reachable on a wide CSV. Outer is a plain
          flex column now; only the body scrolls, and the footer is pinned below
          it. Same fix #333 applied to the create-workspace screen. */}
      <div className="flex max-h-[75vh] flex-col gap-4">
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto pr-1">
        {failure && (
          /* #373 — the specifics the server sent, shown instead of discarded.
             `select-text` because these get pasted into support threads. */
          <div className="rounded-[var(--radius-card)] border border-error/40 bg-error/5 p-3 text-[13px]">
            <p className="font-medium text-error">{failure.message}</p>
            {/* Whether ANYTHING landed was previously unstated, and it is the
                first thing you want to know before retrying. */}
            <p className="mt-1 text-muted">
              {step === 4 ? 'Some rows may have been imported — check the summary.' : 'Nothing was imported.'}
            </p>
            {failure.details.length > 0 && (
              <ul className="mt-2 max-h-40 select-text space-y-1 overflow-y-auto font-mono text-[12px] text-ink-secondary">
                {failure.details.map((d, i) => (
                  <li key={i}>
                    {d.path ? <span className="text-faint">{d.path}: </span> : null}
                    {d.message}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
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
              {/* #376 — with 22 columns there was no sense of scale: no count, and
                  no way to tell how far down you had got. */}
              Map each column — <span className="text-ink">{inferred.length} columns</span>. Exactly one must be
              the record title.
            </p>
            {/*
              The clip must land BETWEEN rows, never through one: a half-row reads
              as a rendering bug, a clean edge reads as "scroll me". #333 learned
              this on the pack list and it was unlearned one screen over.

              Each row is a fixed 52px, so the container is an exact multiple of
              it — 8 rows. A vh-based height cannot guarantee that, which is
              precisely how the mid-row cut happened.
            */}
            <div className="max-h-[416px] overflow-y-auto overscroll-contain rounded-[var(--radius-card)] border border-border-default">
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
                  <div
                    key={c.column}
                    /* #376 — an EXPLICIT row height, not an emergent one. The
                       container's max-height is a multiple of this, which is what
                       guarantees the clip lands between rows. Left to `py-2` plus
                       two lines of differently-sized text, the row height depends
                       on line-height config and the multiple silently stops being
                       one — which is how the mid-row cut happened. box-border so
                       the 1px divider is inside the 52. */
                    className="box-border flex h-[52px] items-center gap-3 border-b border-border-default px-3 last:border-b-0"
                  >
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
                        {offerableTypes.map((t) => (
                          <option key={t} value={`new:${t}`}>
                            ＋ New {TYPE_LABEL[t] ?? t} field
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

        </div>

        <div className="flex shrink-0 justify-between gap-2 border-t border-border-default pt-3">
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
