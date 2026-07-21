'use client';

import { use, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';

const API = process.env.NEXT_PUBLIC_API_URL || '';

interface FormField {
  field_id: string;
  api_name: string;
  type: string;
  label: string;
  help: string | null;
  required: boolean;
  options?: Array<{ id: string; label: string }>;
  /** Relation fields only (#224) — the record picker's target + cardinality. */
  relation?: { target_database_id: string; target_database_name: string | null; single: boolean };
  /** User fields only (#224) — the workspace roster, id + name only (no PII). */
  members?: Array<{ id: string; name: string }>;
  /** User fields only (#224) — must match the field's own single/multi config;
   * the write path rejects an array for a non-multi field and vice versa. */
  multi?: boolean;
}
interface FormDef {
  title: string;
  description: string | null;
  submit_text: string;
  success_message: string | null;
  redirect_url: string | null;
  /** Paid-plan white-label (#269) — hides the "Powered by StoryOS" attribution. */
  hide_branding: boolean;
  fields: FormField[];
}

/**
 * Public, unauthenticated form (MN-101). Rendered with no app chrome so it can be
 * shared by link or embedded via `?embed=1`. Submits to the public endpoint,
 * which creates a record anonymously. Relation and user inputs (#224) call two
 * extra token-scoped public endpoints — search/create for relations, and the
 * roster embedded in the form definition for users.
 *
 * "Powered by StoryOS" attribution (#269) renders on both the standalone link
 * and the embed — the embed is the higher-value growth surface, since that's
 * where people who've never heard of StoryOS actually see the form. Paid
 * workspaces skip it via `def.hide_branding` (set server-side from the
 * workspace's plan, MN-168's entitlements read path).
 */
export default function PublicFormPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const embed = useSearchParams().get('embed') === '1';
  const [def, setDef] = useState<FormDef | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'notfound' | 'done'>('loading');
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hp, setHp] = useState('');

  useEffect(() => {
    fetch(`${API}/api/v1/public/forms/${token}`, { credentials: 'omit' })
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then((d: FormDef) => {
        setDef(d);
        setStatus('ready');
      })
      .catch(() => setStatus('notfound'));
  }, [token]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`${API}/api/v1/public/forms/${token}`, {
        method: 'POST',
        credentials: 'omit',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ values, hp }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error?.message ?? 'Something went wrong. Please try again.');
      }
      if (def?.redirect_url) {
        window.location.href = def.redirect_url;
        return;
      }
      setStatus('done');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
    } finally {
      setSubmitting(false);
    }
  }

  const wrap = embed ? 'p-4' : 'min-h-screen bg-[#FAF7F1] px-4 py-12';

  if (status === 'loading') {
    return <div className={wrap}><p className="mx-auto max-w-xl text-sm text-neutral-500">Loading…</p></div>;
  }
  if (status === 'notfound') {
    return (
      <div className={wrap}>
        <div className="mx-auto max-w-xl rounded-xl border border-neutral-200 bg-white p-8 text-center">
          <h1 className="text-lg font-semibold text-neutral-900">Form not found</h1>
          <p className="mt-2 text-sm text-neutral-500">This form doesn&rsquo;t exist or is no longer accepting responses.</p>
        </div>
      </div>
    );
  }
  if (status === 'done') {
    return (
      <div className={wrap}>
        <div className="mx-auto max-w-xl rounded-xl border border-neutral-200 bg-white p-8 text-center">
          <h1 className="text-lg font-semibold text-neutral-900">Thank you</h1>
          <p className="mt-2 text-sm text-neutral-600">{def?.success_message ?? 'Your response has been submitted.'}</p>
        </div>
      </div>
    );
  }

  return (
    <div className={wrap}>
      <form onSubmit={submit} className="mx-auto flex max-w-xl flex-col gap-5 rounded-xl border border-neutral-200 bg-white p-8">
        <div>
          <h1 className="text-xl font-semibold text-neutral-900">{def!.title}</h1>
          {def!.description && <p className="mt-1 text-sm text-neutral-500">{def!.description}</p>}
        </div>
        {def!.fields.map((f) => (
          <label key={f.field_id} className="flex flex-col gap-1.5">
            <span className="text-[13px] font-medium text-neutral-800">
              {f.label}
              {f.required && <span className="ml-0.5 text-red-500">*</span>}
            </span>
            <Input
              token={token}
              field={f}
              value={values[f.api_name]}
              onChange={(v) => setValues((p) => ({ ...p, [f.api_name]: v }))}
            />
            {f.help && <span className="text-[12px] text-neutral-400">{f.help}</span>}
          </label>
        ))}
        {/* Honeypot — hidden from humans; bots fill it. */}
        <input
          type="text"
          tabIndex={-1}
          autoComplete="off"
          value={hp}
          onChange={(e) => setHp(e.target.value)}
          className="absolute left-[-9999px] h-0 w-0 opacity-0"
          aria-hidden
        />
        {error && <p className="text-[13px] text-red-600">{error}</p>}
        <button
          type="submit"
          disabled={submitting}
          className="mt-1 rounded-lg bg-neutral-900 px-4 py-2.5 text-sm font-medium text-white hover:bg-neutral-800 disabled:opacity-50"
        >
          {submitting ? 'Submitting…' : def!.submit_text}
        </button>
        {!def!.hide_branding && <p className="text-center text-[11px] text-neutral-400">Powered by StoryOS</p>}
      </form>
    </div>
  );
}

