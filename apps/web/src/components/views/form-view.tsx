'use client';

import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Copy, Share2 } from 'lucide-react';
import { useDatabase, useRecordMutations } from '../table-view/use-table-data';
import type { Field } from '../table-view/use-table-data';
import type { ViewConfig } from './use-view-state';

const SUPPORTED = new Set(['text', 'number', 'date', 'checkbox', 'url', 'email', 'select']);

type FormFieldCfg = { field_id: string; required?: boolean; label?: string; help?: string };

/** Form view (MN-101): renders the selected fields as inputs; submitting creates a
 * record. Editors get a builder + sharing panel; a public token exposes the form at
 * /f/:token (also embeddable), served by the unauthenticated public endpoint. */
export function FormView({
  ws,
  db,
  config,
  readOnly,
  onPatch,
}: {
  ws: string;
  db: string;
  config: ViewConfig;
  readOnly: boolean;
  onPatch?: (updates: Partial<ViewConfig>) => void;
  viewId?: string;
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
        {!readOnly && onPatch && (
          <FormBuilder config={config} fields={fields} onPatch={onPatch} />
        )}
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

/** Editors-only: sharing (public link + embed + access mode), form meta, and
 * per-field required/label config (MN-101). Writes everything into config.form. */
function FormBuilder({
  config,
  fields,
  onPatch,
}: {
  config: ViewConfig;
  fields: Field[];
  onPatch: (updates: Partial<ViewConfig>) => void;
}) {
  const [open, setOpen] = useState(false);
  const form = config.form ?? { fields: [] as FormFieldCfg[] };
  const token = form.public_token;
  const access = form.access ?? 'members';
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const link = token ? `${origin}/f/${token}` : '';
  const embed = token ? `<iframe src="${origin}/f/${token}?embed=1" width="100%" height="600" style="border:0"></iframe>` : '';

  // form.fields must list ALL shown fields so the public form renders them all.
  const fieldCfgs: FormFieldCfg[] = fields.map(
    (f) => (form.fields ?? []).find((x) => x.field_id === f.id) ?? { field_id: f.id },
  );
  const patchForm = (updates: Partial<NonNullable<ViewConfig['form']>>) =>
    onPatch({ form: { ...form, fields: fieldCfgs, ...updates } });
  const patchField = (fieldId: string, u: Partial<FormFieldCfg>) =>
    patchForm({ fields: fieldCfgs.map((c) => (c.field_id === fieldId ? { ...c, ...u } : c)) });

  const copy = async (text: string, what: string) => {
    await navigator.clipboard.writeText(text);
    toast.success(`${what} copied`);
  };

  return (
    <div className="mb-6 rounded-[var(--radius-card)] border border-border-default bg-card">
      <button
        type="button"
        className="flex w-full items-center gap-2 px-4 py-2.5 text-[13px] font-medium text-ink"
        onClick={() => setOpen((v) => !v)}
      >
        <Share2 className="h-4 w-4 text-muted" />
        Configure &amp; share
        {token && access !== 'members' && (
          <span className="ml-auto rounded-full bg-accent-soft px-2 py-0.5 text-[11px] text-accent">Live</span>
        )}
      </button>

      {open && (
        <div className="flex flex-col gap-4 border-t border-border-default p-4 text-[13px]">
          {/* Sharing */}
          <section className="flex flex-col gap-2">
            <p className="text-[11px] font-medium uppercase tracking-wider text-faint">Sharing</p>
            {!token ? (
              <button
                type="button"
                className="self-start rounded-[var(--radius-control)] bg-primary px-3 py-1.5 text-[13px] font-medium text-[var(--text-on-dark)] hover:brightness-110"
                onClick={() => patchForm({ public_token: crypto.randomUUID().replace(/-/g, ''), access: 'link' })}
              >
                Create a shareable link
              </button>
            ) : (
              <>
                <div className="flex items-center gap-2">
                  <label className="text-muted">Who can submit</label>
                  <select
                    className="h-8 rounded-[var(--radius-control)] border border-border-default bg-card px-2"
                    value={access}
                    onChange={(e) => patchForm({ access: e.target.value as 'members' | 'link' | 'public' })}
                  >
                    <option value="members">Members only</option>
                    <option value="link">Anyone with the link</option>
                    <option value="public">Public</option>
                  </select>
                </div>
                <CopyRow label="Link" value={link} onCopy={() => copy(link, 'Link')} />
                <CopyRow label="Embed" value={embed} onCopy={() => copy(embed, 'Embed snippet')} />
                <button
                  type="button"
                  className="self-start text-[12px] text-muted underline-offset-2 hover:text-error hover:underline"
                  onClick={() => patchForm({ public_token: undefined, access: 'members' })}
                >
                  Stop sharing
                </button>
              </>
            )}
          </section>

          {/* Form meta */}
          <section className="flex flex-col gap-2">
            <p className="text-[11px] font-medium uppercase tracking-wider text-faint">Form</p>
            <MetaInput label="Title" value={form.title ?? ''} onChange={(v) => patchForm({ title: v || undefined })} />
            <MetaInput label="Description" value={form.description ?? ''} onChange={(v) => patchForm({ description: v || undefined })} />
            <MetaInput label="Submit button" value={form.submit_text ?? ''} placeholder="Submit" onChange={(v) => patchForm({ submit_text: v || undefined })} />
            <MetaInput label="Success message" value={form.success_message ?? ''} onChange={(v) => patchForm({ success_message: v || undefined })} />
          </section>

          {/* Per-field */}
          {fields.length > 0 && (
            <section className="flex flex-col gap-2">
              <p className="text-[11px] font-medium uppercase tracking-wider text-faint">Fields</p>
              {fields.map((f) => {
                const cfg = fieldCfgs.find((c) => c.field_id === f.id)!;
                return (
                  <div key={f.id} className="flex items-center gap-2">
                    <input
                      className="h-8 flex-1 rounded-[var(--radius-control)] border border-border-default bg-card px-2 text-[13px]"
                      value={cfg.label ?? ''}
                      placeholder={f.displayName}
                      onChange={(e) => patchField(f.id, { label: e.target.value || undefined })}
                    />
                    <label className="flex items-center gap-1 text-[12px] text-muted">
                      <input
                        type="checkbox"
                        checked={cfg.required ?? false}
                        onChange={(e) => patchField(f.id, { required: e.target.checked || undefined })}
                      />
                      Required
                    </label>
                  </div>
                );
              })}
              <p className="text-[11px] text-faint">Use “Cards” in the toolbar to choose which fields appear.</p>
            </section>
          )}
        </div>
      )}
    </div>
  );
}

function CopyRow({ label, value, onCopy }: { label: string; value: string; onCopy: () => void }) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-12 shrink-0 text-muted">{label}</span>
      <input readOnly value={value} onFocus={(e) => e.target.select()} className="h-8 flex-1 rounded-[var(--radius-control)] border border-border-default bg-hover px-2 text-[12px] text-ink" />
      <button type="button" onClick={onCopy} className="rounded-[var(--radius-control)] border border-border-default p-1.5 text-muted hover:text-ink" aria-label={`Copy ${label}`}>
        <Copy className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

function MetaInput({ label, value, placeholder, onChange }: { label: string; value: string; placeholder?: string; onChange: (v: string) => void }) {
  return (
    <label className="flex items-center gap-2">
      <span className="w-24 shrink-0 text-muted">{label}</span>
      <input
        className="h-8 flex-1 rounded-[var(--radius-control)] border border-border-default bg-card px-2 text-[13px]"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}
