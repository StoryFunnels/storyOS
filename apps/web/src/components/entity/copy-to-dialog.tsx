'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { API_URL } from '@/lib/api';
import { useDatabase } from '@/components/table-view/use-table-data';
import { useDatabases, useSpaces } from '@/lib/queries';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';

interface FieldPlan {
  sourceKey: string;
  label: string;
  state: 'mapped' | 'skipped' | 'blocking';
  to: { kind: string; field_id?: string };
  reason?: string;
  ambiguousWith?: string[];
}

interface DryRunResult {
  dry_run: true;
  plans: FieldPlan[];
  will_create: number;
  will_update: number;
  new_fields: Array<{ display_name: string; type: string }>;
  warnings: Array<{ message: string }>;
  warnings_total: number;
  blocking?: Array<{ sourceKey: string; message: string }>;
}

interface ApplyResult {
  dry_run: false;
  created: string[];
  warnings: string[];
}

/**
 * #521's own response shape only ever forwards `message` and `details`
 * (all-exceptions.filter.ts) — a 422's `blocking` array is NOT `details`, so a
 * confirm that races a schema change and hits the refuse-don't-drop path loses
 * the per-field reasons the dry-run already showed. Falls back to the generic
 * message; the normal path never hits this since Confirm is disabled while any
 * row is blocking.
 */
class CopyError extends Error {}

async function copyRecords(
  ws: string,
  db: string,
  body: { record_ids: string[]; target_database_id: string; skip?: string[]; dry_run: boolean },
): Promise<DryRunResult | ApplyResult> {
  const res = await fetch(`${API_URL}/api/v1/workspaces/${ws}/databases/${db}/records/copy`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok) throw new CopyError(json?.error?.message ?? 'Copy failed');
  return json;
}

/**
 * #433 — "Copy to…": destination picker, a read-only auto-matched mapping
 * preview with a per-row Skip, a dry-run summary, and confirm.
 *
 * SCOPED, not the full ticket: #521's shipped endpoint takes only
 * `{ record_ids, target_database_id, skip[], dry_run }` — there is no
 * field-level override, so a row's destination can't be manually repointed and
 * an ambiguous relation can't be resolved from here. Filed as #561 (remap) and
 * tracked separately; this dialog shows the server's own match and lets the
 * one lever it actually has — skip — clear a blocking row.
 */
