'use client';

import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { useQuery } from '@tanstack/react-query';
import { Copy, GripVertical, ListChecks, Plus, Share2, X } from 'lucide-react';
import { DndContext, PointerSensor, closestCenter, useSensor, useSensors } from '@dnd-kit/core';
import type { DragEndEvent } from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { api } from '@/lib/api';
import { useDatabase, useMembers, useRecordMutations } from '../table-view/use-table-data';
import type { Field } from '../table-view/use-table-data';
import type { ViewConfig } from './use-view-state';
import {
  FORM_FIELD_TYPES,
  patchFieldConfig,
  reorderFieldSelection,
  resolveFormFieldIds,
  toggleFieldSelection,
} from './form-fields';
import type { FormFieldCfg } from './form-fields';

/** Form view (MN-101, #224): a drag-to-reorder sidebar owns which fields appear
 * (config.form.fields) and their order — the generic Cards popover no longer
 * decides form field membership. Submitting creates a record. Editors get the
 * sidebar builder + a sharing panel; a public token exposes the form at /f/:token
 * (also embeddable), served by the unauthenticated public endpoint. */
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
  const [fieldsSidebarOpen, setFieldsSidebarOpen] = useState(false);

  const allFields = database.data?.fields ?? [];
  const formCfgs = config.form?.fields ?? [];
  const fields = useMemo(() => {
    const byId = new Map(allFields.map((f) => [f.id, f]));
    const ids = resolveFormFieldIds(config.form?.fields ?? [], config.card_field_ids);
    return ids
      .map((id) => byId.get(id))
      .filter((f): f is Field => f !== undefined && FORM_FIELD_TYPES.has(f.type));
  }, [allFields, config.form?.fields, config.card_field_ids]);

  const hasUserField = fields.some((f) => f.type === 'user');
  const members = useMembers(ws, hasUserField && !readOnly);
  const memberList = (members.data ?? []).map((m) => ({ id: m.user.id, name: m.user.name }));

  const hasTitleField = fields.some((f) => f.type === 'title');
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
          <div className="mb-6 flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <button
                type="button"
                className="flex items-center gap-1.5 rounded-[var(--radius-control)] border border-border-default bg-card px-3 py-1.5 text-[13px] font-medium text-ink hover:bg-hover"
                onClick={() => setFieldsSidebarOpen(true)}
              >
                <ListChecks className="h-3.5 w-3.5 text-muted" />
                Fields {fields.length > 0 && <span className="text-muted">({fields.length})</span>}
              </button>
            </div>
            <FormBuilder config={config} fields={fields} onPatch={onPatch} />
          </div>
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
          {!hasTitleField && (
            <Row label="Name" required>
              <input
                className="h-9 w-full rounded-[var(--radius-control)] border border-border-default bg-card px-2.5 text-sm text-ink outline-none focus:border-border-strong"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
              />
            </Row>
          )}

          {fields.map((field) => {
            const cfg = formCfgs.find((c) => c.field_id === field.id);
            return (
              <Row
                key={field.id}
                label={cfg?.label || field.displayName}
                required={field.type === 'title' || (cfg?.required ?? false)}
              >
                <FieldInput
                  ws={ws}
                  field={field}
                  value={values[field.apiName]}
                  members={memberList}
                  onChange={(v) => {
                    if (field.type === 'title' && typeof v === 'string') setName(v);
                    setValues((p) => ({ ...p, [field.apiName]: v }));
                  }}
                />
                {cfg?.help && <span className="mt-0.5 text-[11px] text-faint">{cfg.help}</span>}
              </Row>
            );
          })}

          {fields.length === 0 && (
            <p className="rounded-[var(--radius-card)] border border-dashed border-border-default px-3 py-2 text-[12px] text-faint">
              Use the “Fields” panel to choose which fields appear on this form.
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

      {!readOnly && onPatch && fieldsSidebarOpen && (
        <FormFieldsSidebar
          allFields={allFields}
          config={config}
          onPatch={onPatch}
          onClose={() => setFieldsSidebarOpen(false)}
        />
      )}
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

function FieldInput({
  ws,
  field,
  value,
  members,
  onChange,
}: {
  ws: string;
  field: Field;
  value: unknown;
  members: Array<{ id: string; name: string }>;
  onChange: (v: unknown) => void;
}) {
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
    case 'multi_select': {
      const ids = (value as string[]) ?? [];
      return (
        <div className="flex flex-wrap gap-2">
          {field.options?.map((o) => (
            <label key={o.id} className="flex items-center gap-1.5 text-[13px] text-ink">
              <input
                type="checkbox"
                checked={ids.includes(o.id)}
                onChange={(e) =>
                  onChange(e.target.checked ? [...ids, o.id] : ids.filter((id) => id !== o.id))
                }
              />
              {o.label}
            </label>
          ))}
        </div>
      );
    }
    case 'user': {
      const multi = field.config['multi'] === true;
      const ids = multi ? ((value as string[]) ?? []) : value ? [value as string] : [];
      return (
        <div className="flex flex-col gap-1.5 rounded-[var(--radius-control)] border border-border-default bg-card p-2">
          {members.length === 0 && <span className="text-[12px] text-faint">No members</span>}
          {members.map((m) => (
            <label key={m.id} className="flex items-center gap-1.5 text-[13px] text-ink">
              <input
                type={multi ? 'checkbox' : 'radio'}
                name={field.id}
                checked={ids.includes(m.id)}
                onChange={() => {
                  if (!multi) return onChange(m.id);
                  onChange(ids.includes(m.id) ? ids.filter((id) => id !== m.id) : [...ids, m.id]);
                }}
              />
              {m.name}
            </label>
          ))}
        </div>
      );
    }
    case 'relation':
      return <RelationInput ws={ws} field={field} value={value} onChange={onChange} />;
    case 'title':
      return <input className={base} value={(value as string) ?? ''} onChange={(e) => onChange(e.target.value)} required />;
    default:
      return <input className={base} value={(value as string) ?? ''} onChange={(e) => onChange(e.target.value)} />;
  }
}

/** In-app relation input: search the target database, pick or create a target.
 * Values are held locally as ids and written inline on submit — the record
 * doesn't exist yet, so there's nothing to PUT /links against (unlike the
 * table's RelationEditor, which edits an existing row). */
function RelationInput({
  ws,
  field,
  value,
  onChange,
}: {
  ws: string;
  field: Field;
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  const relation = field.relation;
  const targetDb = relation?.target_database_id;
  const single = relation?.cardinality === 'one_to_many' && relation?.side === 'a';
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState(false);
  const selectedIds = (Array.isArray(value) ? (value as string[]) : value ? [String(value)] : []).filter(Boolean);

  const results = useQuery({
    queryKey: ['form-relation-picker', ws, targetDb, search],
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/workspaces/{ws}/databases/{db}/records', {
        params: { path: { ws, db: targetDb! }, query: { q: search || undefined, limit: 20 } },
      });
      if (error) throw error;
      return (data as unknown as { data: Array<{ id: string; title: string }> }).data;
    },
    enabled: Boolean(targetDb) && open,
  });

  const [titles, setTitles] = useState<Map<string, string>>(new Map());
  const pick = (id: string, title: string) => {
    setTitles((m) => new Map(m).set(id, title));
    if (single) {
      onChange([id]);
      setOpen(false);
      setSearch('');
      return;
    }
    onChange(selectedIds.includes(id) ? selectedIds.filter((i) => i !== id) : [...selectedIds, id]);
  };

  if (!relation || !targetDb) {
    return <span className="text-[12px] text-faint">Relation is not configured</span>;
  }

  return (
    <div className="relative">
      <div className="flex flex-wrap items-center gap-1.5 rounded-[var(--radius-control)] border border-border-default bg-card px-2 py-1.5">
        {selectedIds.map((id) => (
          <span key={id} className="flex items-center gap-1 rounded border border-border-default bg-hover px-1.5 py-0.5 text-[12px] text-ink">
            {titles.get(id) ?? id}
            <button
              type="button"
              className="text-faint hover:text-error"
              onClick={() => onChange(selectedIds.filter((i) => i !== id))}
            >
              <X className="h-3 w-3" />
            </button>
          </span>
        ))}
        <input
          className="h-6 min-w-24 flex-1 border-0 bg-transparent text-[13px] text-ink outline-none placeholder:text-faint"
          placeholder={`Search ${relation.target_database_name ?? 'records'}…`}
          value={search}
          onFocus={() => setOpen(true)}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>
      {open && (
        <div
          className="absolute left-0 top-full z-20 mt-1 max-h-52 w-full overflow-y-auto rounded-[var(--radius-card)] border border-border-default bg-card p-1 shadow-[0_4px_12px_rgba(15,23,41,0.08)]"
          onMouseLeave={() => setOpen(false)}
        >
          {(results.data ?? []).map((r) => (
            <button
              key={r.id}
              type="button"
              className="flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-[13px] text-ink hover:bg-hover"
              onClick={() => pick(r.id, r.title)}
            >
              <span className="truncate">{r.title || 'Untitled'}</span>
              {selectedIds.includes(r.id) && <span className="text-[11px] text-muted">selected</span>}
            </button>
          ))}
          {results.data?.length === 0 && (
            <p className="px-2 py-1.5 text-[12px] text-faint">No matches</p>
          )}
        </div>
      )}
    </div>
  );
}

