'use client';

import { useMemo } from 'react';
import { Database as DatabaseIcon } from 'lucide-react';
import { EntityIcon } from '@/components/ui/icon-picker';
import { pluralNoun } from '@/lib/records';
import { OPTION_COLORS } from '@/components/table-view/option-colors';
import type { OntologyRelation } from '@/components/space-ontology';

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

const CENTER_R = 20;
const NODE_R = 16;

interface CenterDatabase {
  id: string;
  name: string;
  icon: string | null;
  color: string | null;
}

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
      <p className="rounded-[var(--radius-card)] border border-border-default bg-card p-6 text-[13px] text-muted">
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
          s.edges.map((e, i) => (
            <g key={`${s.database.id}:${e.relationId}`}>
              <line
                x1={layout.cx}
                y1={layout.cy}
                x2={s.x}
                y2={s.y}
                stroke="var(--border-strong)"
                strokeWidth={1.5}
                className="cursor-pointer hover:stroke-[var(--accent)]"
                onClick={() => onOpenDatabase(s.database.id)}
              >
                <title>{e.label}</title>
              </line>
              <text
                x={(layout.cx + s.x) / 2}
                y={(layout.cy + s.y) / 2 - i * 11}
                textAnchor="middle"
                className="pointer-events-none fill-[var(--muted)] text-[9px]"
              >
                {e.shortLabel}
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
              fill="var(--card)"
              stroke={(s.database.color && OPTION_COLORS[s.database.color]) || 'var(--border-strong)'}
              strokeWidth={2}
            >
              <title>{s.database.name}</title>
            </circle>
            <foreignObject x={s.x - NODE_R} y={s.y - NODE_R} width={NODE_R * 2} height={NODE_R * 2}>
              <div className="flex h-full w-full items-center justify-center">
                <EntityIcon icon={s.database.icon} color={s.database.color} fallback={<DatabaseIcon className="h-3.5 w-3.5" />} />
              </div>
            </foreignObject>
            <text x={s.x} y={s.y + NODE_R + 13} textAnchor="middle" className="fill-[var(--ink)] text-[11px] font-medium">
              {s.database.name}
            </text>
          </g>
        ))}

        {/* The center — this database. Not clickable: you're already here. */}
        <g>
          <circle
            cx={layout.cx}
            cy={layout.cy}
            r={CENTER_R}
            fill="var(--card)"
            stroke={(center.color && OPTION_COLORS[center.color]) || 'var(--accent)'}
            strokeWidth={2.5}
          />
          <foreignObject x={layout.cx - CENTER_R} y={layout.cy - CENTER_R} width={CENTER_R * 2} height={CENTER_R * 2}>
            <div className="flex h-full w-full items-center justify-center">
              <EntityIcon icon={center.icon} color={center.color} fallback={<DatabaseIcon className="h-4 w-4" />} />
            </div>
          </foreignObject>
          <text x={layout.cx} y={layout.cy + CENTER_R + 14} textAnchor="middle" className="fill-[var(--ink)] text-[12px] font-semibold">
            {center.name}
          </text>
        </g>
      </svg>
    </div>
  );
}

interface Spoke {
  database: { id: string; name: string; icon: string | null; color: string | null };
  x: number;
  y: number;
  edges: Array<{ relationId: string; label: string; shortLabel: string }>;
}

/** Self-relations (both sides point at the CENTER database) have no far node
 *  to draw a spoke to — listed as a caption-only edge is out of this ticket's
 *  scope (#449's loop treatment is the precedent if this ever needs one), so
 *  they're simply not drawn here rather than guessed at. */
function computeSpokeLayout(center: CenterDatabase, relations: OntologyRelation[]) {
  const byFarDb = new Map<string, Spoke['database']>();
  const edgesByFarDb = new Map<string, Spoke['edges']>();

  for (const r of relations) {
    if (r.self_relation) continue;
    const far = r.a.database_id === center.id ? r.b : r.a;
    const local = r.a.database_id === center.id ? r.a : r.b;
    if (!far.database_id || far.database_id === center.id) continue;
    if (!byFarDb.has(far.database_id)) {
      byFarDb.set(far.database_id, { id: far.database_id, name: far.database_name ?? 'Untitled', icon: null, color: null });
    }
    const list = edgesByFarDb.get(far.database_id) ?? [];
    const cardinality = r.cardinality.replace(/_/g, '-');
    list.push({
      relationId: r.id,
      label: `${local.field_name ?? '?'} → ${far.database_name ?? '?'}.${far.field_name ?? '?'} (${cardinality})`,
      shortLabel: `${local.field_name ?? '?'} / ${far.field_name ?? '?'}`,
    });
    edgesByFarDb.set(far.database_id, list);
  }

  const fars = [...byFarDb.values()];
  const n = fars.length;
  const radius = Math.max(90, n * 22);
  const cx = radius + 60;
  const cy = radius + 40;

  const spokes: Spoke[] = fars.map((database, i) => {
    const angle = (2 * Math.PI * i) / n - Math.PI / 2;
    return {
      database,
      x: cx + radius * Math.cos(angle),
      y: cy + radius * Math.sin(angle),
      edges: edgesByFarDb.get(database.id) ?? [],
    };
  });

  // Bounding box measured from real content (node radius + label height),
  // not a guessed margin — same discipline space-ontology.tsx documents.
  const pad = NODE_R + 30;
  const minX = Math.min(cx - CENTER_R, ...spokes.map((s) => s.x - pad));
  const maxX = Math.max(cx + CENTER_R, ...spokes.map((s) => s.x + pad));
  const minY = Math.min(cy - CENTER_R - 20, ...spokes.map((s) => s.y - pad));
  const maxY = Math.max(cy + CENTER_R + 20, ...spokes.map((s) => s.y + pad));

  return {
    cx: cx - minX,
    cy: cy - minY,
    width: maxX - minX,
    height: maxY - minY,
    spokes: spokes.map((s) => ({ ...s, x: s.x - minX, y: s.y - minY })),
  };
}
