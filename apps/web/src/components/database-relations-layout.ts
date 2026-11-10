import type { OntologyRelation } from '@/components/space-ontology';

/**
 * Ticket #1259 — the geometry of the per-database relations diagram, as pure
 * functions so "no two labels overlap" is a unit-tested property and not
 * something checked by eye on one screenshot.
 *
 * Before this, every edge label sat at the exact midpoint of its spoke and
 * every node name sat under its node, with a ring radius of `n * 22`. Measured
 * at 8 related databases, adjacent spoke midpoints are 67px apart and a label
 * like "Account manager / Accounts" is wider than that, so labels collided
 * with each other and with the node names beside them. The fixed ring never
 * asked how wide the text was.
 *
 * Text is not measurable without a DOM, so widths are ESTIMATED from character
 * count (`CHAR_W`, deliberately on the wide side). An overestimate leaves a few
 * spare pixels; an underestimate would reintroduce the overlap. Long text is
 * truncated with an ellipsis (the full string stays in the `<title>`), so the
 * estimate has a ceiling and the ring cannot grow without bound.
 */

export const CENTER_R = 20;
export const NODE_R = 16;

/** Font sizes of the three SVG text roles, px (design tokens --text-meta / --text-label). */
export const EDGE_FONT = 11;
export const NODE_FONT = 11;
export const CENTER_FONT = 12;
/** Average glyph advance as a fraction of font size; 0.6 over-estimates Inter-like text. */
const CHAR_W = 0.6;
const LINE_H = 14;

export const MAX_EDGE_LABEL_CHARS = 24;
export const MAX_NODE_NAME_CHARS = 20;

export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface CenterDatabase {
  id: string;
  name: string;
  icon: string | null;
  color: string | null;
}

export interface Spoke {
  database: { id: string; name: string; icon: string | null; color: string | null };
  x: number;
  y: number;
  /** Truncated for display; the full name is the node's `<title>`. */
  nameText: string;
  nameBox: Box;
  edges: Array<{
    relationId: string;
    label: string;
    shortLabel: string;
    /** Truncated for display. */
    text: string;
    /** Centre of the label's box. */
    lx: number;
    ly: number;
    box: Box;
  }>;
}

