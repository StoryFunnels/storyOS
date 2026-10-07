/**
 * #636 — the ontology layout, as a pure function.
 *
 * Replaces the radial geometry of #449/#528/#607. Every collision those three
 * tickets chased — satellite vs satellite, fan step vs label width, edge
 * midpoint vs satellite name at exactly 0.00px — existed because relationship
 * labels were drawn at rest and positioned by geometry. This layout draws them
 * on interaction instead, so there is nothing left to collide, and chips grow
 * downward where geometry could not.
 *
 * BALANCE IS DETERMINISTIC, and that is the load-bearing property.
 *
 * Ievgen decided (ticket #636, AC7) that above/below placement encodes NOTHING —
 * it is balance only. The risk in that answer is jitter: if placement follows
 * "whichever axis has room", the same space must still render IDENTICALLY on
 * every load, or the diagram rearranges between visits and after any unrelated
 * edit, and nobody can build a mental map of their own schema.
 *
 * So balance is a pure function of the data. No measurement, no iteration
 * order, no randomness:
 *
 *   1. group relations by the FAR side's space
 *   2. sort groups by chip count DESC, then space name ASC, then space id ASC
 *      — a total order, so there are no ties left for insertion order to break
 *   3. assign each group to the axis holding the fewest chips so far,
 *      ties broken by the fixed sequence below
 *
 * `down` leads the tie-break because vertical lists grow without bound while
 * horizontal ones hit the panel edge, so the first and largest group belongs on
 * a vertical axis.
 */
import type { OntologyDatabase, OntologyRelation, OntologySide } from './space-ontology';

export type OntologyAxis = 'down' | 'up' | 'right' | 'left';

/** Fixed tie-break order — see the header. Vertical first, on purpose. */
export const AXIS_ORDER: readonly OntologyAxis[] = ['down', 'up', 'right', 'left'] as const;

export interface OntologyChip {
  /** The database this chip navigates to. */
  databaseId: string;
  name: string | null;
  /** #497 — the LOCAL side's field id, so the chevron deep-links to the
   *  relation's own column rather than just the database. */
  fieldId: string;
  relationId: string;
  cardinality: string;
  selfRelation: boolean;
  /** Both field names, for the hover/focus label. Nothing is drawn at rest. */
  localFieldName: string | null;
  farFieldName: string | null;
  spaceId: string | null;
}

export interface OntologyGroup {
  spaceId: string | null;
  /** Resolved name, or a stated fallback — never a bare id in the UI. */
  spaceName: string;
  chips: OntologyChip[];
}

export interface OntologyView {
  centre: OntologyDatabase;
  /** Groups per axis, in render order. An axis may legitimately be empty. */
  axes: Record<OntologyAxis, OntologyGroup[]>;
  totalChips: number;
}

/** The side of `relation` that is NOT the centre. For a self-relation both
 *  sides are the centre, and side B is used so the chip still names something. */
function farSide(relation: OntologyRelation, centreId: string): OntologySide {
  return relation.a.database_id === centreId ? relation.b : relation.a;
}

function localSide(relation: OntologyRelation, centreId: string): OntologySide {
  return relation.a.database_id === centreId ? relation.a : relation.b;
}

export function buildOntologyView(
  centre: OntologyDatabase,
  relations: OntologyRelation[],
  spaceNameById: Map<string, string>,
  currentSpaceId: string,
): OntologyView {
  const touching = relations.filter(
    (r) => r.a.database_id === centre.id || r.b.database_id === centre.id,
  );

  const chips: OntologyChip[] = touching.map((r) => {
    const far = farSide(r, centre.id);
    const local = localSide(r, centre.id);
    return {
      databaseId: far.database_id,
      name: far.database_name,
      fieldId: local.field_id,
      relationId: r.id,
      cardinality: r.cardinality,
      selfRelation: r.self_relation,
      localFieldName: local.field_name,
      farFieldName: far.field_name,
      spaceId: far.space_id,
    };
  });

  // group by the far side's space
  const bySpace = new Map<string, OntologyChip[]>();
  for (const c of chips) {
    const key = c.spaceId ?? '';
    const list = bySpace.get(key);
    if (list) list.push(c);
    else bySpace.set(key, [c]);
  }

  const groups: OntologyGroup[] = [...bySpace.entries()].map(([spaceId, list]) => ({
    spaceId: spaceId || null,
    spaceName:
      spaceId === currentSpaceId
        ? (spaceNameById.get(spaceId) ?? 'This space')
        : (spaceNameById.get(spaceId) ?? 'Another space'),
    // chips within a group are ordered by name so a group is stable too — the
    // same reasoning as the group order itself, one level down.
    chips: [...list].sort(
      (x, y) =>
        (x.name ?? '').localeCompare(y.name ?? '') || x.relationId.localeCompare(y.relationId),
    ),
  }));

  // total order: count desc, then name, then id. No ties for insertion order.
  groups.sort(
    (a, b) =>
      b.chips.length - a.chips.length ||
      a.spaceName.localeCompare(b.spaceName) ||
      (a.spaceId ?? '').localeCompare(b.spaceId ?? ''),
  );

  const axes: Record<OntologyAxis, OntologyGroup[]> = { down: [], up: [], right: [], left: [] };
  const load: Record<OntologyAxis, number> = { down: 0, up: 0, right: 0, left: 0 };

  for (const g of groups) {
    let best: OntologyAxis = AXIS_ORDER[0]!;
    for (const axis of AXIS_ORDER) {
      if (load[axis] < load[best]) best = axis;
    }
    axes[best].push(g);
    load[best] += g.chips.length;
  }

  return { centre, axes, totalChips: chips.length };
}

/**
 * Which database sits in the middle. Ievgen chose a single diagram centred on
 * the biggest database (ticket #636), so "biggest" has to be defined and it has
 * to be STABLE — the centre changing between visits would move the whole
 * picture, which is the same jitter the balance rule exists to prevent.
 *
 * Most relations wins; ties go to the alphabetically first name, then to the id.
 * A total order, so the centre never depends on array order.
 *
 * THE ACCEPTED COST, recorded here because it is invisible from the code: a
 * database with no relation to the centre does not appear in the diagram at
 * all. That is softened by the page itself — the Contents section directly
 * below lists every database in the space with a link, so nothing becomes
 * unreachable, it is simply not drawn.
 */
export function pickCentre(
  databases: OntologyDatabase[],
  relations: OntologyRelation[],
): OntologyDatabase | null {
  if (databases.length === 0) return null;
  const degree = new Map<string, number>();
  for (const d of databases) degree.set(d.id, 0);
  for (const r of relations) {
    for (const id of [r.a.database_id, r.b.database_id]) {
      const n = degree.get(id);
      if (n !== undefined) degree.set(id, n + 1);
    }
  }
  return [...databases].sort(
    (a, b) =>
      (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0) ||
      (a.name ?? '').localeCompare(b.name ?? '') ||
      a.id.localeCompare(b.id),
  )[0]!;
}
