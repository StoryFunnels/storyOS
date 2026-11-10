'use client';

import { useMemo } from 'react';
import { Database as DatabaseIcon } from 'lucide-react';
import { EntityIcon } from '@/components/ui/icon-picker';
import { pluralNoun } from '@/lib/records';
import { OPTION_COLORS } from '@/components/table-view/option-colors';
import type { OntologyRelation } from '@/components/space-ontology';
import { databaseColor } from '@/lib/entity-color';
import { CENTER_R, NODE_R, computeSpokeLayout } from './database-relations-layout';

/**
 * #531 — a single database's own relations, hub-and-spoke: this database at
 * the center, each database it's related to as a node on a fixed ring around
 * it, one line per relation (several relations to the same far database share
 * one node, one line each). NOT a parameterization of space-ontology.tsx's
 * `computeLayout` — that function distributes every database evenly around
 * one ring with no privileged node, which is structurally the wrong shape for
 * "one center + N related." This is the same SVG vocabulary (node circle +
 * EntityIcon in a foreignObject, edge line + text label, bounding box sized to
 * content) applied to the simpler geometry a real center affords: fixed
 * angles, no overlap-avoidance measurement needed at this node count.
 */

import type { CenterDatabase } from './database-relations-layout';

export function DatabaseRelationsDiagram({
  center,
  relations,
  onOpenDatabase,
}: {
  center: CenterDatabase;
  relations: OntologyRelation[];
  onOpenDatabase: (databaseId: string) => void;
}) {
  const layout = useMemo(() => computeSpokeLayout(center, relations), [center, relations]);

  if (relations.length === 0) {
    return (
      <p className="rounded-[var(--radius-card)] border border-border-default bg-card p-6 text-body text-muted">
        {center.name} has no relations to any other database yet.
      </p>
    );
  }

  return (
    <div className="overflow-x-auto rounded-[var(--radius-card)] border border-border-default bg-card p-4">
      <svg
        viewBox={`0 0 ${layout.width} ${layout.height}`}
        width={layout.width}
        height={layout.height}
        className="mx-auto"
        role="img"
        aria-label={`Relations for ${center.name}: ${layout.spokes.length} related ${pluralNoun('database', layout.spokes.length)}`}
      >
        {/* Edges first, so node circles paint over the line ends. */}
        {layout.spokes.flatMap((s) =>
          s.edges.map((e) => (
            <g key={`${s.database.id}:${e.relationId}`}>
              <line
                x1={layout.cx}
                y1={layout.cy}
                x2={s.x}
                y2={s.y}
                stroke="var(--border-strong)"
                strokeWidth={1.5}
                className="cursor-pointer hover:stroke-[var(--primary-text)]"
                onClick={() => onOpenDatabase(s.database.id)}
              >
                <title>{e.label}</title>
              </line>
            </g>
          )),
        )}

        {/* Edge labels after ALL lines, so no later spoke paints over one. */}
        {layout.spokes.flatMap((s) =>
          s.edges.map((e) => (
            <g key={`label:${s.database.id}:${e.relationId}`}>
            {/* #1259 — placed by computeSpokeLayout so no two labels collide; the
                  halo (stroke in the card colour, painted first) keeps a label
                  readable where it crosses another spoke. Colours are theme
                  utilities (fill-muted -> --text-muted): the old `var(--muted)`
                  named a variable that does not exist, so the fill was invalid
                  and fell back to black, unreadable on the dark card. */}
              <text
                x={e.lx}
                y={e.ly}
                dominantBaseline="central"
                textAnchor="middle"
                strokeWidth={3}
                strokeLinejoin="round"
                style={{ paintOrder: 'stroke' }}
                className="pointer-events-none fill-muted stroke-card text-meta"
              >
                {e.text}
              </text>
            </g>
          )),
        )}

        {/* Related-database nodes. */}
        {layout.spokes.map((s) => (
          <g key={s.database.id} className="cursor-pointer" onClick={() => onOpenDatabase(s.database.id)}>
            <circle
              cx={s.x}
              cy={s.y}
              r={NODE_R}
              className="fill-card"
              stroke={(s.database.color && OPTION_COLORS[s.database.color]) || 'var(--border-strong)'}
              strokeWidth={2}
            >
              <title>{s.database.name}</title>
            </circle>
            <foreignObject x={s.x - NODE_R} y={s.y - NODE_R} width={NODE_R * 2} height={NODE_R * 2}>
              <div className="flex h-full w-full items-center justify-center">
                <EntityIcon icon={s.database.icon} color={databaseColor(s.database.color, s.database.id)} fallback={<DatabaseIcon className="h-3.5 w-3.5" />} />
              </div>
            </foreignObject>
            <text x={s.x} y={s.y + NODE_R + 13} textAnchor="middle" className="fill-ink text-meta font-medium">
              {s.nameText}
            </text>
          </g>
        ))}

        {/* The center — this database. Not clickable: you're already here. */}
        <g>
          <circle
            cx={layout.cx}
            cy={layout.cy}
            r={CENTER_R}
            className="fill-card"
            stroke={(center.color && OPTION_COLORS[center.color]) || 'var(--border-strong)'}
            strokeWidth={2.5}
          />
          <foreignObject x={layout.cx - CENTER_R} y={layout.cy - CENTER_R} width={CENTER_R * 2} height={CENTER_R * 2}>
            <div className="flex h-full w-full items-center justify-center">
              <EntityIcon icon={center.icon} color={databaseColor(center.color, center.id)} fallback={<DatabaseIcon className="h-4 w-4" />} />
            </div>
          </foreignObject>
          <text x={layout.cx} y={layout.cy + CENTER_R + 14} textAnchor="middle" className="fill-ink text-label font-semibold">
            {layout.centreName}
          </text>
        </g>
      </svg>
    </div>
  );
}