function Input({
  token,
  field,
  value,
  onChange,
}: {
  token: string;
  field: FormField;
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  const base =
    'rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-900 outline-none focus:border-neutral-900';
  const t = field.type;
  if (t === 'checkbox') {
    return (
      <input type="checkbox" checked={Boolean(value)} onChange={(e) => onChange(e.target.checked)} className="h-4 w-4" />
    );
  }
  if (t === 'select' || t === 'multi_select') {
    return (
      <select
        className={base}
        value={(value as string) ?? ''}
        onChange={(e) => onChange(t === 'multi_select' ? [e.target.value] : e.target.value)}
        required={field.required}
      >
        <option value="">Select…</option>
        {(field.options ?? []).map((o) => (
          <option key={o.id} value={o.id}>
            {o.label}
          </option>
        ))}
      </select>
    );
  }
  if (t === 'user') {
    const members = field.members ?? [];
    const multi = field.multi === true;
    const ids = (Array.isArray(value) ? (value as string[]) : value ? [String(value)] : []).filter(Boolean);
    return (
      <div className="flex flex-col gap-1.5 rounded-lg border border-neutral-300 bg-white p-2.5">
        {members.length === 0 && <span className="text-[12px] text-neutral-400">No one to pick from</span>}
        {members.map((m) => (
          <label key={m.id} className="flex items-center gap-1.5 text-[13px] text-neutral-900">
            <input
              type={multi ? 'checkbox' : 'radio'}
              name={field.field_id}
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
  if (t === 'relation') {
    return <RelationInput token={token} field={field} value={value} onChange={onChange} />;
  }
  if (t === 'rich_text') {
    return (
      <textarea
        className={`${base} min-h-24`}
        value={(value as string) ?? ''}
        onChange={(e) => onChange(e.target.value)}
        required={field.required}
      />
    );
  }
  const inputType = t === 'number' ? 'number' : t === 'date' ? 'date' : t === 'email' ? 'email' : t === 'url' ? 'url' : 'text';
  return (
    <input
      type={inputType}
      className={base}
      value={(value as string) ?? ''}
      onChange={(e) => onChange(t === 'number' ? (e.target.value === '' ? undefined : Number(e.target.value)) : e.target.value)}
      required={field.required}
    />
  );
}

/**
 * Public relation input (#224): search the target database and pick a record,
 * or create a new one inline. Both calls go through the token-scoped public
 * endpoints (GET/POST /public/forms/:token/relations/:fieldId) — a guest can
 * only reach the specific target database this form field already exposes.
 */
function RelationInput({
  token,
  field,
  value,
  onChange,
}: {
  token: string;
  field: FormField;
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  const relation = field.relation;
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState(false);
  const [results, setResults] = useState<Array<{ id: string; title: string }>>([]);
  const [titles, setTitles] = useState<Record<string, string>>({});
  const [creating, setCreating] = useState(false);
  const selectedIds = (Array.isArray(value) ? (value as string[]) : value ? [String(value)] : []).filter(Boolean);

  useEffect(() => {
    if (!open) return;
    const timer = setTimeout(() => {
      const q = search.trim() ? `?q=${encodeURIComponent(search.trim())}` : '';
      fetch(`${API}/api/v1/public/forms/${token}/relations/${field.field_id}${q}`, { credentials: 'omit' })
        .then((r) => (r.ok ? r.json() : []))
        .then((rows: Array<{ id: string; title: string }>) => setResults(rows))
        .catch(() => setResults([]));
    }, 250);
    return () => clearTimeout(timer);
  }, [open, search, token, field.field_id]);

  if (!relation) return <span className="text-[12px] text-neutral-400">This field isn&rsquo;t available</span>;

  function pick(id: string, title: string) {
    setTitles((m) => ({ ...m, [id]: title }));
    if (relation!.single) {
      onChange([id]);
      setOpen(false);
      setSearch('');
      return;
    }
    onChange(selectedIds.includes(id) ? selectedIds.filter((i) => i !== id) : [...selectedIds, id]);
  }

  async function createNew() {
    const title = search.trim();
    if (!title || creating) return;
    setCreating(true);
    try {
      const res = await fetch(`${API}/api/v1/public/forms/${token}/relations/${field.field_id}`, {
        method: 'POST',
        credentials: 'omit',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title }),
      });
      if (!res.ok) return;
      const created = (await res.json()) as { id: string; title: string };
      pick(created.id, created.title);
      setSearch('');
    } finally {
      setCreating(false);
    }
  }

  const exactMatch = results.some((r) => r.title.toLowerCase() === search.trim().toLowerCase());

  return (
    <div className="relative">
      <div className="flex flex-wrap items-center gap-1.5 rounded-lg border border-neutral-300 bg-white px-2.5 py-1.5">
        {selectedIds.map((id) => (
          <span key={id} className="flex items-center gap-1 rounded border border-neutral-200 bg-neutral-50 px-1.5 py-0.5 text-[12px] text-neutral-900">
            {titles[id] ?? id}
            <button
              type="button"
              className="text-neutral-400 hover:text-red-600"
              onClick={() => onChange(selectedIds.filter((i) => i !== id))}
              aria-label="Remove"
            >
              ×
            </button>
          </span>
        ))}
        <input
          className="h-6 min-w-24 flex-1 border-0 bg-transparent text-sm text-neutral-900 outline-none placeholder:text-neutral-400"
          placeholder={`Search ${relation.target_database_name ?? 'records'}…`}
          value={search}
          onFocus={() => setOpen(true)}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>
      {open && (
        <div
          className="absolute left-0 top-full z-20 mt-1 max-h-56 w-full overflow-y-auto rounded-lg border border-neutral-200 bg-white p-1 shadow-[0_4px_12px_rgba(15,23,41,0.1)]"
          onMouseLeave={() => setOpen(false)}
        >
          {results.map((r) => (
            <button
              key={r.id}
              type="button"
              className="flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-[13px] text-neutral-900 hover:bg-neutral-50"
              onClick={() => pick(r.id, r.title)}
            >
              <span className="truncate">{r.title || 'Untitled'}</span>
              {selectedIds.includes(r.id) && <span className="text-[11px] text-neutral-400">selected</span>}
            </button>
          ))}
          {search.trim() && !exactMatch && (
            <button
              type="button"
              disabled={creating}
              className="flex w-full items-center gap-1.5 rounded px-2 py-1.5 text-left text-[13px] text-neutral-700 hover:bg-neutral-50 disabled:opacity-50"
              onClick={createNew}
            >
              + Create “{search.trim()}”
            </button>
          )}
          {!search.trim() && results.length === 0 && (
            <p className="px-2 py-1.5 text-[12px] text-neutral-400">Type to search…</p>
          )}
        </div>
      )}
    </div>
  );
}
