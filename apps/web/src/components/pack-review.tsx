'use client';

import type { CSSProperties } from 'react';
import { Check } from 'lucide-react';
import { cn } from '@/lib/utils';
import { OPTION_COLORS } from '@/components/table-view/option-colors';
import { packHueName } from './pack-workflow-display';
import {
  mapRows,
  reviewLead,
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

