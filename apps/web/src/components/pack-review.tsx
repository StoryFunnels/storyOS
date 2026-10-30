'use client';

import type { CSSProperties } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Check } from 'lucide-react';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { databaseNoun } from '@/lib/records';
import { OPTION_COLORS } from '@/components/table-view/option-colors';
import { packHueName } from './pack-workflow-display';
import {
  REUSE_COPY,
  mapRows,
  reviewLead,
  type ExistingChoice,
  type MapRow,
  type PackRelation,
  type ReviewSource,
} from '@/lib/pack-review';

/**
 * #1149 — what a pack leads with: the one sentence ("why"), then "Once it's in, you can" with its lines. Draws NOTHING when the
 * pack has neither (a community pack, or any pack without copy): no heading, no placeholder, no gap — the parent's `gap` is
 * the only spacing, and an absent child adds none.
 */
export function PackWhy({ source }: { source: ReviewSource }) {
  const lead = reviewLead(source);
  if (!lead.show) return null;
  return (
    <div className="flex flex-col gap-2" data-testid="pack-why">
      {lead.why && <p className="text-prose leading-[1.45] text-ink">{lead.why}</p>}
      {lead.can.length > 0 && (
        <>
          <span className="text-label font-semibold text-muted">Once it’s in, you can</span>
          <ul className="flex flex-col gap-[5px]">
            {lead.can.map((line) => (
              <li key={line} className="flex items-start gap-2 text-body text-ink-secondary">
                <Check className="mt-[3px] h-3 w-3 shrink-0 text-success" aria-hidden />
                {line}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

const node =
  'inline-flex h-5 min-w-0 items-center overflow-hidden text-ellipsis whitespace-nowrap rounded-[var(--radius-chip,4px)] border border-border-default bg-card px-[7px] text-meta font-semibold text-ink';

function Row({ row }: { row: MapRow }) {
  if (row.kind === 'link')
    return (
      <div className="flex min-w-0 flex-nowrap items-center gap-1">
        <span className={node} title={row.from}>{row.from}</span>
        <span className="text-meta text-muted" aria-label={row.op === '↔' ? 'links both ways to' : 'links to'}>{row.op}</span>
        <span className={node} title={row.to}>{row.to}</span>
      </div>
    );
  if (row.kind === 'self')
    return (
      <div className="flex min-w-0 flex-nowrap items-center gap-1">
        <span className={node} title={row.name}>{row.name}</span>
        <span className="text-meta text-muted" aria-label="links to itself">↺</span>
        <span className="text-meta italic text-muted">{row.via}</span>
      </div>
    );
  if (row.kind === 'solo')
    return (
      <div className="flex min-w-0 items-center">
        <span className={node} title={row.name}>{row.name}</span>
      </div>
    );
  return <span className="text-meta text-muted">{row.text}</span>;
}

/**
 * #1149 — the database map: one link per row ("Tasks → Projects"), drawn from the listing's `relations`, never hard-coded. The
 * prototype's rows rather than DatabaseRelationsDiagram: that is a hub-and-spoke of ONE live database over live OntologyRelations
 * (it needs a center, ids and a click-through), where a pack has none of those before it is installed. Draws nothing when there
 * is nothing to say; `heading` adds "How it fits together" only then, so an empty map leaves no orphan label.
 */
export function PackMap({
  slug,
  relations,
  databaseCount,
  soleDatabase,
  limit,
  heading,
}: {
  slug: string;
  relations: PackRelation[] | null | undefined;
  databaseCount: number;
  soleDatabase?: string | null;
  limit?: number;
  heading?: boolean;
}) {
  const rows = mapRows(relations, databaseCount, { soleDatabase, limit });
  if (rows.length === 0) return null;
  const hue = OPTION_COLORS[packHueName(slug)]!;
  return (
    <div data-testid="pack-map" className={cn(heading && 'flex flex-col gap-1.5')}>
      {heading && <span className="text-label font-semibold text-muted">How it fits together</span>}
      <div
        className="flex flex-col gap-1 rounded-[var(--radius-control)] border p-2"
        style={
          {
            borderColor: 'color-mix(in srgb, var(--pack-hue) 18%, var(--border-default))',
            background: 'color-mix(in srgb, var(--pack-hue) 7%, var(--bg-card))',
            '--pack-hue': hue,
          } as CSSProperties
        }
      >
        {rows.map((row, i) => (
          <Row key={i} row={row} />
        ))}
      </div>
    </div>
  );
}

/**
 * #1149 / #1156 — the choice for ONE database that already exists in ANOTHER space: two radio cards, "Create a new X here"
 * (the default) and "Use your existing X (in <space>)". When the server says it cannot be used, the second card is shown but
 * disabled with the server's own `reason`, verbatim — shown rather than hidden so the person learns why their data isn't offered.
 */
export function ReuseChoice({
  ws,
  choice,
  newSpace,
  selected,
  adds,
  onSelect,
}: {
  ws: string;
  choice: ExistingChoice;
  /** The space the new database would land in — "Empty, in <this>". */
  newSpace: string;
  /** True when "use existing" is the current pick; the default is false (create new). */
  selected: boolean;
  /** Fields the install would add to the existing database (from the what-if preview); undefined while unknown. */
  adds: string[] | undefined;
  onSelect: (useExisting: boolean) => void;
}) {
  const { name, hint } = choice;
  const usable = hint.reusable;
  const its = hint.space_name ?? 'that space';
  // A live number on this open of the review, never cached (Dara): zero staleness, and dropped when the row goes away.
  const count = useQuery({
    queryKey: ['pack-reuse-count', ws, hint.database_id],
    enabled: usable && Boolean(hint.database_id),
    staleTime: 0,
    gcTime: 0,
    retry: false,
    queryFn: async () => {
      const { data, error } = await api.POST('/api/v1/workspaces/{ws}/databases/{db}/records/aggregate', {
        params: { path: { ws, db: hint.database_id! } },
        body: { op: 'count' } as never,
      });
      if (error) throw error;
      return (data as unknown as { value: number | null }).value ?? 0;
    },
  });
  const useSelected = usable && selected;
  const group = `reuse-${name}`;
  const card = (on: boolean, disabled: boolean) =>
    cn(
      'flex items-start gap-2 rounded-[var(--radius-control)] border px-2.5 py-2',
      on ? 'border-primary shadow-[inset_0_0_0_1px_var(--primary)]' : 'border-border-default',
      disabled ? 'cursor-default opacity-75' : 'cursor-pointer',
    );
  return (
    <span className="mt-1 flex flex-col gap-1.5" data-testid="pack-reuse-choice" data-database={name}>
      <em className="text-label not-italic text-ink-secondary">{REUSE_COPY.heading(name)}</em>
      <span role="radiogroup" aria-label={`${name}: create a new one or use your existing one`} className="flex flex-col gap-1.5">
        <label className={card(!useSelected, false)}>
          <input
            type="radio"
            name={group}
            className="mt-[3px] shrink-0"
            checked={!useSelected}
            onChange={() => onSelect(false)}
          />
          <span className="flex min-w-0 flex-col">
            <b className="text-body font-semibold text-ink">{REUSE_COPY.createTitle(name)}</b>
            <small className="text-label leading-[1.45] text-muted">{REUSE_COPY.createSub(newSpace)}</small>
          </span>
        </label>
        <label className={card(useSelected, !usable)}>
          <input
            type="radio"
            name={group}
            className="mt-[3px] shrink-0"
            checked={useSelected}
            disabled={!usable}
            onChange={() => onSelect(true)}
          />
          <span className="flex min-w-0 flex-col">
            <b className="text-body font-semibold text-ink">{REUSE_COPY.useTitle(name, hint.space_name)}</b>
            <small className={cn('text-label leading-[1.45]', usable ? 'text-muted' : 'text-ink-secondary')}>
              {usable
                ? REUSE_COPY.existingSub({
                    noun: databaseNoun(name),
                    count: count.data ?? null,
                    space: newSpace,
                    its,
                    adds: adds ?? null,
                  })
                : (hint.reason ?? 'This one can’t be used.')}
            </small>
          </span>
        </label>
      </span>
    </span>
  );
}
