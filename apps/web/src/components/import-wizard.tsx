'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import posthog from 'posthog-js';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { IMPORTABLE_FIELD_TYPES } from '@storyos/schemas';
import { API_URL } from '@/lib/api';
import { matchExistingField } from '@storyos/schemas';
import { useDatabase } from '@/components/table-view/use-table-data';
import { useDatabases } from '@/lib/queries';
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
  | { kind: 'relation'; field_id?: string; target_database_id?: string; field_name?: string; match_field_id?: string }
  | { kind: 'skip' };

interface DryRun {
  rows: number;
  will_create: number;
  new_fields: Array<{ display_name: string; type: string }>;
  warnings: Array<{ row: number; column: string; message: string }>;
  warnings_total: number;
  /** #378 — present only when a key column is set; counts a plain create-only
   *  run never needs. */
  will_update?: number;
  will_skip?: number;
}

/** #378 — how an incoming row relates to a record that already exists,
 *  mirroring UpsertOptions on the server (import.service.ts). Undefined
 *  means create-only — the only behaviour possible before this ticket, and
 *  still the default: choosing a key column is opt-in. */
interface Upsert {
  column: string;
  match_field_id?: string;
  on_match: 'update' | 'skip' | 'create';
  on_no_match: 'create' | 'skip';
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

async function post(ws: string, db: string, file: File, mapping: unknown, dryRun: boolean, upsert?: Upsert) {
  const form = new FormData();
  form.append('mapping', JSON.stringify(mapping));
  form.append('dry_run', String(dryRun));
  form.append('file', file);
  // #378 — omitted entirely for a create-only run, matching the server's own
  // "absent = create-only, the previous behaviour" contract (import.controller.ts).
  if (upsert) form.append('upsert', JSON.stringify(upsert));
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

/** #377 — field types that can identify a record, mirroring MATCHABLE_KEY_TYPES
 *  on the server. The server rejects anything else with a reason; offering a
 *  wider list here would just move the failure later. */
const MATCHABLE = new Set(['title', 'text', 'number', 'email', 'url', 'id']);

/**
 * #377 — WHICH field on the target is matched.
 *
 * Its own component so the target database's fields can be fetched with a hook.
 * The founder's CSV carries both `company_id` (stable) and `company_name` (a
 * display name); before this only the title was usable, and titles duplicate,
 * get renamed, and substring-collide.
 */
function RelationMatchPicker({
  ws,
  targetDatabaseId,
  value,
  onChange,
}: {
  ws: string;
  targetDatabaseId: string;
  value?: string;
  onChange: (matchFieldId?: string) => void;
}) {
  const target = useDatabase(ws, targetDatabaseId);
  const candidates = (target.data?.fields ?? []).filter((f) => MATCHABLE.has(f.type));
  return (
    <select
      aria-label="Match on which field"
      className="h-8 w-40 shrink-0 rounded-[var(--radius-control)] border border-border-default bg-card px-2 text-[13px] text-ink"
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value || undefined)}
    >
      {/* The title stays the default: it is the previous behaviour and still the
          right guess for a human-written CSV. */}
      <option value="">match on title</option>
      {candidates
        .filter((f) => f.type !== 'title')
        .map((f) => (
          <option key={f.id} value={f.id}>
            match on {f.displayName}
          </option>
        ))}
    </select>
  );
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
  const [result, setResult] = useState<{ created: number; updated: number; skipped: number; warnings_total: number } | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  /** #378 — '' means create-only, the default and the only choice before this
   *  ticket. Set once, in the mapping step, applied to both the dry run and
   *  the commit — a key chosen for the check and dropped for the real run
   *  would report numbers that do not match what actually happened. */
  const [upsertColumn, setUpsertColumn] = useState('');
  const [upsertMatchField, setUpsertMatchField] = useState<string | undefined>(undefined);
  const [onMatch, setOnMatch] = useState<Upsert['on_match']>('update');
  const [onNoMatch, setOnNoMatch] = useState<Upsert['on_no_match']>('create');
  const upsert: Upsert | undefined = upsertColumn
    ? { column: upsertColumn, match_field_id: upsertMatchField, on_match: onMatch, on_no_match: onNoMatch }
    : undefined;
  /**
   * #373 — kept in STATE, not only in a toast. A toast cannot be scrolled when
   * many rows fail and cannot be selected, and people paste these into support
   * conversations. It disappears exactly when you go looking for it again.
   */
  const [failure, setFailure] = useState<ImportError | null>(null);
  /**
   * #379 — which columns were matched FOR the user. A silent pre-selection is
   * its own hazard: the whole point of this step is that they check it, so an
   * automatic choice has to be visible to be reviewable.
   */
  const [autoMatched, setAutoMatched] = useState<Set<string>>(new Set());

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
  /**
   * #377 — databases a column can be linked TO. `useDatabases` is grant-scoped,
   * so a user is never offered a target they cannot read.
   */
  const otherDatabases = (useDatabases(ws).data ?? []).filter((d) => d.id !== db);
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
      const matched = new Set<string>();
      boot.inferred.forEach((c: Inferred, i: number) => {
        if (i === 0) {
          initial.set(c.column, { kind: 'title' });
          return;
        }
        /**
         * #379 — prefer a field that already exists. Defaulting everything to
         * "new" meant importing into a database you had already set up proposed
         * duplicating its entire schema.
         */
        const hit = matchExistingField(c.column, existingFields);
        if (hit) {
          initial.set(c.column, { kind: 'existing', field_id: hit.id });
          matched.add(c.column);
          return;
        }
        initial.set(c.column, { kind: 'new', display_name: c.column, type: c.type });
      });
      setMapping(initial);
      setAutoMatched(matched);
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
      setDryRun(await post(ws, db, file!, mappingArray(), true, upsert));
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
      const res = await post(ws, db, file!, mappingArray(), false, upsert);
      setResult(res);
      void qc.invalidateQueries();
      posthog.capture('csv_import_completed', {
        records_created: res.created,
        records_updated: res.updated,
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

            {/* #378 — opt-in key matching. Absent by default: the overwhelming
                majority of imports are still plain create-only, and this must
                render identically to before when no key column is chosen. */}
            <div className="flex flex-col gap-2 rounded-[var(--radius-card)] border border-border-default bg-canvas p-3 text-[13px]">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-ink-secondary">Match existing records by</span>
                <select
                  aria-label="Key column"
                  className="h-8 rounded-[var(--radius-control)] border border-border-default bg-card px-2 text-[13px] text-ink"
                  value={upsertColumn}
                  onChange={(e) => setUpsertColumn(e.target.value)}
                >
                  <option value="">nothing — always create new records</option>
                  {inferred.map((c) => (
                    <option key={c.column} value={c.column}>
                      {c.column}
                    </option>
                  ))}
                </select>
                {upsertColumn && (
                  <>
                    <span className="text-ink-secondary">against</span>
                    <select
                      aria-label="Match on which field"
                      className="h-8 rounded-[var(--radius-control)] border border-border-default bg-card px-2 text-[13px] text-ink"
                      value={upsertMatchField ?? ''}
                      onChange={(e) => setUpsertMatchField(e.target.value || undefined)}
                    >
                      <option value="">the record title</option>
                      {(database.data?.fields ?? [])
                        .filter((f) => MATCHABLE.has(f.type) && f.type !== 'title')
                        .map((f) => (
                          <option key={f.id} value={f.id}>
                            {f.displayName}
                          </option>
                        ))}
                    </select>
                  </>
                )}
              </div>
              {upsertColumn && (
                <>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-ink-secondary">If a row matches:</span>
                    <select
                      aria-label="If a row matches"
                      className="h-8 rounded-[var(--radius-control)] border border-border-default bg-card px-2 text-[13px] text-ink"
                      value={onMatch}
                      onChange={(e) => setOnMatch(e.target.value as Upsert['on_match'])}
                    >
                      <option value="update">Update it</option>
                      <option value="skip">Skip it</option>
                      <option value="create">Create a new record anyway</option>
                    </select>
                    <span className="text-ink-secondary">If it doesn&apos;t match:</span>
                    <select
                      aria-label="If a row doesn't match"
                      className="h-8 rounded-[var(--radius-control)] border border-border-default bg-card px-2 text-[13px] text-ink"
                      value={onNoMatch}
                      onChange={(e) => setOnNoMatch(e.target.value as Upsert['on_no_match'])}
                    >
                      <option value="create">Create it</option>
                      <option value="skip">Skip it</option>
                    </select>
                  </div>
                  {/* #478 AC — the one place a user makes an irreversible choice;
                      the risk is stated here, not left in a docs page they may
                      not have read. import.service.ts:718-724: an update has no
                      before-image, so a failed import cannot undo it the way a
                      failed create-only import can. */}
                  {onMatch === 'update' && (
                    <p className="text-[12px] text-warning">
                      If this import fails partway through, newly created records are automatically
                      removed — but any records already updated stay updated. Only creates roll back.
                    </p>
                  )}
                </>
              )}
            </div>

            {/*
              The clip must land BETWEEN rows, never through one: a half-row reads
              as a rendering bug, a clean edge reads as "scroll me". #333 learned
              this on the pack list and it was unlearned one screen over.

              Each row is a fixed 52px and the container shows exactly 8 of them.

              418, not 416: Tailwind's max-h sets the BORDER box, and this element
              has a 1px border top and bottom. At 416 the content box is 414 —
              7.96 rows — so the clip landed 2px into the eighth row. Measured in
              the browser, not reasoned about; the first attempt here got it
              wrong in precisely the way this fix exists to prevent.
            */}
            <div className="max-h-[418px] overflow-y-auto overscroll-contain rounded-[var(--radius-card)] border border-border-default">
              {inferred.map((c) => {
                const to = mapping.get(c.column) ?? { kind: 'skip' as const };
                const sample = sampleRows.map((r) => r[inferred.indexOf(c)]).filter(Boolean).slice(0, 2).join(', ');
                const encoded =
                  to.kind === 'title' ? 'title'
                  : to.kind === 'skip' ? 'skip'
                  : to.kind === 'existing' ? `existing:${to.field_id}`
                  : to.kind === 'relation'
                    ? to.field_id
                      ? `relation:${to.field_id}`
                      : `newrelation:${to.target_database_id}`
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
                      <p className="truncate text-[11px] text-faint">
                        {/* #379 — say when the choice was made automatically. */}
                        {autoMatched.has(c.column) && to.kind === 'existing' ? (
                          <span className="text-accent">matched to an existing field · </span>
                        ) : null}
                        {sample}
                      </p>
                    </div>
                    {/* #372 — a CSV header is rarely the field name you want.
                        `hq_metro`, `one_liner`, `ukraine_signal` are machine
                        names, and the mapping step is the natural moment to fix
                        them. The API already accepted `display_name`; only the UI
                        never let you change it, which is also why a retry after a
                        failed run had no way to import the same column under a
                        different name. */}
                    {to.kind === 'new' && (
                      <input
                        aria-label={`Name for the new field from "${c.column}"`}
                        className="h-8 w-40 shrink-0 rounded-[var(--radius-control)] border border-border-default bg-card px-2 text-[13px] text-ink"
                        value={to.display_name}
                        onChange={(e) => {
                          const next = new Map(mapping);
                          next.set(c.column, { ...to, display_name: e.target.value });
                          setMapping(next);
                        }}
                      />
                    )}
                    {/* #377 — only for a relation, and only once a target is
                        known: an existing relation field's target comes from its
                        config, which the wizard does not have, so the picker is
                        offered for the create-a-relation case where it does. */}
                    {to.kind === 'relation' && to.target_database_id && (
                      <RelationMatchPicker
                        ws={ws}
                        targetDatabaseId={to.target_database_id}
                        value={to.match_field_id}
                        onChange={(matchFieldId) => {
                          const next = new Map(mapping);
                          next.set(c.column, { ...to, match_field_id: matchFieldId });
                          setMapping(next);
                        }}
                      />
                    )}
                    <select
                      className="h-8 w-56 shrink-0 rounded-[var(--radius-control)] border border-border-default bg-card px-2 text-[13px] text-ink"
                      value={encoded}
                      onChange={(e) => {
                        const v = e.target.value;
                        const next = new Map(mapping);
                        if (v === 'title') next.set(c.column, { kind: 'title' });
                        else if (v === 'skip') next.set(c.column, { kind: 'skip' });
                        else if (v.startsWith('existing:')) next.set(c.column, { kind: 'existing', field_id: v.slice(9) });
                        else if (v.startsWith('relation:')) next.set(c.column, { kind: 'relation', field_id: v.slice(9) });
                        else if (v.startsWith('newrelation:'))
                          next.set(c.column, {
                            kind: 'relation',
                            target_database_id: v.slice(12),
                            field_name: c.column,
                          });
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
                        <optgroup label="Link via an existing relation">
                          {relationFields.map((f) => (
                            <option key={f.id} value={`relation:${f.id}`}>
                              🔗 {f.displayName}
                            </option>
                          ))}
                        </optgroup>
                      )}
                      {/* #377 — link to a DATABASE, creating the relation. The
                          option used to render only when a relation field already
                          existed, so a brand-new database offered nothing at all
                          and importing two CSVs silently produced two
                          unconnected tables. */}
                      {otherDatabases.length > 0 && (
                        <optgroup label="Link to a database (creates the relation)">
                          {otherDatabases.map((d) => (
                            <option key={d.id} value={`newrelation:${d.id}`}>
                              🔗 ＋ {d.name}
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
                {/* #378 — a create-only run (no key column) shows the original
                    sentence unchanged; update/skip counts only appear once
                    they mean something. */}
                {upsertColumn
                  ? `${dryRun.will_create} will create, ${dryRun.will_update ?? 0} will update, ${dryRun.will_skip ?? 0} will skip — of ${dryRun.rows} rows`
                  : `${dryRun.will_create} of ${dryRun.rows} rows will import`}
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
            <p className="text-[15px] font-semibold text-ink">
              {upsertColumn
                ? `Created ${result.created}, updated ${result.updated}, skipped ${result.skipped} 🎉`
                : `Imported ${result.created} records 🎉`}
            </p>
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
