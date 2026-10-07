'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ChevronRight, Database as DatabaseIcon, Plus } from 'lucide-react';
import { EntityIcon } from '@/components/ui/icon-picker';
import type { DatabaseSummary } from '@/lib/queries';
import { cn } from '@/lib/utils';
import { buildOntologyView, pickCentre } from './space-ontology-layout';
import { Dialog } from './ui/dialog';
import { AddFieldDialog } from './table-view/add-field-dialog';
import type { OntologyChip, OntologyGroup } from './space-ontology-layout';

/**
 * #636 — the ontology diagram: ONE database at the centre, everything it
 * relates to as chip lists grouped by space.
 *
 * Replaces the radial layout of #449/#528/#607. Those were three passes at the
 * same rendering symptom — satellite vs satellite, fan step vs label width,
 * edge midpoint vs satellite name at exactly 0.00px — and none asked whether
 * the FORM was wrong. It was: every one of those collisions existed because
 * relationship labels were drawn at rest and positioned by geometry. Moving
 * them to hover leaves nothing to collide, and chip lists grow downward where
 * geometry could not.
 *
 * WHAT THIS DIAGRAM NO LONGER SHOWS, stated because it is invisible from the
 * code: a database with no relation to the centre is not drawn. Ievgen chose
 * the single-centre form (ticket #636) knowing that. It is softened by the page
 * — the Contents section directly below lists every database in the space with
 * a link — so such a database is undrawn, never unreachable.
 *
 * DIAGRAM_NODE_LIMIT and its list fallback are gone with the circle. That limit
 * existed because the radial layout overlapped past ~10 nodes; a chip list has
 * no such threshold, which is the point of the redesign.
 *
 * Layout and balance live in `space-ontology-layout.ts` as pure functions, so
 * the determinism they guarantee is unit-tested without a DOM.
 *
 * ORIGINAL #449 NOTE, still true of the data:
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
  /** Resolves a far side's `space_id` to a real name, so a group reads
   *  "Content Marketing" rather than a uuid. */
  spaceNameById: Map<string, string>;
}) {
  const router = useRouter();

  const [addOpen, setAddOpen] = useState(false);

  const centre = useMemo(() => pickCentre(databases, relations), [databases, relations]);
  const view = useMemo(
    () => (centre ? buildOntologyView(centre, relations, spaceNameById, spaceId) : null),
    [centre, relations, spaceNameById, spaceId],
  );

  if (databases.length === 0 || !centre || !view) {
    // #449 AC — zero readable databases is stated plainly, never an empty
    // canvas that reads as "this space really is empty" (it might not be —
    // the viewer may simply not be able to read anything in it).
    return (
      <p className="rounded-[var(--radius-card)] border border-border-default bg-card p-6 text-body text-muted">
        No databases here that you can access.
      </p>
    );
  }

  /* #497 — the chevron deep-links to the relation's OWN column, not just the
     database: `?field={id}` on the database route, read by table-view.tsx to
     auto-open that field's Edit dialog. The mechanism moved from an SVG edge to
     a chip; the behaviour is unchanged, which is what AC6 asks for. */
  const openRelation = (databaseId: string, fieldId: string) =>
    router.push(`/w/${ws}/d/${databaseId}?field=${fieldId}`);

  return (
    /* #687 — `@container`, not a viewport breakpoint. The bug is about the width
       the diagram ACTUALLY HAS, and the viewport does not know it: collapsing the
       sidebar changes this card's inline size by 240px, so a media query gets the
       answer wrong in both directions. A container query asks the only question
       that matters. */
    <div className="@container rounded-[var(--radius-card)] border border-border-default bg-card p-6">
      {/* #687 — THE BREAKPOINT IS DERIVED, NOT CHOSEN. The cross layout's widest
          possible demand is the centre chip (max-w-56 = 224px) + two gap-x-6
          (48px) + a chip on each side (max-w-44 = 176px each) = 624px. Below that
          it CAN overflow, which is the bug: 8 of 31 chips painted outside this
          card's border at an 820px viewport because `grid-cols-[1fr_auto_1fr]`
          always reserves three columns whether or not they fit.

          So: single column until 640px of container width, the cross above it.
          A single column cannot overflow horizontally, and going taller is this
          design's native behaviour rather than a compromise — #636 chose the
          chip-list layout over the radial one precisely because "chip lists grow
          downward and geometry does not".

          Collapsing the four axes costs no meaning. Ievgen ruled on #636 that
          placement is BALANCE ONLY: the axes carry no information and a reader is
          not meant to infer anything from position. That is what makes this a
          legitimate degrade rather than a loss of signal. */}
      {/* Each axis wrapper is w-full/items-stretch when stacked so all eight group
          labels share ONE left edge. Without it they are centred grid items and
          blocks of different widths centre differently — measured 3 distinct left
          edges (25 / 31 / 57px) before this, which reads as ragged indentation. */}
      <div className="grid grid-cols-1 justify-items-center gap-y-4 @min-[640px]:grid-cols-[1fr_auto_1fr] @min-[640px]:grid-rows-[auto_auto_auto] @min-[640px]:items-center @min-[640px]:gap-x-6">
        <div className="order-2 flex w-full flex-col items-stretch gap-2 @min-[640px]:order-none @min-[640px]:col-start-2 @min-[640px]:row-start-1 @min-[640px]:w-auto @min-[640px]:items-center">
          <AxisGroups groups={view.axes.up} onOpen={openRelation} />
          <AxisLine vertical hasContent={view.axes.up.length > 0} />
        </div>

        <div className="order-3 flex w-full items-stretch gap-2 @min-[640px]:order-none @min-[640px]:col-start-1 @min-[640px]:row-start-2 @min-[640px]:w-auto @min-[640px]:items-center @min-[640px]:justify-self-end">
          <AxisGroups groups={view.axes.left} onOpen={openRelation} />
          <AxisLine hasContent={view.axes.left.length > 0} />
        </div>

        <CentreChip database={centre} onAdd={() => setAddOpen(true)} />

        <div className="order-4 flex w-full items-stretch gap-2 @min-[640px]:order-none @min-[640px]:col-start-3 @min-[640px]:row-start-2 @min-[640px]:w-auto @min-[640px]:items-center @min-[640px]:justify-self-start">
          <AxisLine hasContent={view.axes.right.length > 0} />
          <AxisGroups groups={view.axes.right} onOpen={openRelation} />
        </div>

        <div className="order-5 flex w-full flex-col items-stretch gap-2 @min-[640px]:order-none @min-[640px]:col-start-2 @min-[640px]:row-start-3 @min-[640px]:w-auto @min-[640px]:items-center">
          <AxisLine vertical hasContent={view.axes.down.length > 0} />
          <AxisGroups groups={view.axes.down} onOpen={openRelation} />
        </div>
      </div>

      {/* #636 AC1 — ONE `+`, not the four the ticket describes.
          The ticket says "four axes… each a plain line ending in a `+` that adds
          a relation in that direction", which reads naturally when direction
          means something. It does not: Ievgen chose balance-only placement, so a
          chip added "upward" lands wherever the deterministic balance puts it.
          Four buttons that all do one thing imply a choice the system then
          ignores, which is worse than one button. So the axis lines stay pure
          structure and the single `+` sits on the centre chip, where "add a
          relation FROM this database" is unambiguous.

          It opens `AddFieldDialog` with initialType="relation" — the SAME dialog
          the /relations page opens, deliberately not a second path. Otto's
          ruling there: cardinality changes are destructive, and "two code paths
          that both claim to create/edit a relation is exactly how they drift
          apart". This surface adds a third entry point, not a third mechanism. */}
      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        {addOpen && (
          <AddFieldDialog
            ws={ws}
            db={centre.id}
            initialType="relation"
            onDone={() => setAddOpen(false)}
          />
        )}
      </Dialog>
    </div>
  );
}

