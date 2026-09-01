'use client';

import { useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { Database as DatabaseIcon } from 'lucide-react';
import { EntityIcon } from '@/components/ui/icon-picker';
import { databaseNoun, pluralNoun } from '@/lib/records';
import { OPTION_COLORS } from '@/components/table-view/option-colors';
import type { DatabaseSummary } from '@/lib/queries';

/**
 * #449 — the ontology diagram: the databases in ONE space as nodes, the
 * relations between them as edges.
 *
 * LAYOUT — no library, and that is a stated decision, not an oversight. Nothing
 * in package.json does graph layout (checked before writing this), and adding
 * one — react-flow, d3-force, dagre — is a dependency call bigger than this
 * ticket, made for a single page. The ticket's own escape hatch is explicit:
 * "an automatic layout with no manual node positioning... if it cannot [stay
 * readable], the honest v1 is a clear matrix or grouped list rather than a
 * diagram nobody can read." A CIRCLE is the honest v1: deterministic, needs no
 * solver, and degrades predictably as node count grows (unlike a force layout,
 * which can settle into a hairball unpredictably). Recorded on the ticket as
 * the scoping decision it is.
 *
 * WHAT AN EDGE MEANS. Every relation this component is given has already been
 * resolved server-side by GET /workspaces/:ws/relations (#448) — both sides
 * readable-or-absent, no N+1. This component does no access reasoning of its
 * own; it draws what it is handed.
 *
 * CROSS-SPACE EDGES ARE NOT HIDDEN (AC). A relation whose far side's `space_id`
 * differs from this page's space renders the far database as a distinct
 * satellite node, dashed, near the local node it connects to, labelled with
 * its own space name — "real and must not be hidden" per the ticket, but
 * visually never mistaken for a member of this space.
 */

export interface OntologyDatabase extends Pick<DatabaseSummary, 'id' | 'name' | 'icon' | 'color'> {
  description?: string | null;
  recordCounter?: number;
}

export interface OntologySide {
  database_id: string;
  database_name: string | null;
  space_id: string | null;
  field_id: string;
  field_name: string | null;
}

export interface OntologyRelation {
  id: string;
  cardinality: string;
  self_relation: boolean;
  a: OntologySide;
  b: OntologySide;
}

const NODE_R = 15; // px radius of a main node's circle
const SATELLITE_R = 8; // px radius of a cross-space satellite node

export function SpaceOntology({
  ws,
  spaceId,
  databases,
  relations,
  spaceNameById,
}: {
  ws: string;
  spaceId: string;
  databases: OntologyDatabase[];
  relations: OntologyRelation[];
  /** Resolves a cross-space edge's far `space_id` to a real name, so the
   *  satellite reads "in Marketing" rather than "in another space". */
  spaceNameById: Map<string, string>;
}) {
  const router = useRouter();

  const layout = useMemo(
    () => computeLayout(databases, relations, spaceId, spaceNameById),
    [databases, relations, spaceId, spaceNameById],
  );

  if (databases.length === 0) {
    // #449 AC — zero readable databases is stated plainly, never an empty
    // canvas that reads as "this space really is empty" (it might not be —
    // the viewer may simply not be able to read anything in it).
    return (
      <p className="rounded-[var(--radius-card)] border border-border-default bg-card p-6 text-[13px] text-muted">
        No databases here that you can access.
      </p>
    );
  }

  const openDatabase = (id: string) => router.push(`/w/${ws}/d/${id}`);
  // #449 — "clicking an edge opens the relation config" has no existing
  // deep-link target: there is no /relations/{id} route, and the field editor
  // opens only from inside a database's own table view with no query-param
  // convention to reach it from elsewhere (checked; none exists). Building one
  // means touching table-view.tsx, a hotspot file, for a new mechanism — bigger
  // than "click an edge" and not this ticket's to add unreviewed. The honest v1
  // opens the LOCAL database, where the relation's field is a real column.
  // Filed as its own ticket rather than left as a silent gap — see the PR body.
  const openRelation = (databaseId: string) => router.push(`/w/${ws}/d/${databaseId}`);

  return (
    <div className="overflow-x-auto rounded-[var(--radius-card)] border border-border-default bg-card p-4">
      <svg
        viewBox={`0 0 ${layout.width} ${layout.height}`}
        width={layout.width}
        height={layout.height}
        className="mx-auto"
        role="img"
        aria-label={`Ontology diagram: ${databases.length} ${pluralNoun('database', databases.length)}, ${relations.length} ${pluralNoun('relation', relations.length)}`}
      >
        {/* Edges first, so node circles paint over the line ends rather than a
            line poking past a label. */}
        {layout.edges.map((e) => (
          <g key={e.key}>
            {e.kind === 'loop' ? (
              <path
                d={e.d}
                fill="none"
                stroke="var(--border-strong)"
                strokeWidth={1.5}
                className="cursor-pointer hover:stroke-[var(--accent)]"
                onClick={() => openRelation(e.localDatabaseId)}
              >
                <title>{e.label}</title>
              </path>
            ) : (
              <line
                x1={e.x1}
                y1={e.y1}
                x2={e.x2}
                y2={e.y2}
                stroke="var(--border-strong)"
                strokeWidth={1.5}
                strokeDasharray={e.crossSpace ? '4 3' : undefined}
                className="cursor-pointer hover:stroke-[var(--accent)]"
                onClick={() => openRelation(e.localDatabaseId)}
              >
                <title>{e.label}</title>
              </line>
            )}
            <text
              x={e.labelX}
              y={e.labelY}
              textAnchor="middle"
              className="pointer-events-none fill-[var(--muted)] text-[9px]"
            >
              {e.shortLabel}
            </text>
          </g>
        ))}

        {/* Cross-space satellites: dashed ring, distinct fill, own space named —
            visible but never confusable with a member of this space. */}
        {layout.satellites.map((s) => (
          <g
            key={s.id}
            className="cursor-pointer"
            onClick={() => openDatabase(s.databaseId)}
          >
            <circle
              cx={s.x}
              cy={s.y}
              r={SATELLITE_R}
              fill="var(--card)"
              stroke="var(--border-strong)"
              strokeDasharray="3 2"
              strokeWidth={1.5}
            />
            <text x={s.x} y={s.y + SATELLITE_R + 11} textAnchor="middle" className="fill-[var(--muted)] text-[9px]">
              {s.name}
            </text>
            <text x={s.x} y={s.y + SATELLITE_R + 21} textAnchor="middle" className="fill-[var(--faint)] text-[8px]">
              in {s.spaceName}
            </text>
          </g>
        ))}

        {/* Main nodes. */}
        {layout.nodes.map((n) => (
          <g key={n.id} className="cursor-pointer" onClick={() => openDatabase(n.id)}>
            <circle
              cx={n.x}
              cy={n.y}
              r={NODE_R}
              fill="var(--card)"
              stroke={(n.color && OPTION_COLORS[n.color]) || 'var(--border-strong)'}
              strokeWidth={2}
            >
              <title>
                {n.name}
                {n.description ? ` — ${n.description}` : ''} · {n.recordCounter ?? 0}{' '}
                {pluralNoun(databaseNoun(n.name), n.recordCounter ?? 0)}
              </title>
            </circle>
            <foreignObject x={n.x - NODE_R} y={n.y - NODE_R} width={NODE_R * 2} height={NODE_R * 2}>
              <div className="flex h-full w-full items-center justify-center">
                <EntityIcon icon={n.icon} color={n.color} fallback={<DatabaseIcon className="h-3.5 w-3.5" />} />
              </div>
            </foreignObject>
            <text x={n.x} y={n.y + NODE_R + 12} textAnchor="middle" className="fill-[var(--ink)] text-[11px] font-medium">
              {n.name}
            </text>
            <text x={n.x} y={n.y + NODE_R + 23} textAnchor="middle" className="fill-[var(--faint)] text-[9px]">
              {n.recordCounter ?? 0} {pluralNoun(databaseNoun(n.name), n.recordCounter ?? 0)}
            </text>
          </g>
        ))}
      </svg>
    </div>
  );
}

interface LayoutNode {
  id: string;
  name: string;
  icon: string | null | undefined;
  color: string | null | undefined;
  description: string | null | undefined;
  recordCounter: number | undefined;
  x: number;
  y: number;
}
interface LayoutSatellite {
  id: string;
  databaseId: string;
  name: string;
  spaceName: string;
  x: number;
  y: number;
}
type LayoutEdge =
  | {
      kind: 'line';
      key: string;
      x1: number;
      y1: number;
      x2: number;
      y2: number;
      labelX: number;
      labelY: number;
      label: string;
      shortLabel: string;
      crossSpace: boolean;
      localDatabaseId: string;
    }
  | {
      kind: 'loop';
      key: string;
      d: string;
      labelX: number;
      labelY: number;
      label: string;
      shortLabel: string;
      localDatabaseId: string;
    };

function computeLayout(
  databases: OntologyDatabase[],
  relations: OntologyRelation[],
  spaceId: string,
  spaceNameById: Map<string, string>,
) {
  const n = databases.length;
  // Radius grows with node count so labels stop overlapping — the "readable at
  // 20 databases" criterion, satisfied by giving each node more arc room rather
  // than by trying to be clever about it.
  const radius = Math.max(90, n * 20);
  // A provisional centre, used only to PLACE things. The real canvas bounds are
  // computed from where everything actually ended up (below), not guessed here
  // — a guessed fixed margin is exactly what clipped a fanned-out self-relation
  // loop off the top edge on first render, caught live rather than in review:
  // the loop's control point landed one pixel past a viewBox that assumed every
  // loop stays close to its node.
  const center = radius + 100;

  const positions = new Map<string, { x: number; y: number }>();
  databases.forEach((d, i) => {
    const angle = (2 * Math.PI * i) / n - Math.PI / 2;
    positions.set(d.id, {
      x: center + radius * Math.cos(angle),
      y: center + radius * Math.sin(angle),
    });
  });

  const nodes: LayoutNode[] = databases.map((d) => ({
    id: d.id,
    name: d.name,
    icon: d.icon,
    color: d.color,
    description: d.description,
    recordCounter: d.recordCounter,
    ...positions.get(d.id)!,
  }));

  const edges: LayoutEdge[] = [];
  const satellites: LayoutSatellite[] = [];
  const dbIds = new Set(databases.map((d) => d.id));
  // #449 — a node can carry more than one self-relation (Issues has both
  // Parent/Sub-tasks and Blocked-by/Blocks). Drawing every loop at the same
  // fixed angle stacked their labels illegibly on top of each other — caught
  // live, not in review. Each loop on the SAME node now claims its own angle
  // around it, spaced out as more accumulate.
  const loopIndexByNode = new Map<string, number>();

  for (const r of relations) {
    const cardinalityLabel = r.cardinality.replace(/_/g, '-');
    if (r.self_relation) {
      const p = positions.get(r.a.database_id);
      if (!p) continue;
      const loopIndex = loopIndexByNode.get(r.a.database_id) ?? 0;
      loopIndexByNode.set(r.a.database_id, loopIndex + 1);
      // Fan the loops out from straight-up, alternating left/right of centre so
      // a second and third loop do not retrace the first one's path.
      const spread = 34; // degrees between successive loops
      const sign = loopIndex % 2 === 0 ? 1 : -1;
      const step = Math.ceil(loopIndex / 2);
      const angleDeg = -90 + sign * step * spread;
      const angle = (angleDeg * Math.PI) / 180;
      const loopR = NODE_R * 1.1;
      const baseX = p.x + (NODE_R + 2) * Math.cos(angle);
      const baseY = p.y + (NODE_R + 2) * Math.sin(angle);
      const tipX = p.x + (NODE_R + loopR * 2.6) * Math.cos(angle);
      const tipY = p.y + (NODE_R + loopR * 2.6) * Math.sin(angle);
      // Perpendicular offset for the loop's two control points, so it bulges
      // out from the node rather than drawing a straight spike.
      const perpX = -Math.sin(angle) * loopR * 1.6;
      const perpY = Math.cos(angle) * loopR * 1.6;
      const d = `M ${baseX} ${baseY} C ${baseX + perpX} ${baseY + perpY}, ${tipX + perpX} ${tipY + perpY}, ${tipX} ${tipY}`;
      edges.push({
        kind: 'loop',
        key: r.id,
        d,
        labelX: tipX,
        labelY: tipY + (Math.sin(angle) >= 0 ? 12 : -8),
        label: `${r.a.field_name ?? '?'} / ${r.b.field_name ?? '?'} (${cardinalityLabel})`,
        shortLabel: `${r.a.field_name ?? '?'} / ${r.b.field_name ?? '?'}`,
        localDatabaseId: r.a.database_id,
      });
      continue;
    }

    // Which side is "local" (in this space) — used to decide the click target
    // and, for a cross-space edge, which side becomes the satellite.
    const aLocal = dbIds.has(r.a.database_id);
    const bLocal = dbIds.has(r.b.database_id);

    if (aLocal && bLocal) {
      const pa = positions.get(r.a.database_id);
      const pb = positions.get(r.b.database_id);
      if (!pa || !pb) continue;
      edges.push({
        kind: 'line',
        key: r.id,
        x1: pa.x,
        y1: pa.y,
        x2: pb.x,
        y2: pb.y,
        labelX: (pa.x + pb.x) / 2,
        labelY: (pa.y + pb.y) / 2 - 4,
        // AC: "Edges carry cardinality and the field name on each side —
        // Issues — Epic → Epics reads as a sentence."
        label: `${r.a.database_name} — ${r.a.field_name} → ${r.b.database_name} (${cardinalityLabel})`,
        shortLabel: `${r.a.field_name ?? ''} / ${r.b.field_name ?? ''}`,
        crossSpace: false,
        localDatabaseId: r.a.database_id,
      });
      continue;
    }

    // Cross-space: exactly one side is local (the relations endpoint only
    // returns a relation at all when both sides are READABLE, and this page
    // only asked for relations touching `spaceId`, so at least one side must
    // be local — both-local is handled above, so this branch is both-not-local
    // impossible, or genuinely one-local-one-far).
    const local = aLocal ? r.a : bLocal ? r.b : null;
    const far = aLocal ? r.b : bLocal ? r.a : null;
    if (!local || !far) continue;
    const p = positions.get(local.database_id);
    if (!p) continue;
    // Park the satellite just past the ring, on the ray from centre through the
    // local node — reads as "attached to this node, outside the circle".
    const angle = Math.atan2(p.y - center, p.x - center);
    const sx = center + (radius + 46) * Math.cos(angle);
    const sy = center + (radius + 46) * Math.sin(angle);
    const satelliteId = `${r.id}:${far.database_id}`;
    satellites.push({
      id: satelliteId,
      databaseId: far.database_id,
      name: far.database_name ?? 'Untitled',
      spaceName: (far.space_id && spaceNameById.get(far.space_id)) || 'another space',
      x: sx,
      y: sy,
    });
    edges.push({
      kind: 'line',
      key: r.id,
      x1: p.x,
      y1: p.y,
      x2: sx,
      y2: sy,
      labelX: (p.x + sx) / 2,
      labelY: (p.y + sy) / 2 - 4,
      label: `${local.database_name} — ${local.field_name} → ${far.database_name} (outside this space, ${cardinalityLabel})`,
      shortLabel: `${local.field_name ?? ''} / ${far.field_name ?? ''}`,
      crossSpace: true,
      localDatabaseId: local.database_id,
    });
  }

  // Real bounds: every node, satellite and loop control/tip point, each with
  // enough padding for its own label. Panning/clipping bugs in a hand-rolled
  // diagram come from assuming a shape's extent instead of measuring it, so
  // this measures.
  const pts: Array<{ x: number; y: number; pad: number }> = [
    ...nodes.map((p) => ({ x: p.x, y: p.y, pad: NODE_R + 26 })),
    ...satellites.map((p) => ({ x: p.x, y: p.y, pad: SATELLITE_R + 24 })),
  ];
  for (const e of edges) {
    if (e.kind === 'loop') {
      pts.push({ x: e.labelX, y: e.labelY, pad: 14 });
    }
  }
  const minX = Math.min(...pts.map((p) => p.x - p.pad));
  const maxX = Math.max(...pts.map((p) => p.x + p.pad));
  const minY = Math.min(...pts.map((p) => p.y - p.pad));
  const maxY = Math.max(...pts.map((p) => p.y + p.pad));

  const offsetX = -minX;
  const offsetY = -minY;
  const width = maxX - minX;
  const height = maxY - minY;

  const shift = <T extends { x: number; y: number }>(p: T): T => ({ ...p, x: p.x + offsetX, y: p.y + offsetY });
  const shiftedNodes = nodes.map(shift);
  const shiftedSatellites = satellites.map(shift);
  const shiftedEdges = edges.map((e) =>
    e.kind === 'loop'
      ? { ...e, d: shiftPathData(e.d, offsetX, offsetY), labelX: e.labelX + offsetX, labelY: e.labelY + offsetY }
      : {
          ...e,
          x1: e.x1 + offsetX,
          y1: e.y1 + offsetY,
          x2: e.x2 + offsetX,
          y2: e.y2 + offsetY,
          labelX: e.labelX + offsetX,
          labelY: e.labelY + offsetY,
        },
  );

  return { width, height, nodes: shiftedNodes, edges: shiftedEdges, satellites: shiftedSatellites };
}

/** Translate every absolute coordinate in an SVG path's `d` string. The paths
 *  this module builds are all `M x y C x y, x y, x y` — numbers only, no
 *  relative commands — so a blind numeric shift is exact, not an approximation. */
function shiftPathData(d: string, dx: number, dy: number): string {
  let i = 0;
  return d.replace(/-?\d+(?:\.\d+)?/g, (match) => {
    const value = Number(match);
    const shifted = i % 2 === 0 ? value + dx : value + dy;
    i += 1;
    return String(shifted);
  });
}
