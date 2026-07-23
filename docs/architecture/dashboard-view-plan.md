# Dashboard view: scoping doc

Status: **plan only — no dashboard view, widget, or chart-rendering code
ships from this doc** (#168 / MN-225). The ticket's own framing is explicit:
"PLANNED NOW, DELIVERED LATER per founder" and "Scope (plan-level)". This
mirrors #282's split-screen scoping pass — an interaction/data-model design
and an integration plan against the *existing* filter/rollup/permission
machinery, with implementation deliberately deferred to follow-up tickets
(§6).

Related: #17 (lookup/rollup foundation), #295 (filtered rollups, merged
tonight — see §1), MN-218/#160 (Business Packs), MN-104 (superadmin overview,
`apps/api/src/admin/admin-overview.service.ts` — a special case of this same
"aggregate across records into a summary surface" shape, run at a different
privilege level).

## 1. Prerequisite check: is rollup completion actually satisfied now?

**Yes — verified against the current code, not assumed from the ticket
text.** The ticket's prerequisite note ("rollups are partial ... sum/count/
avg/min/max over relations") predates tonight's #295 (filtered rollups) work
and, per commit history, predates rollup completion generally.

Evidence:

- `packages/schemas/src/fields.ts` — `rollupConfigSchema`:

  ```ts
  export const rollupConfigSchema = z.object({
    relation_field_id: z.uuid(),
    op: z.enum(['count', 'sum', 'avg', 'min', 'max']),
    target_field_api_name: z.string().trim().min(1).nullish(),
    filter: filterSchema.optional(),
  });
  ```

  All five ops the ticket names — `count`, `sum`, `avg`, `min`, `max` — are
  live in the schema today, plus the MN-295 `filter` extension (an optional
  condition, compiled with the *same* `filterSchema`/`compileFilter` as saved
  views, scoping the aggregate to only the linked records that match).

- `apps/api/src/records/records.service.ts`:
  - `attachRollups()` (read-time, per fetched page) and
    `computeRollupValuesForChunk()` (write-time materialization, used by
    `recomputeRollupsForRelationField()`) both switch on
    `op: 'count' | 'sum' | 'avg' | 'min' | 'max'` and build one grouped SQL
    aggregate per rollup field per chunk — never N+1 per record. `count`
    branches on `recordLinks` row counts; `sum`/`avg`/`min`/`max` cast the
    target field's JSON value to `numeric` and aggregate it in Postgres.
  - Both attach the optional MN-295 filter into the join's `ON` clause (or
    the `WHERE`, in the write-time path) before aggregating, so a filtered
    rollup never pulls unfiltered rows into JS to filter after the fact.
  - Rollups are kept fresh on relation membership change and on the related
    record's own field changing (`RollupInvalidationSubscriber`, MN-267/
    MN-287), and formulas that read a rollup re-materialize in the same
    pass — so a dashboard reading `computed_values` gets numbers that are
    already correct as of the last write, not numbers requiring a
    dashboard-side recompute.

**Conclusion: the stated prerequisite is done.** A dashboard's rollup/KPI
widgets can be built directly on today's rollup system with no additional
aggregation-engine work. This *doesn't* mean dashboards need nothing new —
see §2 for the one gap dashboards do need (ad hoc group-by aggregation that
isn't a saved field on any database) — but the specific blocking item the
ticket named is resolved.

## 2. Widget model

Four widget kinds, per the ticket's acceptance criteria, each a **thin
presentation layer over a query**, not a new query engine:

| Widget | Data need | Reuses |
|---|---|---|
| KPI / number card | One aggregate over one database, optionally filtered | `filterSchema` (view/query AST) + either an existing rollup/formula field's materialized value, or a new one-off aggregate endpoint (see below) |
| Bar / line / pie chart | Grouped aggregate: one metric, grouped by a field (select, date-bucketed, or relation) | Same query shape as a board view's `group_by_field_id` grouping, extended with an aggregate instead of a raw list |
| Grouped table | Records grouped by a field, each group showing rows or per-group rollups | `viewConfigSchema`'s existing `group_by_field_id` + `filters` + `sorts`, unmodified — this widget is close to a read-only embed of a board/table view's grouping logic |
| Recent-records list | Filtered + sorted record list, capped to N | `POST /records/query` verbatim — `filterSchema`, `sortSchema`, a `limit` — no new surface at all |

### 2.1 Query reuse, concretely

Every widget's config is `{ database_id, filters?: FilterNode, ...widget-specific knobs }`.
None of them invent a second condition language:

- **Filters** are `packages/schemas/src/query.ts`'s `filterSchema` — the
  exact AST already shared between saved views and `POST /records/query`
  (ADR-0003). A KPI widget's "count of Deals where Stage = Won this month"
  is the same `FilterNode` a saved view's filter chip would hold.
- **Rollups already computed on a database** (e.g. a `sum` rollup field
  existing on a Deals table) are the cheapest path for a KPI widget: read
  the materialized `computed_values` column directly, no query-time
  aggregation at all. This is the common case for "pull a number that's
  already a field."
- **Grouped charts and the grouped-table widget** need one thing rollups
  don't provide today: an ad hoc `GROUP BY <field> aggregate(<field>)`
  over a database's own records (not over a *related* database through a
  relation, which is what rollup already does). This is new server surface,
  but a narrow one — call it `POST /records/aggregate` in the follow-up
  ticket (§6): same `filterSchema` input as `/records/query`, a
  `group_by: field api_name` and `metric: {field, op}` in place of
  `sorts`/pagination, implemented with the same one-grouped-SQL-query
  discipline `computeRollupValuesForChunk` already establishes (never N+1,
  never fetch-then-aggregate-in-JS). It is a sibling of `/records/query`,
  not a parallel system — it compiles the same `FilterNode` with the same
  `query-compiler.compileFilter`, just projects through a `GROUP BY`
  instead of row selection.
