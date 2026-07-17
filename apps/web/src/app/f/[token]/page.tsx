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
}
interface FormDef {
  title: string;
  description: string | null;
  submit_text: string;
  success_message: string | null;
  redirect_url: string | null;
  fields: FormField[];
}

/**
 * Public, unauthenticated form (MN-101). Rendered with no app chrome so it can be
 * shared by link or embedded via `?embed=1`. Submits to the public endpoint,
 * which creates a record anonymously.
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
            <Input field={f} value={values[f.api_name]} onChange={(v) => setValues((p) => ({ ...p, [f.api_name]: v }))} />
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
        {!embed && <p className="text-center text-[11px] text-neutral-400">Powered by StoryOS</p>}
      </form>
    </div>
  );
}

function Input({
  field,
  value,
  onChange,
}: {
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
