'use client';

import { useState } from 'react';
import { OPTION_COLORS, OptionChip } from '@/components/table-view/cells';
import type { SelectOption } from '@/components/table-view/use-table-data';

export interface PublicViewField {
  api_name: string;
  type: string;
  /** #610 — real display label, same shape `forms.service.ts` already sends
   * the public form page; no more humanized api_name fallback. */
  label: string;
  /** #610 — select/multi_select/workflow only, same {id,label,color} shape
   * the public form page's option control already reads. */
  options?: SelectOption[];
}
export interface PublicRecord {
  id: string;
  title: string;
  number: number;
  values: Record<string, unknown>;
}
/** #555/#709 — present only when `view.type === 'board'`, and even then
 * `group_by_field_api_name` is nullable: `public-views.service.ts` drops the
 * reference (rather than 404ing the page) if the owner hides the grouping
 * field after sharing — #305's rule, "unconfigured is not invalid". */
interface PublicViewBoard {
  group_by_field_api_name: string | null;
  group_by_granularity: string | null;
  column_sort: string | null;
  hide_empty_groups: boolean;
  hide_empty_no_value_group: boolean;
}
/** #555/#709 — one tile as the public payload computes it server-side
 * (`RecordsService.aggregate`, never raw records shipped to reduce
 * client-side). `value` is `number | null` — an aggregate over zero rows is
 * null, which is a different answer from a real zero and must render as one
 * (see `DashboardTiles`' own comment). A tile that was cross-database or
 * referenced a non-allowlisted field is already dropped server-side and
 * never reaches this array at all. */
interface PublicViewDashboardTile {
  id: string;
  label: string;
  op: string;
  field_api_name: string | null;
  value: number | null;
  layout: unknown;
  comparison: string | null;
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
  /** #709 — only present when `view.type === 'board'`. */
  board?: PublicViewBoard;
  /** #709 — only present when `view.type === 'dashboard'`. Widgets (charts,
   * grouped tables) are a separate, not-yet-public Phase 2 and never appear
   * here — see `DashboardTiles`'s own note on the silent-drop scope this
   * ticket does NOT cover (D4's "owner is warned at publish time" half). */
  dashboard?: { tiles: PublicViewDashboardTile[] };
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
            <p className="text-label text-neutral-400">{def.database.name}</p>
          </div>
        </div>
        {/* #709 — board/dashboard render their own read-only shape; every
            other view type (table today, the only one #527 ever built)
            keeps the flat-rows rendering unchanged. */}
        {def.view.type === 'board' && def.board ? (
          <BoardColumns def={def} />
        ) : def.view.type === 'dashboard' && def.dashboard ? (
          <DashboardTiles tiles={def.dashboard.tiles} />
        ) : (
          <div className="overflow-x-auto rounded-lg border border-neutral-200">
            <table className="w-full min-w-max border-collapse text-body">
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
        )}
        {/* #709 — "Load more" is AC3's one kept interaction across all three
            view types (per Dara's spec table: "already shipped and already
            correct"), so it stays outside the per-type branch above. */}
        {def.records.has_more && (
          <button
            type="button"
            onClick={loadMore}
            disabled={loadingMore}
            style={accent ? { borderColor: accent, color: accent } : undefined}
            className="self-center rounded-lg border border-neutral-300 px-4 py-1.5 text-body text-neutral-700 hover:bg-neutral-50 disabled:opacity-50"
          >
            {loadingMore ? 'Loading…' : 'Load more'}
          </button>
        )}
        {!def.hide_branding && <p className="text-center text-meta text-neutral-400">Powered by StoryOS</p>}
      </div>
    </div>
  );
}

/**
 * #709 (AC1) — a read-only board, grouped columns.
 *
 * Built against Dara's spec (#728), which reads the SHIPPED payload rather
 * than #555's own summary of it — three decisions that shape everything
 * here:
 *
 * B1 — the payload has no per-group total, only `has_more`/`next_cursor` for
 * the WHOLE view (`RecordsService.query`'s ordinary pagination, 50 at a
 * time). A naive port of the authenticated board's `column.length` would
 * therefore show a page-count wearing the costume of a total — understating
 * silently, often by a lot. So: while `has_more` is true, a column with any
 * loaded rows shows "N loaded" (explicitly qualified), never a bare number;
 * a column with zero loaded rows shows no badge at all. Once the last page
 * has landed (`has_more === false`), the loaded count IS the true count, and
 * renders as a plain number.
 *
 * A true PER-GROUP total is possible server-side today — ticket #750/PR
 * #863 shipped a grouped-aggregate endpoint after this spec was written —
 * but wiring it into this payload is an API change to
 * `public-views.service.ts` (Marek's lane, not this ticket's), so it's
 * flagged as a forward note on the ticket rather than built here.
 *
 * B2 — `hide_empty_groups` (owner config) is applied the SAME way: only once
 * `has_more` is false. A column with nothing loaded YET is not the same as
 * an empty column, and hiding it mid-pagination would make a column with
 * real records vanish with no way for the viewer to know.
 *
 * B3 — `group_by_field_api_name` is nullable (the owner can hide the
 * grouping field after sharing; the service drops the reference rather than
 * 404ing the whole page, per #305's "unconfigured is not invalid"). That
 * state renders as ONE unlabelled column of the same cards — not an error,
 * not silently switched to the table, and with no "grouping unavailable"
 * notice: a stranger has no way to act on that information, and the person
 * who could (the owner) isn't the one looking at this page.
 */
