# ADR-0020: Multi-source boards — a view names its sources, owns one column set, and maps each source into it

- **Status:** proposed (2026-10-27). Needs Ievgen's approval and a priority before any build ticket is split (ticket #951, AC3). The five open questions at the end have a recommendation each.
- **Ticket:** #951 (ADR first). Design input: Dara's views-at-scale design.
- **Amends:** [`multi-source-views.md`](../architecture/multi-source-views.md) (#348), sections 4, 7 and 8, **for the board case only**. Everything else in #348 stands, and this reuses its `sources: SourceNode[]` shape rather than inventing a second one.
- **Builds on:** [ADR-0005](ADR-0005-record-ordering.md) (one position per database), [ADR-0011](ADR-0011-workflow-state-field.md) (workflow categories), [ADR-0018](ADR-0018-restricted-spaces-and-databases.md) (hidden completely), [views-and-the-sidebar](../architecture/views-and-the-sidebar.md) (the space is the door, each source is the room).

## Context

Ievgen asked where a view lives once it draws on three databases, and what a board over `Tasks.State`, `Bugs.Status` and `Requests.Stage` looks like. Where it lives is already answered: `views_owner_xor` (`apps/api/src/db/schema.ts`) lets a view belong to a space instead of a database, and a dashboard tile already names its own `database_id` (`packages/schemas/src/views.ts`). The hard part is the **columns**.

What is true today, checked against main on 2026-10-27:

- **A multi-source design exists and nothing of it is built.** #348 describes a nested **table**: a parent source with children reached by relation, each source drawing its own column set, "union-with-blanks rejected", **read-only**, **table-only** ("board … none of these support a multi-source view in v1"). `sources` is not in `ViewConfig`. #951 is the opposite shape: a flat **board** with one column set shared by every source, and a write path. #348 excludes it explicitly, so this ADR amends #348 rather than contradicts it.
- **A board is per database.** It groups by one `group_by_field_id`, and `boardGroupError` (`views.service.ts`) restricts that to single-valued fields. A drag is `POST …/records/:rec/move` with `values: { <group field>: <option id> }` and a `view_id`, handled by `RecordsService.move`, which writes through the ordinary update path (validation rules, history, the `source` badge, automations).
- **Option ids belong to one field.** `select_options.field_id`. `Tasks.State`'s "Done" and `Bugs.Status`'s "Closed" are unrelated rows. A **workflow** field's options also carry a `category` (`backlog | unstarted | started | completed | canceled`, ADR-0011, #1014), the one vocabulary that is already shared across databases.
- **Order is per database** (ADR-0005): `records.position` is a fractional index within one database. Two databases' positions are not comparable.
- **Access is per source.** `AccessService.effectiveForDatabase` returns null for a database the viewer cannot read; ADR-0018 decision (b) says a restricted resource is hidden completely, and `views-and-the-sidebar.md` says a view with zero readable sources says so instead of 404ing or showing an empty grid.
- **A board's counts and page are computed server-side per database** (`/records/aggregate/grouped`, `/records/query`), and the web composes them. That composition cannot be repeated by every client once several databases and a mapping are involved.

Decisions already made (Otto, 2026-10-17), kept as written: **no mapping, no guessing** (a source with no mapping is reported on the board, never silently dropped), and **"+ New" uses a view-declared default source, with the + menu offering the others.**

## Decision

### 1. A view names its sources; `database_id` is the shorthand

A multi-source board is a **space-owned** view (`database_id` null, `space_id` set; `views_owner_xor` already allows it, no migration) whose `config` carries #348's `sources: SourceNode[]`. A single-source view is unchanged: `database_id` is the one-source shorthand, and a view never has both (the API rejects `sources` on a view that has a `database_id`, 422, for the same reason the XOR check exists: one home, one answer).

For a **board**, `sources` is flat in v1 (no `children`; that is #348's table tree). Each node gains four fields beside #348's `database_id`, `filter` and `sorts`:

```ts
interface BoardSource extends SourceNode {
  group_field_id: string;      // THIS source's column field: a select or workflow field of this database
  columns: Record<ColumnId, { option_ids: string[]; write_option_id?: string }>;  // the mapping, see §2
  default?: true;              // the "+ New" default; at most one source, or none
}
```

The view's `config` also owns `columns: Array<{ id: string; label: string; color?: string }>`: the board's one column set, in the view's own order. Column order, hiding and sorting (#427/#428) stay properties of the **view**, never of a source's options.

### 2. One column set; each source maps into it, in both directions

The view owns the columns. Each source says which of **its own options** belong in which column.

- **Reading** (option → column): a card lands in the column its option is mapped to. **Several options may map to one column** (`Tasks`' "In Review" and "QA" both under "Review"). An option is mapped to **at most one** column.
- **Writing** (column → option): a drag into column C writes the source's `write_option_id` for C. If exactly one option is mapped to C, that is the write option; if several are, the mapping **must name** `write_option_id`, and without it that source **cannot be dragged into C** (reads fine). If **no** option is mapped to C for that source, the drop is refused for that card. Nothing is ever guessed, and **no option is ever created** by a drag.
- **Unmapped options** (a source option that no column claims) put their cards in one reserved, non-deletable **Unmapped** column, the same way the board's no-value bucket works today (`NO_VALUE`). Dragging out of Unmapped into a real column works; dragging **into** it is refused.
- **No value** in the group field uses one shared "No value" column across sources, with the existing meaning: dragging in clears the field, subject to that source's validation rules.
- **Suggestions are advisory.** A pure function in `packages/schemas` (so web and MCP share one) proposes a mapping: same `category` first (ADR-0011), then a case-insensitive label match. It is shown to the person to confirm, **never stored or applied by itself.**
- **v1 groups only by `select` and `workflow` fields.** Those are the types with options to map. Date, user, relation, number-bin, text and lookup boards have no defined mapping and stay single-source.

A source with **no mapping at all** is reported on the board ("Bugs is not mapped: its 42 cards are not shown"; the count comes from the grouped aggregate), never dropped silently. A source that is **gone** (database deleted) is reported as unavailable until someone removes it. **Dangling references** (a deleted option or field inside a mapping) are reported, never thrown and never silently pruned, #305's rule: unconfigured and half-configured is not invalid. A **new** save, by contrast, is validated strictly (§5).

### 3. The server resolves the move; the client never does

The mapping lives on the view, so the **server** resolves it. Web, MCP and the API each re-implementing "which option does this column mean for this source" is exactly the drift `field-surfaces.md` was written about.

```
POST /workspaces/:ws/views/:view/move
  { record_id, source_database_id, to_column_id }
```

It resolves `write_option_id` for `(source, column)` and then calls the **same** `RecordsService` update the single-source board uses. So validation rules, state gates, version history, the `source` badge and automations all behave exactly as for any other edit, and the change history shows each source's own field change ("Status: In Review → Done" in Tasks, "State: QA → Closed" in Bugs). There is no second write path and no new log. Errors, all 4xx with the standard envelope: `no_option_mapped` (names the source and the column), the validation-rule refusal unchanged, 404 for a source the caller cannot read, 403 for a source they can read but not edit.

**Ordering inside a column is not manual in v1.** `position` is per database (ADR-0005), so there is no order a drag across sources could mean. A drop sets the column only; it does not reorder. Cards in a column are ordered by the view's sort (§6), else by source order and then each source's own position.

**"+ New"**, per the 2026-10-17 decision: `POST /workspaces/:ws/views/:view/records { source_database_id?, column_id, values }`. Omitting the source uses the view's `default` source; the + menu lists only sources the caller can **write**. The group field is set through the same `write_option_id` resolution, with the same refusal if the chosen source has no option for that column.

### 4. What a viewer sees when they can read only some sources

The rule is #348 §6 and ADR-0018 (b), applied per source: **the space is the door, each source is the room.**

- The door is `visibleSpaceIds` and `canSeePersonal`, **never `assertSpace`** (a guest holding a database-scoped grant sees the space but fails `assertSpace`). Then each source is resolved against the **viewer** with `effectiveForDatabase`, which returns null instead of throwing, so one unreadable source cannot collapse the view.
- **An unreadable source is absent entirely**: its cards, its counts, its mapping node, and any notice about it. The server **strips the node from the config it returns to that viewer.** Saying "3 sources you cannot see" would disclose that they exist, the leak #469 closed for relation chips. Configuration problems (unmapped, unavailable) are reported only for sources the viewer **can** read.
- **Columns are the view's, not a source's data**, so they are shown to everyone who can open the view. Counts include readable sources only.
- **Zero readable sources:** say so ("you don't have access to any source of this view"), never 404, never an empty grid.
- **Editing the config merges, it never replaces.** A non-admin who edits mappings only holds the nodes they can see; a PATCH built from their copy would delete every source they cannot read. The server **preserves nodes the caller cannot read** on save. Adding a source requires being able to read it. Admins see all (ADR-0018 (a)).
- **Per card, per source:** each card carries `can_move`, computed from `effectiveForDatabase`, so the UI can disable the handle. It is a hint; the enforcement is the update path in §3.

### 5. Validation at save, and on read

At **save** (strict): `sources` only with a null `database_id`; every `database_id` in this workspace; `group_field_id` a live `select`/`workflow` field of that database; every `option_id` belongs to that field; no option mapped to two columns; `write_option_id` is one of the column's `option_ids`; column ids unique; at most one `default`. At **read** (lenient): problems become reported notices, as in §2.

### 6. Filters and sorts across schemas

- Each source keeps its own `filter` and `sorts`, evaluated against its own schema with the shared AST (#348 §3). That is where any real field filter lives.
- A **view-level** filter or sort is allowed **only on fields every database has**: the system fields (`created_at`, `updated_at`, `created_by`, `updated_by`, `id`) and the title. They are compiled per source. Anything else is a per-source filter. There is **no** attempt at "assignee" across `Tasks.Owner` and `Bugs.Reporter`.
- A view-level sort on a system field merges the sources' streams into one ordered column (a k-way merge over per-source keyset cursors, bounded per column and per source, with "load more" per column). Without one, columns are in source order.

### 7. What the API and MCP expose

- **Config:** `sources` and `columns` are validated by a zod schema in `packages/schemas` (the shared home), so `create_space_view` / `update_space_view` accept them through the existing `config` with no new tool.
- **Read:** one composed read, `GET /workspaces/:ws/views/:view/board`, returning the columns (each with its true count, cards tagged with their source, `can_move`, and a cursor), the per-source status (`ok | unmapped | unavailable`, unmapped count) for sources the caller can read, and the notices. The merge, the mapping and the per-viewer filtering happen **once, on the server**, so the web and an AI see the same board.
- **Write:** `POST …/views/:view/move` and `POST …/views/:view/records` (§3).
- **MCP:** `get_board`, `move_card` and `create_card`, shipped **in the same build PR** as the endpoints, with entries in `coverage.ts` otherwise (#397). Descriptions state the mapping semantics (a move names a column, never an option) and that the list of sources reflects the caller's access.
- **No migration:** `views.config` is jsonb and `views_owner_xor` already allows the owner. This is a schema (zod) and service change.

### 8. What is NOT supported in v1

Each of these is a deliberate boundary, so nobody re-files it as a bug:

- **Nested sources on a board** (#348's parent/child tree stays table-only), and **every view type other than table (nested, #348) and board** over several sources.
- **Group fields other than `select` and `workflow`**; a date, user or relation board across schemas.
- **Manual reorder** inside a column, **dragging a card to another source**, and bulk drag.
- **Personal multi-source views** (a personal view is a lens on one shared database, `personal-space.md`) and **public sharing** of one (`computePublicFieldAllowlist` is per database; `share()` must refuse it with a 422).
- **View-level filters or sorts on non-system fields**, and any "union" of two sources' fields into one filter.
- **Creating options from a drag**, auto-mapping that is applied without the person confirming it, and syncing the *labels* of options across sources (mapping is by option **id**, so renaming an option changes nothing).

## Consequences

**Buys.** One board over several databases with real two-way writes; no new write path (a move is an ordinary record update by the person, so rules, history, automations and the access check all apply unchanged); no migration; the same shapes (`sources`, the filter AST, `effectiveForDatabase`, the view owner XOR) rather than a parallel set; one server-side resolution for web, MCP and the API.

**Costs.** A mapping to author and keep honest as options change (reported, never auto-fixed); no manual order and no cross-source sort except by system fields; a view author with partial access edits through a merge, which is more server logic than replace; a viewer cannot tell "no cards" from "cards in a source you cannot see", the same deliberate cost #348 §6 already accepted.

**Escape hatch.** A single-source board is untouched. If the mapping model proves too heavy, the fallback is #348's stacked per-source tables, which need none of it.

**Revisit this if** a per-view manual order is ever built (ADR-0005's own upgrade path): order across sources then has a meaning and §3's "no manual reorder" can lift; or if a real use needs a non-select grouping across schemas.

## Open questions, with a recommendation each

1. **Is "Unmapped" a visible column or a hidden one?** *Recommend visible and non-deletable*: the no-mapping rule is "reported, never dropped", and a hidden column drops cards by another name.
2. **May a multi-source board have a single source?** *Recommend yes.* It is just a space-owned board, and forbidding it would make "remove the second source" a trap.
3. **Is a view-level filter on system fields worth it in v1?** *Recommend yes for `created_at`/`updated_at`/title only*, since "what changed this week" is the first question anyone asks of a board over three databases. Cut it first if scope is tight.
4. **One composed read endpoint, or client composition like today?** *Recommend the composed read.* The merge, the mapping and the per-viewer stripping cannot be repeated per client without the drift this repo keeps re-shipping.
5. **Does this supersede #348 or amend it?** *Recommend amend.* #348's nested table is a different and still-wanted shape.

## References

- Tickets: #951 (this) · #348 (the nested-table design this amends) · #233 (row tree) · #555 (cited by the ticket for "report, never drop"; note the public-view code under that number silently DROPS a stale reference on read, rather than throwing, and this ADR deliberately does not copy that: a board that quietly shows fewer cards is wrong, so a problem is reported) · #305 (unconfigured is not invalid) · #427/#428 (column order and hiding live on the view) · #469 (the disclosure rule) · #1014 (workflow categories) · #397 (MCP parity)
- Code: `RecordsService.move`, `boardGroupError`, `boardGroupIsReadOnly` (`apps/api/src/records/records.service.ts`, `apps/api/src/views/views.service.ts`) · `AccessService.effectiveForDatabase` · `ValidationEnforcer` · `select_options.category` (`apps/api/src/db/schema.ts`) · `views_owner_xor` · `packages/schemas/src/views.ts` · `apps/web/src/components/views/board-columns.ts` (`NO_VALUE`)