export function CopyToDialog({
  ws,
  db,
  dbName,
  recordIds,
  open,
  onOpenChange,
}: {
  ws: string;
  db: string;
  dbName: string;
  recordIds: string[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const qc = useQueryClient();
  const source = useDatabase(ws, db);
  const databases = useDatabases(ws);
  const spaces = useSpaces(ws);
  const sourceTypeByApiName = new Map((source.data?.fields ?? []).map((f) => [f.apiName, f.type]));

  const [target, setTarget] = useState('');
  const [skip, setSkip] = useState<Set<string>>(new Set());
  const [preview, setPreview] = useState<DryRunResult | null>(null);
  const [result, setResult] = useState<ApplyResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // #433/#561 note above — no destination is excluded by write access here
  // (list endpoint has no my_access, filed as #562); a viewer-only pick is
  // instead caught by the dry-run call itself failing below.
  const otherDatabases = (databases.data ?? []).filter((d) => d.id !== db);
  const spaceName = new Map((spaces.data ?? []).map((s) => [s.id, s.name]));
  const bySpace = new Map<string, typeof otherDatabases>();
  for (const d of otherDatabases) {
    const list = bySpace.get(d.spaceId) ?? [];
    list.push(d);
    bySpace.set(d.spaceId, list);
  }

  async function runDry(targetId: string, skipSet: Set<string>) {
    setBusy(true);
    setError(null);
    try {
      const res = (await copyRecords(ws, db, {
        record_ids: recordIds,
        target_database_id: targetId,
        skip: [...skipSet],
        dry_run: true,
      })) as DryRunResult;
      setPreview(res);
    } catch (e) {
      setPreview(null);
      setError(e instanceof CopyError ? e.message : 'Could not preview this destination');
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    // Only when the destination changes — a skip toggle re-runs explicitly via
    // toggleSkip, always starting a new destination with a clean skip set.
    if (target) void runDry(target, new Set());
  }, [target]);

  function toggleSkip(sourceKey: string) {
    const next = new Set(skip);
    if (next.has(sourceKey)) next.delete(sourceKey);
    else next.add(sourceKey);
    setSkip(next);
    void runDry(target, next);
  }

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      const res = (await copyRecords(ws, db, {
        record_ids: recordIds,
        target_database_id: target,
        skip: [...skip],
        dry_run: false,
      })) as ApplyResult;
      setResult(res);
      void qc.invalidateQueries({ queryKey: ['database', ws, target] });
      void qc.invalidateQueries({ queryKey: ['records', ws, target] });
    } catch (e) {
      setError(e instanceof CopyError ? e.message : 'Copy failed');
    } finally {
      setBusy(false);
    }
  }

  function reset() {
    setTarget('');
    setSkip(new Set());
    setPreview(null);
    setResult(null);
    setError(null);
  }

  const blocking = preview?.blocking ?? [];
  const single = recordIds.length === 1;

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o);
        if (!o) reset();
      }}
    >
      <DialogContent title={`Copy ${recordIds.length > 1 ? `${recordIds.length} records` : 'record'} from "${dbName}"`} className="max-w-lg">
        {/* #376 — fixed header/footer, only the middle scrolls. */}
        <div className="flex max-h-[75vh] flex-col gap-4">
          <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto pr-1">
            {error && (
              <div className="rounded-[var(--radius-card)] border border-error/40 bg-error/5 p-3 text-[13px]">
                <p className="font-medium text-error">{error}</p>
              </div>
            )}

            {!result && (
              <div className="flex flex-col gap-1.5">
                <label className="text-[12px] font-medium text-ink-secondary">Copy into</label>
                <select
                  className="h-8 rounded-[var(--radius-control)] border border-border-default bg-card px-2 text-[13px] text-ink"
                  value={target}
                  onChange={(e) => {
                    setSkip(new Set());
                    setPreview(null);
                    setTarget(e.target.value);
                  }}
                  autoFocus
                >
                  <option value="" disabled>
                    Choose a database…
                  </option>
                  {[...bySpace.entries()].map(([spaceId, dbs]) => (
                    <optgroup key={spaceId} label={spaceName.get(spaceId) ?? 'Space'}>
                      {dbs.map((d) => (
                        <option key={d.id} value={d.id}>
                          {d.name}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </select>
              </div>
            )}

            {!result && target && preview && (
              <>
                <p className="text-[13px] text-muted">
                  {preview.will_create} will create
                  {preview.warnings_total > 0 && ` · ${preview.warnings_total} warnings`}
                  {blocking.length > 0 && ` · ${blocking.length} blocking`}
                </p>

                {/* Mapping rows — read-only auto-match + the one lever the API has: Skip. */}
                <div className="max-h-[320px] overflow-y-auto overscroll-contain rounded-[var(--radius-card)] border border-border-default">
                  {preview.plans.map((p) => (
                    <div
                      key={p.sourceKey}
                      className="box-border flex h-[52px] items-center gap-3 border-b border-border-default px-3 last:border-b-0"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[13px] font-medium text-ink">{p.label}</p>
                        <p className="truncate text-[11px] text-faint">
                          {sourceTypeByApiName.get(p.sourceKey) ?? ''}
                          {p.state === 'blocking' && (
                            <span className="text-error"> · {p.reason ?? 'no matching field'}</span>
                          )}
                          {p.ambiguousWith && p.ambiguousWith.length > 0 && (
                            <span className="text-warning"> · ambiguous with {p.ambiguousWith.join(', ')}</span>
                          )}
                        </p>
                      </div>
                      <label className="flex shrink-0 items-center gap-1.5 text-[12px] text-ink-secondary">
                        <input
                          // Client-side truth, not p.state === 'skipped': the server also
                          // reports 'skipped' for a field with no value on this copy at all
                          // (planField's "nothing to lose" rule) — checking the box for that
                          // case would claim the user asked for something they didn't.
                          type="checkbox"
                          checked={skip.has(p.sourceKey)}
                          onChange={() => toggleSkip(p.sourceKey)}
                        />
                        Skip
                      </label>
                    </div>
                  ))}
                </div>

                {preview.warnings.length > 0 && (
                  <div className="max-h-24 overflow-y-auto">
                    {preview.warnings.map((w, i) => (
                      <p key={i} className="text-[12px] text-muted">
                        {w.message}
                      </p>
                    ))}
                  </div>
                )}
              </>
            )}

            {result && (
              <div className="rounded-[var(--radius-card)] border border-border-default bg-canvas p-4 text-center">
                <p className="text-[15px] font-semibold text-ink">
                  {single ? 'Record copied 🎉' : `${result.created.length} records copied 🎉`}
                </p>
                {result.warnings.length > 0 && (
                  <p className="mt-1 text-[12px] text-muted">{result.warnings.join(' ')}</p>
                )}
              </div>
            )}
          </div>

          <div className="flex shrink-0 justify-end gap-2 border-t border-border-default pt-3">
            <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
              {result ? 'Close' : 'Cancel'}
            </Button>
            {!result && (
              <Button
                type="button"
                disabled={!target || !preview || busy || blocking.length > 0}
                title={blocking.length > 0 ? `Blocking: ${blocking.map((b) => b.sourceKey).join(', ')}` : undefined}
                onClick={() => void confirm()}
              >
                {busy ? 'Copying…' : 'Confirm'}
              </Button>
            )}
            {result && single && (
              <Button
                type="button"
                onClick={() => {
                  onOpenChange(false);
                  router.push(`/w/${ws}/d/${target}/r/${result.created[0]}`);
                }}
              >
                Open record
              </Button>
            )}
            {result && !single && (
              <Button type="button" onClick={() => { onOpenChange(false); router.push(`/w/${ws}/d/${target}`); }}>
                Open database
              </Button>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