- **Recent-records list** needs nothing new: it's `/records/query` with a
  `limit` and the widget's own filter/sort, exactly as a saved view's data
  fetch works today.

This keeps "dashboard" a *rendering* concept — a grid of widget configs, each
naming a database + filter + (for grouped widgets) a group-by/metric pair —
layered on the query/rollup machinery that already exists, rather than a
dashboard-specific data layer that would inevitably drift from view/rollup
semantics the first time someone fixed a filter-op bug in one place and not
the other.

### 2.2 Dashboard view config shape (illustrative, not a commitment)

```ts
// packages/schemas/src/views.ts — illustrative addition, NOT implemented here
dashboard_widgets: z.array(z.object({
  id: z.uuid(),
  kind: z.enum(['kpi', 'chart_bar', 'chart_line', 'chart_pie', 'grouped_table', 'recent_list']),
  title: z.string().max(100),
  database_id: z.uuid(),              // the database this widget queries
  filters: filterSchema.optional(),   // SAME AST as every other filter
  // kpi:
  metric: z.object({ field_api_name: z.string().optional(), op: z.enum(['count','sum','avg','min','max']) }).optional(),
  // chart_*/grouped_table:
  group_by_field_id: z.uuid().optional(),
  // recent_list:
  sorts: z.array(sortSchema).max(3).optional(),
  limit: z.number().int().min(1).max(100).optional(),
  layout: z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() }), // grid position
})).default([]),
```

`dashboard` would join `viewTypeSchema`'s existing
`['table','board','calendar','gallery','list','feed','timeline','form']` as
an eighth entry. Each widget is one entry in this array; the dashboard view
itself holds no filter/sort of its own (unlike other view types) — every
widget owns its own query, because a dashboard's whole point is showing
several different slices at once, not one filtered list of one database.

## 3. Permission model: how widgets stay inside a viewer's grants

Read `apps/api/src/access/access.service.ts` (`AccessService`) and how
`apps/api/src/records/records.controller.ts` and
`apps/api/src/views/views.controller.ts` use it. The model is simpler than
row-level security and dashboards should not invent anything past it:

- **Grants are scoped to a space or a database, not to individual records.**
  `AccessService.effectiveForDatabase(membership, database)` returns one of
  `viewer | commenter | contributor | editor | creator | admin | null` (ADR-0007's
  graded ladder — never a capability matrix), and every records/views
  endpoint calls `databases.assertAccess(membership, databaseId, min)` (which
  wraps `effectiveForDatabase` + `assertRank`) **before** running any query
  against that database. There is no per-record filter beyond that — access
  control here is "can you see this database at all, at what rank," not "which
  rows of this database can you see."
- **This means a dashboard widget's permission check is a database-level
  gate applied once per widget, at render time** — not a row-level filter
  folded into the aggregate SQL. Concretely: when a dashboard view is
  fetched, for each widget the server calls the same
  `effectiveForDatabase`/`assertRank(..., 'viewer')` check the record-query
  endpoints already make against that widget's `database_id`, using the
  *requesting* user's membership (not the dashboard view's owner). A widget
  whose database the viewer has no grant for either omits itself from the
  response (silent, matching `guestVisibility`'s list-filtering behavior
  used elsewhere) or renders a "no access" placeholder — a UX call for the
  follow-up ticket, not a new access primitive.
- **No new permission concept is needed.** Because the ladder is
  database/space-scoped and dashboards only ever aggregate *within* a
  database a widget names, "a viewer only sees what their grants allow" is
  satisfied by gating widget rendering the same way page rendering is
  already gated — reusing `AccessService.effectiveForDatabase` per widget,
  not inventing row-level ACLs or a dashboard-specific grant type.
- **Cross-referenced precedent:** `apps/api/src/admin/admin-overview.service.ts`
  (MN-104) is the one place that already aggregates *across* records for a
  summary surface — but it deliberately does not go through
  `AccessService.effectiveForDatabase` per workspace, because it's a
  superadmin-only, cross-workspace view where the ladder doesn't apply (its
  own doc comment: "first cut — read-only ... AccessService has no bulk
  variant yet"). Dashboards are the opposite case — single-workspace,
  per-viewer-scoped — so they should call the existing per-database check
  directly, not adopt MN-104's superadmin bypass.

## 4. Business Pack manifest: reserving a dashboards slot

