'use client';

import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { useDatabase, useRecordMutations } from '../table-view/use-table-data';
import type { Field } from '../table-view/use-table-data';
import type { ViewConfig } from './use-view-state';

const SUPPORTED = new Set(['text', 'number', 'date', 'checkbox', 'url', 'email', 'select']);

/** Form view (MN-094 v1): renders the selected fields as inputs; submitting creates
 * a record. Which fields appear is the toolbar "Cards" selection. Public shareable
 * links + required/label config are follow-ups (tracked in MN-094). */
export function FormView({
  ws,
  db,
  config,
  readOnly,
}: {
  ws: string;
  db: string;
  config: ViewConfig;
  readOnly: boolean;
}) {
  const database = useDatabase(ws, db);
  const { createRecord } = useRecordMutations(ws, db);
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [name, setName] = useState('');
  const [justSubmitted, setJustSubmitted] = useState(false);

  const fields = useMemo(
    () =>
      (database.data?.fields ?? []).filter(
        (f) => config.card_field_ids.includes(f.id) && SUPPORTED.has(f.type),
      ),
    [database.data, config.card_field_ids],
  );

  const heading = config.form?.title || database.data?.name || 'Form';

  const submit = () => {
    const clean: Record<string, unknown> = { name: name.trim() || 'Untitled' };
    for (const f of fields) {
      const v = values[f.apiName];
      if (v !== undefined && v !== '' && v !== null) clean[f.apiName] = v;
    }
    createRecord.mutate(clean, {
      onSuccess: () => {
        setValues({});
        setName('');
        setJustSubmitted(true);
        toast.success('Submitted');
        setTimeout(() => setJustSubmitted(false), 2500);
      },
      onError: () => toast.error('Could not submit'),
    });
  };

  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto max-w-xl px-6 py-8">
        <h1 className="text-2xl font-bold text-ink">{heading}</h1>
        {config.form?.description && <p className="mt-1 text-[13px] text-muted">{config.form.description}</p>}

        <form
          className="mt-6 flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (!readOnly) submit();
          }}
        >
          <Row label="Name" required>
            <input
              className="h-9 w-full rounded-[var(--radius-control)] border border-border-default bg-card px-2.5 text-sm text-ink outline-none focus:border-border-strong"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
            />
          </Row>

          {fields.map((field) => (
            <Row key={field.id} label={field.displayName}>
              <FieldInput field={field} value={values[field.apiName]} onChange={(v) => setValues((p) => ({ ...p, [field.apiName]: v }))} />
            </Row>
          ))}

          {fields.length === 0 && (
            <p className="rounded-[var(--radius-card)] border border-dashed border-border-default px-3 py-2 text-[12px] text-faint">
              Use “Cards” in the toolbar to choose which fields appear on this form.
            </p>
          )}

          <div className="flex items-center gap-3">
            <button
              type="submit"
              disabled={readOnly || createRecord.isPending}
              className="rounded-[var(--radius-control)] bg-primary px-4 py-2 text-[13px] font-medium text-[var(--text-on-dark)] hover:brightness-110 disabled:opacity-50"
            >
              {config.form?.submit_text || 'Submit'}
            </button>
            {justSubmitted && <span className="text-[13px] text-success">✓ Added</span>}
          </div>
        </form>
      </div>
    </div>
  );
}

function Row({ label, required, children }: { label: string; required?: boolean; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-[12px] font-medium text-ink-secondary">
        {label}
        {required && <span className="ml-0.5 text-error">*</span>}
      </span>
      {children}
    </label>
  );
}

function FieldInput({ field, value, onChange }: { field: Field; value: unknown; onChange: (v: unknown) => void }) {
  const base =
    'h-9 w-full rounded-[var(--radius-control)] border border-border-default bg-card px-2.5 text-sm text-ink outline-none focus:border-border-strong';
  switch (field.type) {
    case 'checkbox':
      return <input type="checkbox" className="h-4 w-4" checked={value === true} onChange={(e) => onChange(e.target.checked)} />;
    case 'number':
      return <input type="number" className={base} value={(value as number) ?? ''} onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))} />;
    case 'date':
      return <input type="date" className={base} value={(value as string) ?? ''} onChange={(e) => onChange(e.target.value || undefined)} />;
    case 'url':
    case 'email':
      return <input type={field.type} className={base} value={(value as string) ?? ''} onChange={(e) => onChange(e.target.value)} />;
    case 'select':
      return (
        <select className={base} value={(value as string) ?? ''} onChange={(e) => onChange(e.target.value || undefined)}>
          <option value="">—</option>
          {field.options?.map((o) => (
            <option key={o.id} value={o.id}>{o.label}</option>
          ))}
        </select>
      );
    default:
      return <input className={base} value={(value as string) ?? ''} onChange={(e) => onChange(e.target.value)} />;
  }
}