function BoardColumns({ def }: { def: PublicViewDef }) {
  const { board, records, fields } = def;
  const groupField = board?.group_by_field_api_name
    ? fields.find((f) => f.api_name === board.group_by_field_api_name)
    : undefined;

  if (!groupField) {
    // B3 — ungrouped: one column, no header, same cards.
    return (
      <div className="flex gap-2 overflow-x-auto pb-1">
        <BoardColumn cards={records.data} />
      </div>
    );
  }

  const byOptionId = new Map<string, PublicRecord[]>();
  const noValue: PublicRecord[] = [];
  for (const record of records.data) {
    const value = record.values[groupField.api_name];
    if (typeof value === 'string' && value) {
      const list = byOptionId.get(value) ?? [];
      list.push(record);
      byOptionId.set(value, list);
    } else {
      noValue.push(record);
    }
  }

  const columns: Array<{ key: string; label: string; color: string | null; cards: PublicRecord[] }> = (
    groupField.options ?? []
  ).map((option) => ({
    key: option.id,
    label: option.label,
    color: option.color,
    cards: byOptionId.get(option.id) ?? [],
  }));
  columns.push({ key: '__no_value__', label: 'No value', color: null, cards: noValue });

  const complete = !records.has_more;
  const visible = columns.filter((col) => {
    if (!complete) return true; // B2 — never hide while pagination is incomplete.
    if (col.key === '__no_value__') return !board!.hide_empty_no_value_group || col.cards.length > 0;
    return !board!.hide_empty_groups || col.cards.length > 0;
  });

  return (
    <div className="flex gap-2 overflow-x-auto pb-1">
      {visible.map((col) => (
        <BoardColumn key={col.key} label={col.label} color={col.color} cards={col.cards} complete={complete} />
      ))}
    </div>
  );
}

function BoardColumn({
  label,
  color,
  cards,
  complete,
}: {
  label?: string;
  color?: string | null;
  cards: PublicRecord[];
  complete?: boolean;
}) {
  // B1 — see BoardColumns' own comment: no bare count while pagination is
  // incomplete, and no badge at all for a column with nothing loaded yet.
  const badge = complete ? (cards.length > 0 ? String(cards.length) : null) : cards.length > 0 ? `${cards.length} loaded` : null;
  return (
    <div className="w-60 shrink-0 rounded-lg border border-neutral-200 bg-neutral-50">
      {label !== undefined && (
        <div className="flex items-center gap-1.5 px-2.5 py-2">
          {color && <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: OPTION_COLORS[color] ?? OPTION_COLORS.gray }} />}
          <h5 className="min-w-0 flex-1 truncate text-body font-semibold text-neutral-800">{label}</h5>
          {badge && (
            <span className="shrink-0 rounded-full border border-neutral-200 bg-white px-1.5 text-meta text-neutral-500">
              {badge}
            </span>
          )}
        </div>
      )}
      <div className="flex flex-col gap-1.5 px-2 pb-2">
        {cards.map((r) => (
          // AC3 — a card is terminal content on a public board: there is no
          // public record page to link to, so this is deliberately NOT an
          // <a>/<Link> and carries no click handler or hover affordance that
          // would suggest one exists.
          <div key={r.id} className="rounded-md border border-neutral-200 bg-white p-2">
            <span className="block font-mono text-meta text-neutral-400">#{r.number}</span>
            <span className="line-clamp-2 text-body font-medium text-neutral-900">{r.title || 'Untitled'}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * #709 (AC2) — a read-only dashboard, tiles only (Phase 1; charts/grouped-
 * table widgets are Phase 2 and never reach the public payload at all — D4).
 *
 * D1/D2 — `value` is `number | null`. An aggregate over zero rows (e.g. an
 * average) is null, and a null is NOT the same answer as a real zero (e.g.
 * "0 open bugs" is a genuine result). Rendering null as 0 would assert a
 * fact the server explicitly declined to state, so null renders as "—" —
 * muted, at reduced size — while a real 0 renders as an ordinary number at
 * full weight, not dimmed or specially treated.
 *
 * D3 — `comparison` is in the payload, but a delta is only a way IN on the
 * authenticated dashboard (you click through to see what moved); publicly
 * there is nowhere to go. So it renders as plain text, with no arrow glyph,
 * no colour-coded up/down treatment, and no hover state — inert, not absent,
 * because stripping it entirely would drop information the payload actually
 * carries.
 *
 * D4 — a tile that was cross-database or referenced a non-allowlisted field
 * is already dropped SERVER-SIDE (`public-views.service.ts`) and never
 * reaches `tiles` here; there is deliberately no placeholder or "N tiles
 * hidden" notice for the viewer (a stranger can't act on it). The spec's
 * OTHER D4 half — warning the OWNER about this at share time — is a
 * separate, not-yet-filed ticket, not part of this component.
 */
function DashboardTiles({ tiles }: { tiles: PublicViewDashboardTile[] }) {
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
      {tiles.map((tile) => (
        // AC3 — no click-through: a tile is a number, not a button, since
        // there is nowhere for a logged-out visitor to navigate to.
        <div key={tile.id} className="rounded-lg border border-neutral-200 bg-neutral-50 p-3">
          <p className="text-label font-medium text-neutral-500">{tile.label}</p>
          {tile.value === null ? (
            <p className="text-lg font-semibold text-neutral-300">—</p>
          ) : (
            <p className="text-xl font-bold tabular-nums text-neutral-900">{tile.value.toLocaleString()}</p>
          )}
          {tile.comparison && <p className="text-meta text-neutral-500">{tile.comparison}</p>}
        </div>
      ))}
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