export function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, Math.max(1, max - 1)).trimEnd()}…`;
}

function textWidth(s: string, fontSize: number): number {
  return s.length * fontSize * CHAR_W;
}

function centredBox(cx: number, cy: number, w: number, h: number): Box {
  return { x0: cx - w / 2, y0: cy - h / 2, x1: cx + w / 2, y1: cy + h / 2 };
}

export function overlapArea(a: Box, b: Box, gap = 0): number {
  const w = Math.min(a.x1 + gap, b.x1 + gap) - Math.max(a.x0, b.x0);
  const h = Math.min(a.y1 + gap, b.y1 + gap) - Math.max(a.y0, b.y0);
  return w > 0 && h > 0 ? w * h : 0;
}

/** Positions along a spoke tried in order (0 = centre, 1 = node), nearest the middle first. */
const T_CANDIDATES = [0.5, 0.45, 0.55, 0.4, 0.6, 0.35, 0.65, 0.7];
/** Perpendicular nudges tried per position, in line heights (0 = on the line). */
const SIDE_CANDIDATES = [0, 1, -1, 2, -2];

/** Self-relations (both sides point at the CENTER database) have no far node
 *  to draw a spoke to — they are simply not drawn here rather than guessed at. */
export function computeSpokeLayout(center: CenterDatabase, relations: OntologyRelation[]) {
  const byFarDb = new Map<string, Spoke['database']>();
  const edgesByFarDb = new Map<
    string,
    Array<{ relationId: string; label: string; shortLabel: string }>
  >();

  for (const r of relations) {
    if (r.self_relation) continue;
    const far = r.a.database_id === center.id ? r.b : r.a;
    const local = r.a.database_id === center.id ? r.a : r.b;
    if (!far.database_id || far.database_id === center.id) continue;
    if (!byFarDb.has(far.database_id)) {
      byFarDb.set(far.database_id, {
        id: far.database_id,
        name: far.database_name ?? 'Untitled',
        icon: null,
        color: null,
      });
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

  // Radius: the old `n * 22` floor, raised until neighbouring node NAMES (the
  // widest thing on the ring) fit between adjacent spokes. chord = 2R sin(pi/n).
  const widestName = Math.max(
    0,
    ...fars.map((d) => textWidth(truncate(d.name, MAX_NODE_NAME_CHARS), NODE_FONT)),
  );
  const byNames = n > 1 ? (widestName + 12) / (2 * Math.sin(Math.PI / n)) : 0;
  const baseRadius = Math.max(90, n * 22, byNames);
  // If some label cannot clear its neighbours at this radius, widen the ring
  // (more room along every spoke) and try again, rather than accept an overlap.
  let result = layoutAtRadius(baseRadius);
  for (let k = 1; k <= 12 && result.collided; k++) result = layoutAtRadius(baseRadius * 1.15 ** k);
  return result.layout;

  function layoutAtRadius(radius: number) {
    const cx = radius + 60;
    const cy = radius + 40;

    const centreNameText = truncate(center.name, 28);
    const centreNameBox = centredBox(
      cx,
      cy + CENTER_R + 14 - 4,
      textWidth(centreNameText, CENTER_FONT),
      LINE_H,
    );
    const obstacles: Box[] = [
      { x0: cx - CENTER_R, y0: cy - CENTER_R, x1: cx + CENTER_R, y1: cy + CENTER_R },
      centreNameBox,
    ];

    const spokes: Spoke[] = fars.map((database, i) => {
      const angle = (2 * Math.PI * i) / n - Math.PI / 2;
      const x = cx + radius * Math.cos(angle);
      const y = cy + radius * Math.sin(angle);
      const nameText = truncate(database.name, MAX_NODE_NAME_CHARS);
      const nameBox = centredBox(x, y + NODE_R + 13 - 4, textWidth(nameText, NODE_FONT), LINE_H);
      obstacles.push({ x0: x - NODE_R, y0: y - NODE_R, x1: x + NODE_R, y1: y + NODE_R }, nameBox);
      return {
        database,
        x,
        y,
        nameText,
        nameBox,
        edges: (edgesByFarDb.get(database.id) ?? []).map((e) => ({
          ...e,
          text: truncate(e.shortLabel, MAX_EDGE_LABEL_CHARS),
          lx: 0,
          ly: 0,
          box: { x0: 0, y0: 0, x1: 0, y1: 0 },
        })),
      };
    });

    // Edge labels, placed greedily in spoke order. Each tries positions along its
    // own spoke (and a perpendicular nudge to either side) and takes the first
    // that clears every node, node name and already-placed label; if none does
    // it takes the least-overlapping one rather than dropping the label.
    const placed: Box[] = [];
    let collided = false;
    for (const s of spokes) {
      const dx = s.x - cx;
      const dy = s.y - cy;
      const len = Math.hypot(dx, dy) || 1;
      const nx = -dy / len;
      const ny = dx / len;
      for (const e of s.edges) {
        const w = textWidth(e.text, EDGE_FONT);
        let best: { box: Box; lx: number; ly: number; cost: number } | null = null;
        search: for (const side of SIDE_CANDIDATES) {
          for (const t of T_CANDIDATES) {
            const off = side * (LINE_H + 2);
            const lx = cx + dx * t + nx * off;
            const ly = cy + dy * t + ny * off;
            const box = centredBox(lx, ly, w, LINE_H);
            let cost = 0;
            for (const o of obstacles) cost += overlapArea(box, o, 2);
            for (const p of placed) cost += overlapArea(box, p, 2);
            if (!best || cost < best.cost) best = { box, lx, ly, cost };
            if (cost === 0) break search;
          }
        }
        const pick = best!;
        if (pick.cost > 0) collided = true;
        e.lx = pick.lx;
        e.ly = pick.ly;
        e.box = pick.box;
        placed.push(pick.box);
      }
    }

    // Bounding box from what is actually drawn (nodes, names, labels), not a
    // guessed margin.
    const all: Box[] = [...obstacles, ...placed];
    const minX = Math.min(...all.map((b) => b.x0)) - 8;
    const maxX = Math.max(...all.map((b) => b.x1)) + 8;
    const minY = Math.min(...all.map((b) => b.y0)) - 8;
    const maxY = Math.max(...all.map((b) => b.y1)) + 8;
    const shift = (b: Box): Box => ({
      x0: b.x0 - minX,
      y0: b.y0 - minY,
      x1: b.x1 - minX,
      y1: b.y1 - minY,
    });

    return {
      collided,
      layout: {
        cx: cx - minX,
        cy: cy - minY,
        width: maxX - minX,
        height: maxY - minY,
        centreName: centreNameText,
        spokes: spokes.map((s) => ({
          ...s,
          x: s.x - minX,
          y: s.y - minY,
          nameBox: shift(s.nameBox),
          edges: s.edges.map((e) => ({
            ...e,
            lx: e.lx - minX,
            ly: e.ly - minY,
            box: shift(e.box),
          })),
        })),
        /** Every box that must not overlap another, in diagram coordinates — for tests. */
        obstacles: obstacles.map(shift),
      },
    };
  }
}
