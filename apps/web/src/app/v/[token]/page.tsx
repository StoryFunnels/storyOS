'use client';

import { use, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';

// #526's fallback, applied here from the start (see the same fix + comment on
// apps/web/src/app/f/[token]/page.tsx, the public form page this mirrors).
const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

interface PublicViewField {
  api_name: string;
  type: string;
}
interface PublicRecord {
  id: string;
  title: string;
  number: number;
  values: Record<string, unknown>;
}
interface PublicViewDef {
  view: { id: string; name: string; type: string };
  database: { name: string };
  fields: PublicViewField[];
  indexable: boolean;
  records: { data: PublicRecord[]; next_cursor: string | null; has_more: boolean };
}

/**
 * Public, unauthenticated view (#264/#527). Mirrors /f/[token]/page.tsx's
 * shell (loading/not-found states, ?embed=1) — the same "one status state
 * machine, no app chrome" shape, just reading instead of writing.
 *
 * TABLE ONLY: the public endpoint (public-views.service.ts) returns flat
 * records for every view type, but never a board's group-by field or a
 * dashboard's tile/widget config — those need backend work (#555) this page
 * doesn't attempt to guess around. The share dialog (share-view-dialog.tsx)
 * only offers "Share…" for a table view for exactly this reason, so a board
 * or dashboard can't reach this page's undefined-behavior path in the first
 * place — but if one somehow does (a stale link from before that restriction,
 * for instance), this still renders its records as a flat table rather than
 * silently rendering nothing or crashing.
 *
 * No "Powered by StoryOS" branding gate here yet (#556) — the public form's
 * hide_branding is computed server-side from the workspace's plan, and
 * PublicViewsService has no billing wiring at all yet, so the footer always
 * shows for now, which is the free-plan's existing behaviour either way.
 *
 * Column headers and select/multi_select/workflow values fall back to the
 * raw api_name / option id: the public payload's `fields` carry only
 * `{api_name, type}` (no display_name, no option labels/colors) — filed as
 * its own follow-up rather than guessed at here.
 */
export default function PublicViewPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const embed = useSearchParams().get('embed') === '1';
  const [def, setDef] = useState<PublicViewDef | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'notfound'>('loading');
  const [loadingMore, setLoadingMore] = useState(false);

  useEffect(() => {
    fetch(`${API}/api/v1/public/views/${token}`, { credentials: 'omit' })
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then((d: PublicViewDef) => {
        setDef(d);
        setStatus('ready');
      })
      .catch(() => setStatus('notfound'));
  }, [token]);

  async function loadMore() {
    if (!def?.records.next_cursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const res = await fetch(
        `${API}/api/v1/public/views/${token}?cursor=${encodeURIComponent(def.records.next_cursor)}`,
        { credentials: 'omit' },
      );
      if (!res.ok) return;
      const page = (await res.json()) as PublicViewDef;
      setDef((prev) =>
        prev
          ? {
              ...prev,
              records: {
                data: [...prev.records.data, ...page.records.data],
                next_cursor: page.records.next_cursor,
                has_more: page.records.has_more,
              },
            }
          : prev,
      );
    } finally {
      setLoadingMore(false);
    }
  }

  const wrap = embed ? 'p-4' : 'min-h-screen bg-[#FAF7F1] px-4 py-12';

  if (status === 'loading') {
    return <div className={wrap}><p className="mx-auto max-w-4xl text-sm text-neutral-500">Loading…</p></div>;
  }
  if (status === 'notfound') {
    return (
      <div className={wrap}>
        <div className="mx-auto max-w-xl rounded-xl border border-neutral-200 bg-white p-8 text-center">
          <h1 className="text-lg font-semibold text-neutral-900">View not found</h1>
          <p className="mt-2 text-sm text-neutral-500">This link doesn&rsquo;t exist or is no longer public.</p>
        </div>
      </div>
    );
  }

  return (
    <div className={wrap}>
      <div className="mx-auto flex max-w-4xl flex-col gap-4 rounded-xl border border-neutral-200 bg-white p-6">
        <div>
          <h1 className="text-lg font-semibold text-neutral-900">{def!.view.name}</h1>
          <p className="text-[12px] text-neutral-400">{def!.database.name}</p>
        </div>
        <div className="overflow-x-auto rounded-lg border border-neutral-200">
          <table className="w-full min-w-max border-collapse text-[13px]">
            <thead>
              <tr className="border-b border-neutral-200 bg-neutral-50 text-left text-neutral-500">
                <th className="whitespace-nowrap px-3 py-2 font-medium">Name</th>
                {def!.fields.map((f) => (
                  <th key={f.api_name} className="whitespace-nowrap px-3 py-2 font-medium">
                    {humanize(f.api_name)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {def!.records.data.map((r) => (
                <tr key={r.id} className="border-b border-neutral-100 last:border-b-0">
                  <td className="whitespace-nowrap px-3 py-2 text-neutral-900">{r.title || 'Untitled'}</td>
                  {def!.fields.map((f) => (
                    <td key={f.api_name} className="whitespace-nowrap px-3 py-2 text-neutral-700">
                      {formatValue(r.values[f.api_name])}
                    </td>
                  ))}
                </tr>
              ))}
              {def!.records.data.length === 0 && (
                <tr>
                  <td colSpan={def!.fields.length + 1} className="px-3 py-6 text-center text-neutral-400">
                    Nothing here yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {def!.records.has_more && (
          <button
            type="button"
            onClick={loadMore}
            disabled={loadingMore}
            className="self-center rounded-lg border border-neutral-300 px-4 py-1.5 text-[13px] text-neutral-700 hover:bg-neutral-50 disabled:opacity-50"
          >
            {loadingMore ? 'Loading…' : 'Load more'}
          </button>
        )}
        <p className="text-center text-[11px] text-neutral-400">Powered by StoryOS</p>
      </div>
    </div>
  );
}

/** Best-effort header label from a bare api_name until #557 adds a real one. */
function humanize(apiName: string): string {
  return apiName.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Best-effort cell rendering with no field metadata beyond `type` — no
 *  option labels/colors, no relation chip data. See #557. */
function formatValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'boolean') return value ? '✓' : '—';
  if (Array.isArray(value)) {
    return value
      .map((v) => (typeof v === 'object' && v !== null ? ((v as { title?: string }).title ?? JSON.stringify(v)) : String(v)))
      .join(', ');
  }
  if (typeof value === 'object') return (value as { title?: string }).title ?? JSON.stringify(value);
  return String(value);
}