/** The axis line. Drawn even when an axis is empty: the lines are what say
 *  "relations attach here", and a lone chip with nothing around it gives the
 *  reader no hint that the diagram has structure. */
function AxisLine({ vertical, hasContent }: { vertical?: boolean; hasContent: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        /* #687 — hidden in the stacked form. The lines exist to say "there are
           four directions"; in a single column that is simply not true, and four
           stray rules would describe a structure the layout no longer has. */
        'hidden shrink-0 bg-border-default @min-[640px]:block',
        vertical ? 'h-6 w-px' : 'h-px w-6',
        hasContent ? 'opacity-100' : 'opacity-40',
      )}
    />
  );
}

function CentreChip({
  database,
  onAdd,
}: {
  database: OntologyDatabase;
  onAdd: () => void;
}) {
  return (
    <span className="order-1 inline-flex max-w-56 items-center gap-2 rounded-[var(--radius-chip)] border border-border-strong bg-app py-1.5 pl-2.5 pr-1.5 @min-[640px]:order-none @min-[640px]:col-start-2 @min-[640px]:row-start-2">
      <EntityIcon
        icon={database.icon}
        color={database.color}
        fallback={<DatabaseIcon size={14} />}
      />
      <span className="truncate text-body font-medium text-ink">{database.name}</span>
      <button
        type="button"
        onClick={onAdd}
        /* Always visible, never hover-only: this is the diagram's only action,
           and #637's rule is that anything carrying an affordance clears AA —
           so text-muted, not text-faint. */
        className="-mr-0.5 shrink-0 rounded-[var(--radius-control)] p-0.5 text-muted hover:bg-hover hover:text-ink"
        title={`Add a relation from ${database.name}`}
        aria-label={`Add a relation from ${database.name}`}
      >
        <Plus className="h-3.5 w-3.5" aria-hidden />
      </button>
    </span>
  );
}