`packages/schemas/src/packs.ts`'s `packManifestSchema` already has the
pattern to mirror: the `skills` field, reserved tonight (#250) for #40:

```ts
/**
 * Reserved for #40. **Nothing populates or reads this yet.**
 * ...
 * TODO(#40): give this an element schema and wire export/install, at which
 * point `PackAgent.skills` becomes a ref list into it.
 */
skills: z.array(z.unknown()).default([]),
```

**Recommendation: add a `dashboards` field to `packManifestSchema` in the
same reserved, unpopulated shape**, once dashboards ship (do not add it
speculatively in this scoping doc — only when the dashboard view type and
its widget schema are real, so the reservation's future element type is
known rather than guessed):

```ts
/**
 * Reserved for #<dashboard-view-type ticket, filed from #168>.
 * Nothing populates or reads this yet.
 *
 * Once the dashboard view type exists, a pack's dashboards are just
 * `packViewSchema` entries with `type: 'dashboard'` — views ALREADY have
 * a slot (`views: z.array(packViewSchema)`), so this reservation may turn
 * out to be unnecessary the same way a new view type never needed its own
 * top-level manifest array. Confirm this before wiring: if
 * `packViewSchema`'s existing `config: jsonObjectSchema` already carries a
 * dashboard's `dashboard_widgets` array through ref-rewriting unchanged
 * (likely, since it's schema-agnostic JSON), no new field is needed at
 * all — only the widget configs' own field/relation ids need
 * `PACK_REF_PATTERN` refs, exactly as board's `group_by_field_id` already
 * gets one.
 */
```

This is a slightly different recommendation than a literal copy of the
`skills` pattern: `skills` needed a *new* top-level array because no Skills
concept existed anywhere in the manifest yet. Dashboards, being *a view
type*, likely fold into the **existing** `views: z.array(packViewSchema)`
slot for free — `packViewSchema.type` is already `viewTypeSchema` (open to
whatever view types exist) and `config` is already an opaque
ref-rewritable JSON blob. The follow-up ticket that adds the `dashboard`
view type should verify this rather than assume a new manifest field is
needed; if it *is* needed (e.g. widgets reference fields across multiple
databases in a way `packViewSchema`'s single `database: nameSchema` doesn't
model), that's exactly when a reserved `dashboards` field earns its keep,
following the `skills` precedent above.

## 5. Out of scope (v1), restated from the ticket

- Cross-workspace dashboards.
- Scheduled email digests of dashboard contents.
- Row-level/record-level permission scoping within a widget's aggregate
  (dashboards inherit the database-level ladder as-is; no new primitive).

## 6. Follow-up implementation tickets this plan would unblock

Enumerated, not built. Suggested filing order (each depends on the one
before it landing, except where noted):

1. **Dashboard view type — schema + CRUD.** Add `'dashboard'` to
   `viewTypeSchema`, add `dashboard_widgets` (§2.2) to `viewConfigSchema`,
   wire `ViewsController`/`ViewsService` validation (widget `database_id`s
   exist, `group_by_field_id`/`metric.field_api_name` resolve against that
   database's live fields — same validate-against-live-schema discipline
   `createViewSchema` already applies to `group_by_field_id` etc.).
2. **`POST /workspaces/:ws/databases/:db/records/aggregate`** — the one new
   query primitive from §2.1: `{ filters, group_by, metric: {field, op} }`
   → grouped aggregate rows, same `compileFilter` as `/records/query`, one
   SQL query per request (no N+1). Depends on nothing above; could land
   first and independently.
3. **Dashboard widget rendering — web.** A widget-grid layout component
   (`apps/web`), one renderer per widget kind (KPI number, bar/line/pie via
   whatever charting lib the web app already uses if any, grouped table,
   recent list), each calling `/records/query` or the new `/aggregate`
   endpoint per widget. Depends on #1 and #2.
4. **Per-widget permission gating.** Wire §3's per-widget
   `effectiveForDatabase`/`assertRank('viewer', ...)` check into the
   dashboard-fetch path, plus the omit-vs-placeholder UX decision for a
   widget the viewer can't see. Depends on #1.
5. **Dashboard widget editor UI.** Add/remove/resize/reconfigure widgets in
   a dashboard view (the create/edit-time counterpart to #3's read path).
   Depends on #1 and #3.
6. **Pack manifest reservation for dashboards** (§4) — filed only once #1
   is far enough along to know whether it needs a new `dashboards` field or
   folds into `views`. Likely a small addendum to whichever ticket adds
   pack support for the new view type, not a standalone ticket.
7. **(Later, explicitly out of v1) Scheduled dashboard digests** — email a
   rendered dashboard snapshot on a schedule. Would reuse the `schedule`
   automation trigger (`automationTriggerSchema`'s `every`/`at`/`weekday`)
   and the existing Resend mailer (`send_email` action, MN-256) rather than
   inventing new scheduling or email infrastructure — noted here so the
   follow-up ticket doesn't have to re-derive it, but explicitly not filed
   now since the ticket marks it out of scope for v1.
8. **(Later, explicitly out of v1) Cross-workspace dashboards.** Not filed;
   flagged only so it isn't silently forgotten as a v2 idea.