/** Editors-only: sharing (public link + embed + access mode) and form meta
 * (title/description/submit/success text). Per-field required/label/help and
 * membership/order now live in FormFieldsSidebar (#224). Writes into config.form. */
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

  const copy = async (text: string, what: string) => {
    await navigator.clipboard.writeText(text);
    toast.success(`${what} copied`);
  };

  return (
    <div className="rounded-[var(--radius-card)] border border-border-default bg-card">
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
        </div>
      )}
    </div>
  );
}

/**
 * Drag-to-reorder sidebar builder (#224): the SOLE source of "which fields are
 * on the form" for form views, replacing the generic Cards popover for forms
 * specifically. Picks fields from the database, orders them by drag, and edits
 * each one's required/label/help. Writes directly into config.form.fields.
 */
function FormFieldsSidebar({
  allFields,
  config,
  onPatch,
  onClose,
}: {
  allFields: Field[];
  config: ViewConfig;
  onPatch: (updates: Partial<ViewConfig>) => void;
  onClose: () => void;
}) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
  const selectable = allFields.filter((f) => FORM_FIELD_TYPES.has(f.type));
  const formCfgs = config.form?.fields ?? [];
  const selectedIds = resolveFormFieldIds(formCfgs, config.card_field_ids).filter((id) =>
    selectable.some((f) => f.id === id),
  );
  const selected = selectedIds
    .map((id) => selectable.find((f) => f.id === id))
    .filter((f): f is Field => Boolean(f));
  const available = selectable.filter((f) => !selectedIds.includes(f.id));
  const cfgByField = new Map(formCfgs.map((c) => [c.field_id, c]));

  const commit = (fieldsCfg: FormFieldCfg[]) =>
    onPatch({ form: { ...(config.form ?? { fields: [] }), fields: fieldsCfg } });

  const toggle = (fieldId: string) => commit(toggleFieldSelection(selectedIds, formCfgs, fieldId));
  const patchField = (fieldId: string, u: Partial<Omit<FormFieldCfg, 'field_id'>>) =>
    commit(patchFieldConfig(selectedIds, formCfgs, fieldId, u));

  const onDragEnd = (e: DragEndEvent) => {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const from = selectedIds.indexOf(String(active.id));
    const to = selectedIds.indexOf(String(over.id));
    if (from < 0 || to < 0) return;
    commit(reorderFieldSelection(selectedIds, formCfgs, from, to));
  };

  return (
    <div className="fixed inset-0 z-40" role="dialog" aria-label="Form fields">
      <div className="absolute inset-0 bg-[rgba(15,23,41,0.35)]" onClick={onClose} />
      <div className="absolute right-0 top-0 flex h-full w-80 flex-col gap-4 overflow-y-auto border-l border-border-default bg-card p-4">
        <div className="flex items-center justify-between">
          <h2 className="text-[13px] font-semibold text-ink">Form fields</h2>
          <button type="button" onClick={onClose} className="text-muted hover:text-ink" aria-label="Close">
            <X className="h-4 w-4" />
          </button>
        </div>

        <section className="flex flex-col gap-1.5">
          <p className="text-[11px] font-medium uppercase tracking-wider text-faint">On this form · drag to reorder</p>
          {selected.length === 0 && (
            <p className="rounded-[var(--radius-card)] border border-dashed border-border-default px-2.5 py-2 text-[12px] text-faint">
              No fields yet — add one below.
            </p>
          )}
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
            <SortableContext items={selectedIds} strategy={verticalListSortingStrategy}>
              <div className="flex flex-col gap-1.5">
                {selected.map((field) => (
                  <SortableFormField
                    key={field.id}
                    field={field}
                    cfg={cfgByField.get(field.id) ?? { field_id: field.id }}
                    onRemove={() => toggle(field.id)}
                    onPatch={(u) => patchField(field.id, u)}
                  />
                ))}
              </div>
            </SortableContext>
          </DndContext>
        </section>

        {available.length > 0 && (
          <section className="flex flex-col gap-1.5">
            <p className="text-[11px] font-medium uppercase tracking-wider text-faint">Add a field</p>
            {available.map((field) => (
              <button
                key={field.id}
                type="button"
                onClick={() => toggle(field.id)}
                className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[13px] text-muted hover:bg-hover hover:text-ink"
              >
                <Plus className="h-3.5 w-3.5" /> {field.displayName}
              </button>
            ))}
          </section>
        )}
      </div>
    </div>
  );
}

