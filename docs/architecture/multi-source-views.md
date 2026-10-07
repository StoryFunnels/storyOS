# Multi-source views: a view is a list of source trees, not one database

The design for the largest idea out of the 2026-08-21 views-architecture
conversation — a view that sources SEVERAL databases, each nested under the
next by a relation ("Article" with "ArticleContentFunnels" nested beneath it,
plus a second, independent top-level source, "Glossary Term"). Written per
#348 (spec-only; no code lands under that ticket number) so the eight open
questions it names have a decision and a reason, not a list of options, before
anything is split into buildable pieces.

> **TL;DR** — a view's `config` gains an optional `sources: SourceNode[]`, each
> node `{ database_id, relation_field_id?, filter?, sorts?, children? }`.
> Table-only in v1. Paging is over top-level rows only; per-source
> filter/sort, no cross-source sort. Access is checked per source with the
> same mechanism #469 already made canonical — and an unreadable nested
> source's branch is **absent, not visible-as-collapsed**, for the same
> disclosure reason #469 shut down relation-chip leaks. Read-only in v1.

## The shape

```ts
interface SourceNode {
  database_id: string;
  /** Required on every node except the top level, where there is no parent
   *  to have been reached through. Names WHICH relation connects this node
   *  to its parent — never inferred, so two relations between the same pair
   *  of databases isn't ambiguous (question 5). */
  relation_field_id?: string;
  /** Same shared AST as every other filter in this codebase — query.ts's
   *  filterSchema/sortSchema (packages/schemas/src/query.ts), already
   *  imported by views.ts. Not a new condition language (question 3 /
   *  #348's own note that the AST must be named as existing, not invented). */
  filter?: FilterNode;
  sorts?: SortSpec[];
  /** Nested one level per array entry — "Add level" in the reference
   *  screenshot. Absent or empty means a leaf. */
  children?: SourceNode[];
}
```

`sources: SourceNode[]` sits in `ViewConfig` next to the existing `filter`/
`sorts` (which stay meaningful for an ordinary single-database view; a
multi-source view uses per-node filter/sort instead — see below). Nothing
about #347 blocks this: `views_owner_xor`
(`apps/api/src/db/schema.ts:427`, `(database_id IS NULL) <> (space_id IS
NULL)`) already lets a view be owned by a space with no single database,
exactly the shape a multi-source view needs.

## The eight questions

### 1. Querying — batched per-parent, not one query per row

A nested level is a per-parent query, not a join — naively one query per
parent row, the same N+1 shape #250 is already named against on record
pages. Decision: fetch children in **one batched query per visible page**,
keyed by the parent ids on that page (`WHERE parent_id IN (...)`), reusing
the exact relation-link resolution `records.service.ts`'s `attachLinks` /
`relations.service.ts`'s `listLinks` already do for record-page relation
panels — not a second reader. Cap children per parent (e.g. first N, "N of M
— open the record to see the rest") rather than fetching unbounded children
in one page — 20 top-level parents × 300 children each is 6,000 rows behind
one page load, which is exactly the failure mode #250 exists to catch, not
something this spec should reproduce.

**Reconciliation with #250**: #250 is "measure first, be willing to stop
here" and hasn't built or ruled out a lazy-load/virtualization mechanism yet.
This spec doesn't invent a competing perf strategy — the batched-per-page
fetch above is the minimum correct query shape regardless of what #250
decides; if #250 ships a lazy-load primitive, nested children fetching should
adopt it rather than keeping its own.

### 2. Paging — over top-level rows only

"Page 2" means top-level rows 21–40 (Articles, say), each with its own
(capped, batch-fetched) children. Sorting by a nested child's field is **not
supported** — there is no single ordering of top-level rows that a child
field induces once a parent can have zero-to-many children, and pretending
otherwise is how this becomes unbounded scope. State this outright rather
than discover it: a per-source sort only ever orders that source's own rows,
never the parent by a property of its children.

### 3. Sorting and filtering — per source, no cross-source sort

Each `SourceNode` carries its own optional `filter`/`sorts`, evaluated
against that node's own database. Two top-level databases in one view (Article,
Glossary Term) share no field to sort by in common, so there is no
view-wide sort — the likely-honest answer the ticket itself named. The
existing shared AST (`filterSchema`/`sortSchema`, `packages/schemas/src/query.ts:87,151`,
already imported by `views.ts:3`) is what each node's `filter`/`sorts` use —
the same one `/records/query`, rollups, and dashboard tiles already share, not
a fifth condition language.

### 4. Columns — each source draws its own column set

Article and Glossary Term share no fields. Decision: each source renders its
own column set — visually two (or more) stacked mini-tables under one view,
matching the screenshot's presentation (Article's own grouping is visibly
separate from Glossary Term's own grouping, not one merged row shape). A
union-with-blanks column set was the other option and is rejected: it invents
meaningless blank cells for fields that simply don't apply to a source, and
implies a row shape ("one row, many optional columns") this data doesn't
have.