function AxisGroups({
  groups,
  onOpen,
}: {
  groups: OntologyGroup[];
  onOpen: (databaseId: string, fieldId: string) => void;
}) {
  if (groups.length === 0) return null;
  return (
    <div className="flex flex-col gap-3">
      {groups.map((g) => (
        <div key={`${g.spaceId ?? 'none'}-${g.spaceName}`} className="flex flex-col gap-1">
          {/* --text-muted, not faint: a group label is how a reader knows which
              cluster is which, so it carries an affordance (#637 / #326). */}
          <span className="text-meta font-medium uppercase tracking-wider text-muted">
            {g.spaceName}
          </span>
          <div className="flex flex-wrap gap-1.5">
            {g.chips.map((c) => (
              <RelatedChip key={c.relationId} chip={c} onOpen={onOpen} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/** Cardinality in words. `one_to_many` and `many_to_many` are the only two the
 *  schema has — there is no `many_to_one`, it is the same relation read from
 *  the other end. */
function cardinalityLabel(c: string): string {
  return c === 'one_to_many' ? 'one-to-many' : c === 'many_to_many' ? 'many-to-many' : c;
}

function RelatedChip({
  chip,
  onOpen,
}: {
  chip: OntologyChip;
  onOpen: (databaseId: string, fieldId: string) => void;
}) {
  const describedBy = `rel-${chip.relationId}`;
  const label = `${cardinalityLabel(chip.cardinality)}${chip.localFieldName ? ` \u00b7 via \u201c${chip.localFieldName}\u201d` : ''}${chip.selfRelation ? ' \u00b7 self-relation' : ''}`;
  return (
    <span className="group relative inline-flex">
      <button
        type="button"
        aria-describedby={describedBy}
        onClick={() => onOpen(chip.databaseId, chip.fieldId)}
        className="inline-flex max-w-44 items-center gap-1 rounded-[var(--radius-chip)] border border-border-default bg-card py-0.5 pl-1.5 pr-1 text-label text-ink hover:bg-hover"
      >
        {/*
          A SELF-RELATION NAMES THE RELATION, NOT THE DATABASE. Found by looking
          at it: the Tasks database has two self-relations, so the diagram drew
          a "Tasks" centre with two "Tasks" chips hanging off it — technically
          correct and useless to read. The database is already the centre; what
          distinguishes these chips is which relation they are, so the field
          name is the informative label ("Parent task", "Blocked by").
        */}
        <span className="truncate">
          {(chip.selfRelation ? (chip.localFieldName ?? chip.name) : chip.name) ?? 'Untitled'}
        </span>
        <ChevronRight size={12} className="shrink-0 text-muted" aria-hidden />
      </button>
      {/*
        THE RELATIONSHIP TYPE IS SHOWN ONLY ON INTERACTION — Ievgen's most
        important line on ticket #636, and the reason the whole collision class
        is gone: nothing is positioned by geometry at rest.

        It reveals on FOCUS as well as hover. That is not in the ticket and I
        added it: "hover only" was a statement about what is drawn at rest, not
        a decision to make relationship type unreachable for keyboard users.
        `aria-describedby` also hands it to a screen reader without needing
        either event.
      */}
      <span
        id={describedBy}
        role="tooltip"
        className="pointer-events-none absolute left-1/2 top-full z-[var(--z-popover)] mt-1 hidden -translate-x-1/2 whitespace-nowrap rounded-[var(--radius-control)] border border-border-default bg-card px-2 py-1 text-meta text-ink shadow-[var(--shadow-popover)] group-focus-within:block group-hover:block"
      >
        {label}
      </span>
    </span>
  );
}