function SortableFormField({
  field,
  cfg,
  onRemove,
  onPatch,
}: {
  field: Field;
  cfg: FormFieldCfg;
  onRemove: () => void;
  onPatch: (u: Partial<Omit<FormFieldCfg, 'field_id'>>) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({ id: field.id });
  const [expanded, setExpanded] = useState(false);
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className="rounded-[var(--radius-card)] border border-border-default bg-app"
    >
      <div className="flex items-center gap-1.5 px-2 py-1.5">
        <button {...attributes} {...listeners} className="cursor-grab text-faint hover:text-muted" title="Drag to reorder">
          <GripVertical className="h-3.5 w-3.5" />
        </button>
        <button type="button" onClick={() => setExpanded((v) => !v)} className="flex-1 truncate text-left text-[13px] text-ink">
          {field.displayName}
          <span className="ml-1 text-[11px] text-faint">· {field.type}</span>
        </button>
        <button type="button" onClick={onRemove} className="text-faint hover:text-error" title="Remove from form">
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      {expanded && (
        <div className="flex flex-col gap-1.5 border-t border-border-default p-2">
          <input
            className="h-7 rounded border border-border-default bg-card px-2 text-[12px] text-ink"
            value={cfg.label ?? ''}
            placeholder={field.displayName}
            onChange={(e) => onPatch({ label: e.target.value || undefined })}
          />
          <input
            className="h-7 rounded border border-border-default bg-card px-2 text-[12px] text-ink"
            value={cfg.help ?? ''}
            placeholder="Help text (optional)"
            onChange={(e) => onPatch({ help: e.target.value || undefined })}
          />
          <label className="flex items-center gap-1.5 text-[12px] text-muted">
            <input
              type="checkbox"
              checked={cfg.required ?? false}
              onChange={(e) => onPatch({ required: e.target.checked || undefined })}
            />
            Required
          </label>
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
