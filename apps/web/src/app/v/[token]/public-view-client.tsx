'use client';

import { useState } from 'react';
import { OptionChip } from '@/components/table-view/cells';
import type { SelectOption } from '@/components/table-view/use-table-data';

interface PublicViewField {
  api_name: string;
  type: string;
  /** #610 — real display label, same shape `forms.service.ts` already sends
   * the public form page; no more humanized api_name fallback. */
  label: string;
  /** #610 — select/multi_select/workflow only, same {id,label,color} shape
   * the public form page's option control already reads. */
  options?: SelectOption[];
}
interface PublicRecord {
  id: string;
  title: string;
  number: number;
  values: Record<string, unknown>;
}
export interface PublicViewDef {
  view: { id: string; name: string; type: string };
  database: { name: string };
  fields: PublicViewField[];
  indexable: boolean;
  /** #609 — paid-plan white-label (#556), same computed field the public
   * form page already reads via `FormDef.hide_branding`. */
  hide_branding: boolean;
  /** #539 — the operator's own brand. Not plan-gated (see hide_branding
   *  above, which is the separate, paid-plan-gated "our" branding). Both
   *  null is the default, unbranded look — nothing here changes for a
   *  workspace that never set either. */
  branding: { logo_url: string | null; accent_color: string | null };
  records: { data: PublicRecord[]; next_cursor: string | null; has_more: boolean };
}

// #526's fallback (see the same fix + comment on apps/web/src/app/f/[token]/page.tsx)
// — this one's the BROWSER's copy; the server-rendering half of this page uses
// SERVER_API_URL instead (#566), which is a different base in a same-origin deploy.
const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

/**
 * #566 — the interactive remainder of the public view page: "Load more"
 * pagination and the `?embed=1` chrome toggle. Everything that determines
 * WHETHER this renders at all (token resolution, metadata, 404) now happens
 * one level up, server-side, in `page.tsx` — this component only ever mounts
 * once a valid `initialDef` already exists.
 */
export function PublicViewClient({
  token,
  initialDef,
  embed,
}: {
  token: string;
  initialDef: PublicViewDef;
  embed: boolean;
}) {
  const [def, setDef] = useState<PublicViewDef>(initialDef);
  const [loadingMore, setLoadingMore] = useState(false);

  async function loadMore() {
    if (!def.records.next_cursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const res = await fetch(
        `${API}/api/v1/public/views/${token}?cursor=${encodeURIComponent(def.records.next_cursor)}`,
        { credentials: 'omit' },
      );
      if (!res.ok) return;
      const page = (await res.json()) as PublicViewDef;
      setDef((prev) => ({
        ...prev,
        records: {
          data: [...prev.records.data, ...page.records.data],
          next_cursor: page.records.next_cursor,
          has_more: page.records.has_more,
        },
      }));
    } finally {
      setLoadingMore(false);
    }
  }

  const wrap = embed ? 'p-4' : 'min-h-screen bg-[#FAF7F1] px-4 py-12';
  const accent = def.branding.accent_color;

  return (
    <div className={wrap}>
      <div
        className="mx-auto flex max-w-4xl flex-col gap-4 rounded-xl border border-neutral-200 bg-white p-6"
        // #539 — an operator's own accent colour, applied only via inline
        // `style` (never string-built CSS, never dangerouslySetInnerHTML) —
        // the API already bounds this to a strict 6-digit hex, so the value
        // can only ever become a CSS colour, never markup.
        style={accent ? { borderTopColor: accent, borderTopWidth: 3 } : undefined}
      >
        <div className="flex items-center gap-3">
          {def.branding.logo_url && (
            <img src={def.branding.logo_url} alt="" className="h-7 w-auto shrink-0 object-contain" />
          )}
          <div>
            <h1 className="text-lg font-semibold text-neutral-900">{def.view.name}</h1>
            <p className="text-[12px] text-neutral-400">{def.database.name}</p>
          </div>
        </div>
        <div className="overflow-x-auto rounded-lg border border-neutral-200">
          <table className="w-full min-w-max border-collapse text-[13px]">
            <thead>
              <tr className="border-b border-neutral-200 bg-neutral-50 text-left text-neutral-500">
                <th className="whitespace-nowrap px-3 py-2 font-medium">Name</th>
                {def.fields.map((f) => (
                  <th key={f.api_name} className="whitespace-nowrap px-3 py-2 font-medium">
                    {f.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {def.records.data.map((r) => (
                <tr key={r.id} className="border-b border-neutral-100 last:border-b-0">
                  <td className="whitespace-nowrap px-3 py-2 text-neutral-900">{r.title || 'Untitled'}</td>
                  {def.fields.map((f) => (
                    <td key={f.api_name} className="whitespace-nowrap px-3 py-2 text-neutral-700">
                      <Cell field={f} value={r.values[f.api_name]} />
                    </td>
                  ))}
                </tr>
              ))}
              {def.records.data.length === 0 && (
                <tr>
                  <td colSpan={def.fields.length + 1} className="px-3 py-6 text-center text-neutral-400">
                    Nothing here yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {def.records.has_more && (
          <button
            type="button"
            onClick={loadMore}
            disabled={loadingMore}
            style={accent ? { borderColor: accent, color: accent } : undefined}
            className="self-center rounded-lg border border-neutral-300 px-4 py-1.5 text-[13px] text-neutral-700 hover:bg-neutral-50 disabled:opacity-50"
          >
            {loadingMore ? 'Loading…' : 'Load more'}
          </button>
        )}
        {!def.hide_branding && <p className="text-center text-[11px] text-neutral-400">Powered by StoryOS</p>}
      </div>
    </div>
  );
}

/**
 * #610 — select/multi_select/workflow render through the SAME shared
 * `OptionChip` the authenticated table and the public form page use, rather
 * than a second chip renderer. Every other type keeps the prior best-effort
 * string formatting — no field metadata beyond `type` for those (see #557's
 * still-open scope: relation chip data isn't part of this ticket).
 */
function Cell({ field, value }: { field: PublicViewField; value: unknown }) {
  if (field.type === 'select' || field.type === 'workflow') {
    const option = field.options?.find((o) => o.id === value);
    return option ? <OptionChip option={option} /> : <>—</>;
  }
  if (field.type === 'multi_select') {
    const ids = Array.isArray(value) ? (value as string[]) : [];
    const options = ids
      .map((id) => field.options?.find((o) => o.id === id))
      .filter((o): o is SelectOption => Boolean(o));
    if (options.length === 0) return <>—</>;
    return (
      <span className="flex gap-1 overflow-hidden">
        {options.map((o) => (
          <OptionChip key={o.id} option={o} />
        ))}
      </span>
    );
  }
  return <>{formatValue(value)}</>;
}

/** Best-effort cell rendering with no field metadata beyond `type` — no
 *  relation chip data. See #557's still-open scope. */
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