### 5. Which relation — named explicitly, never inferred

`SourceNode.relation_field_id` (required on every non-top-level node) names
the relation the child is reached through. "Nest ArticleContentFunnels under
Article" is only unambiguous when exactly one relation connects them; naming
the field id rather than inferring "the" relation is what survives a second
relation being added later without silently repointing existing views.

### 6. Access — per source, the existing mechanism, collapsed branch is ABSENT

Gate per source the same way #347's own rule set requires: resolve each
node's database against the **viewer**, dropping what they cannot read. The
mechanism already exists and is already canonical, not new: `AccessService`'s
`effectiveForDatabase` / `visibleDatabaseIds` (the fix #469 shipped, reused by
`mentions.service.ts`'s `backlinks()` for the identical leak class — "a guest
must not learn a title through a backlink").

The added ninth question — is an unreadable nested source's branch VISIBLE as
collapsed, or absent entirely — is answered by that same precedent: **absent
entirely.** A visible-but-empty branch discloses that children exist in a
database the viewer cannot see (a count, at minimum — "three funnels you
cannot see" is still a disclosure), which is exactly the class of leak #469
shut down for relation chips. The parent row itself still survives (per the
existing AC — collapse the branch, not the row), rendered indistinguishably
from a parent that legitimately has zero children through that relation. That
is a real, deliberate cost — a viewer can't tell "no children" from "children
you can't see" — but it is the SAME cost #469's fix already accepted
elsewhere in this codebase, not a new compromise invented here.

### 7. Writes — read-only in v1, stated outright

No create-record entry point from a multi-source view in v1. Creating a
record happens by opening the relevant source database directly. Saying this
outright (per the ticket's own instruction) rather than leaving it to be
discovered avoids a half-built "Add" button that only works for the top-level
source, or worse, silently writes into the wrong node of the tree.

### 8. Every other view type — table-only in v1

Board, calendar, gallery, list, feed, timeline, form, dashboard: **none of
these support a multi-source view in v1.** A view whose `config.sources` is
set is valid only when `view.type === 'table'`; the API rejects (422) any
other type carrying a `sources` config, the same posture `dashboard`'s own
single-database check already takes for a config that doesn't fit its shape —
not a silent flatten-and-hope render.

## Reconciliation with #233 (row expand/collapse)

#233 ("expand a parent row to reveal children inline") is the SAME nesting
interaction over ONE database's self-relation (Parent/Sub-items). Building
both independently guarantees two row-tree implementations — exactly the
drift pattern (#375/#380/#383/#399/#408/#422) this backlog keeps re-shipping.

**#233 owns the row-tree implementation.** Whatever component/data-shape it
produces for "a row that can expand to reveal lazily-loaded child rows,
indented, with expand-all/collapse-all" is the thing a multi-source view's
own nested levels are built FROM — each `SourceNode.children` level renders as
one more instance of #233's row-tree primitive, not a second expand/collapse
UI invented for this spec. If #233 ships first (it already has a groomed,
directly-buildable ticket; this one does not), the multi-source view's build
tickets should explicitly depend on it. If a multi-source build somehow lands
first, #233 should be re-pointed at whatever row-tree primitive it produced —
either order, there is one implementation, not two.

## Consequences

**Buys:** one view answering "the whole picture" across related databases
without opening several views side by side; reuses every existing shared
mechanism (filter AST, access resolution, `views_owner_xor`) rather than
inventing parallel ones.

**Costs:** no cross-source sort, no sort-by-nested-child-field, read-only,
table-only, and a viewer cannot distinguish "no children" from "children you
can't see" through a denied nested source — each stated here as a deliberate
v1 boundary, not an oversight, so the next person doesn't re-file it as a bug.

**Revisit this if:** #233's row-tree primitive turns out not to generalize to
a multi-source tree once someone tries to build against it (analogous to
#573's finding that #531's diagram primitive didn't generalize to a
record-level radius without a real rewrite) — in which case the split
tickets should say so explicitly rather than forcing a fit.

## References

- Ticket: #348 (spec-only) · reconciled tickets: #233 (row-tree owner), #250
  (perf strategy, not yet decided) · schema groundwork: #347
- Access mechanism reused: `AccessService.effectiveForDatabase` /
  `visibleDatabaseIds`, shipped by #469 · disclosure precedent:
  `apps/api/src/mentions/mentions.service.ts`'s `backlinks()`
- Shared filter/sort AST: `packages/schemas/src/query.ts` (`filterSchema`,
  `sortSchema`), imported by `packages/schemas/src/views.ts`
- Schema check enabling a space-owned, database-less view:
  `apps/api/src/db/schema.ts:427` (`views_owner_xor`)
- Config-cleaning precedent for a half-configured source tree: `cleanViewConfig`
  (`apps/api/src/views/views.service.ts`) — prune only dangling references,
  per #305's unconfigured-is-not-invalid rule
