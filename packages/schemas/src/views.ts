import { z } from 'zod';
import { formVisibilityRuleSchema } from './form-visibility';
import { filterSchema, nullsPlacementSchema, sortSchema } from './query';

export const viewTypeSchema = z.enum([
  'table', 'board', 'calendar', 'gallery', 'list', 'feed', 'timeline', 'form', 'dashboard',
]);
export type ViewType = z.infer<typeof viewTypeSchema>;

/**
 * Dashboard metric tile (MN-225 / #168, Phase 1 — KPI tiles only; charts deferred).
 * Each tile is ONE aggregate over the database's own records, reusing the same
 * op set as `rollupConfigSchema`. `op: 'count'` counts records and ignores
 * `field_api_name`; sum/avg/min/max aggregate the numeric values of the target
 * field (referenced by api_name, the same way filters/sorts reference fields).
 */
/**
 * Where a dashboard block sits, and how big it is (#386).
 *
 * A 12-column grid — divisible by 2, 3, 4 and 6, so halves, thirds and quarters
 * are all expressible without fractions.
 *
 * **THE DECISION (#386 asks for it to be recorded): flow order + span, not free
 * x/y.** A block declares how many columns and rows it occupies and where it
 * comes in one ordered sequence; the grid flows them. It does NOT declare an
 * absolute cell.
 *
 * Free x/y is what a "real" dashboard builder looks like, and it was rejected on
 * one ground: it makes OVERLAP representable. Two blocks can be dropped on the
 * same cell, and the only defences are a packing algorithm that shoves
 * neighbours around (surprising — you move one tile and three others jump) or a
 * validator that silently refuses the drop (a drag that does nothing reads as
 * broken). Both are worse than the constraint. Flow order makes an overlapping
 * dashboard *unrepresentable*, so there is no state to handle, no packing pass,
 * and no way to save a layout that renders as a pile.
 *
 * What flow order costs: you cannot leave a deliberate gap. That is a real
 * limitation and worth revisiting if anyone asks for it — nobody has, and #384's
 * complaint was that everything is the same size in creation order, which this
 * fixes completely.
 *
 * What it buys beyond safety: `order` is one sequence across BOTH tiles and
 * widgets, which is what lets a chart sit beside the number it explains. The two
 * arrays survive as storage; the render merges them. So the old structural rule
 * ("all charts below all tiles") is gone with no migration.
 *
 * **Optional, and absent means source order at default size.** A dashboard saved
 * before #386 renders exactly as it did — the same backward-compatibility shape
 * #304 used for `database_id`, and #305's rule that unconfigured is not invalid.
 */
export const blockLayoutSchema = z.object({
  /**
   * Position in the single merged sequence. Ties break by the pre-#386 rule
   * (all tiles, then all widgets, each in array order), so a dashboard where
   * only SOME blocks have been arranged is still fully determined.
   */
  order: z.number().int().min(0),
  /** Width in columns, 1-12. */
  w: z.number().int().min(1).max(12),
  /** Height in rows, 1-6. A row is a tile's natural height. */
  h: z.number().int().min(1).max(6),
});
export type BlockLayout = z.infer<typeof blockLayoutSchema>;

/**
 * What a number is measured AGAINST (#388).
 *
 * "383" is not information; "383, up from 340 last week" is. Two devices cover
 * it, and the target ships first deliberately: it is a single number in the
 * config, needs no time-series reasoning, and covers the common case ("we want
 * 20 leads this month"). A period comparison is the better feature and the
 * larger one — it needs a date field, a second query, and a decision about what
 * "the previous period" means for an already-filtered tile.
 */
export const tileComparisonSchema = z.object({
  /** The number this tile is aiming at. */
  target: z.number().optional(),
  /**
   * Which direction is GOOD.
   *
   * Not inferable, and getting it wrong is worse than saying nothing: more
   * revenue is good, more overdue invoices is bad, and a confidently green
   * "overdue up 40%" actively misleads. Defaults to `up`, which is the common
   * case AND is stated in the UI so the assumption is visible rather than
   * silent.
   */
  direction: z.enum(['up', 'down']).default('up'),
});
export type TileComparison = z.infer<typeof tileComparisonSchema>;

export const dashboardTileSchema = z.object({
  id: z.uuid(),
  label: z.string().trim().max(100).default(''),
  op: z.enum(['count', 'sum', 'avg', 'min', 'max']),
  /** Required for sum/avg/min/max; omitted (ignored) for count. */
  field_api_name: z.string().trim().min(1).max(100).optional(),
  /**
   * #304 — this tile's OWN scope, ANDed with the view's filter. Without it every
   * tile on a dashboard necessarily shows the same number, which is what made the
   * feature useless ("I can't select what to show. Except for how to aggregate").
   * Same filter AST as views / /records/query / rollups — never a second language.
   */
  filter: filterSchema.optional(),
  /**
   * #304 — the database this tile measures. Omitted = the view's own database,
   * which is how every dashboard saved before this keeps working with no config
   * migration. A #306 space-level dashboard has no view database, so a tile there
   * with no `database_id` is UNCONFIGURED (render the picker) — not invalid, and
   * never garbage-collected (#305's rule).
   */
  database_id: z.uuid().optional(),
  /** #386 — where this tile sits. Absent = source order (pre-#386 dashboards). */
  layout: blockLayoutSchema.optional(),
  /** #388 — a target to measure the number against, so it supports a decision. */
  comparison: tileComparisonSchema.optional(),
});
export type DashboardTile = z.infer<typeof dashboardTileSchema>;

/**
 * Dashboard chart / grouped-table widget (MN-225 / #168, Phase 2).
 *
 * A widget produces ONE series of {group, value} by grouping the database's own
 * records by a select/category/date field (`group_by_field_api_name`) and
 * aggregating each group with `measure` (count, or sum/avg/min/max of a number
 * field). The series is rendered as a bar/line/pie chart or a grouped table.
 * Records are pulled through the SAME grant-scoped `/records/query` path as
 * metric tiles, so a widget only ever aggregates records the viewer can access.
 * Fields are referenced by api_name (same as tiles/filters/sorts); grouping is
 * computed client-side.
 *
 * #367 — a widget names its own `database_id` and `filter`, exactly as a tile has
 * since #304. A widget on the view's own database is scoped by the view's filter;
 * a CROSS-DATABASE one is scoped by its own filter alone, because the view's
 * filter names the view database's fields.
 */
export const dashboardWidgetSchema = z.object({
  id: z.uuid(),
  type: z.enum(['bar', 'line', 'pie', 'grouped_table']),
  title: z.string().trim().max(100).default(''),
  /** Field whose value groups records into series buckets (select/date/etc.). */
  group_by_field_api_name: z.string().trim().min(1).max(100).optional(),
  /** How each group's records are aggregated into a single value. */
  measure: z
    .object({
      op: z.enum(['count', 'sum', 'avg', 'min', 'max']),
      /** Required for sum/avg/min/max; omitted (ignored) for count. */
      field_api_name: z.string().trim().min(1).max(100).optional(),
    })
    .default({ op: 'count' }),
  /**
   * #367 — this widget's OWN scope, ANDed with the view's filter. Same filter AST
   * as views / /records/query / rollups / tiles — never a second language.
   */
  filter: filterSchema.optional(),
  /**
   * #367 — the database this widget measures. Omitted = the view's own database,
   * which is how every dashboard saved before this keeps working with no config
   * migration. A #306 space-level dashboard has no view database, so a widget
   * there with no `database_id` is UNCONFIGURED (render the picker) — not
   * invalid, and never garbage-collected (#305's rule).
   *
   * #304 gave TILES these two fields and deliberately withheld them from widgets,
   * because a declared-then-ignored field is worse than a missing one. They are
   * added here together with the render path that honours them.
   */
  database_id: z.uuid().optional(),
  /**
   * #386 — where this widget sits, on the SAME grid as the tiles.
   *
   * This is what lets a chart sit BESIDE the number it explains. The two arrays
   * survive as storage, but they are rendered into one grid, so the old
   * structural rule ("all charts below all tiles") is gone without a migration.
   */
  layout: blockLayoutSchema.optional(),
});
export type DashboardWidget = z.infer<typeof dashboardWidgetSchema>;

/**
 * A view is a SAVED PRESET: the client reads the config and sends the full
 * query to /records/query itself — the server stays dumb (MN-020 decision).
 * Filters/sorts reference fields by api_name (same AST as the query API);
 * structural knobs reference fields by id.
 */
export const viewConfigSchema = z.object({
  filters: filterSchema.optional(),
  sorts: z.array(sortSchema).max(3).default([]),
  /**
   * Whole-sort empty-values placement (MN-252) — where NULL/empty sort values
   * land, applied uniformly across every key in `sorts` (the toolbar exposes it
   * as a single "Empty values: Top / Bottom" toggle, not a per-row setting). It
   * is forwarded to /records/query as the top-level `nulls`. Omitted = 'last',
   * i.e. the pre-MN-252 default, so old saved views compile unchanged.
   */
  sorts_nulls: nullsPlacementSchema.optional(),
  hidden_field_ids: z.array(z.uuid()).default([]),
  /** Board only — must reference a single-select field (v1). */
  group_by_field_id: z.uuid().optional(),
  /**
   * #307 — when `group_by_field_id` points at a DATE field, this is the period each
   * board column covers. Ignored for every other group-by type.
   */
  group_by_granularity: z.enum(['week', 'month', 'quarter', 'year']).optional(),
  /** Color rows/cards by a select field's option color (MN-102). */
  color_by_field_id: z.uuid().optional(),
  /** Board/gallery/list card body fields (also calendar chip fields). */
  card_field_ids: z.array(z.uuid()).default([]),
  /** Board/gallery card density (MN-089). */
  card_size: z.enum(['small', 'medium', 'large']).optional(),
  /**
   * #427 — board COLUMN order, as distinct from the card sort in `sorts`.
   *
   * `natural` follows the grouping source: the option order for select/workflow
   * (a real editorial decision) and API return order for user/relation (no
   * intent at all, which is what the ticket was filed about). Stored on the
   * VIEW so rearranging a board never rewrites the grouping field's options —
   * a schema every other view reads.
   */
  column_sort: z.enum(['natural', 'alpha', 'count']).optional(),
  /** #428 — hide groups with no cards. The no-value bucket has its own flag
   * below, because "No Epic" is a different question from "an epic with no
   * issues" and is usually the triage pile. */
  hide_empty_groups: z.boolean().optional(),
  hide_empty_no_value_group: z.boolean().optional(),
  /**
   * #391 — the attachment field a gallery card draws its image from.
   *
   * A gallery is the obvious view for media and until attachment fields existed
   * it had nothing to show: record-level attachments are a bag, and a card
   * cannot render a bag. Unset means no image, which is the previous behaviour
   * and stays the default.
   *
   * The card shows the FIRST file in the field, which is why the field's value
   * is an ordered list rather than a set — "which one is the cover" has to have
   * an answer the user controls.
   */
  cover_field_id: z.uuid().optional(),
  /** Calendar only — the date field that places records on the grid (MN-051). */
  date_field_id: z.uuid().optional(),
  /** Timeline (MN-092) — start (required) + optional end date field. */
  start_date_field_id: z.uuid().optional(),
  end_date_field_id: z.uuid().optional(),
  /**
   * #227 — an optional SECOND date pair rendered as a baseline behind the primary
   * bar, so planned-vs-actual slippage is visible on the same row. Independent of
   * the primary pair: dragging a bar rewrites the primary dates and must never
   * touch these, or the baseline would chase the thing it exists to be compared
   * against.
   */
  baseline_start_date_field_id: z.uuid().optional(),
  baseline_end_date_field_id: z.uuid().optional(),
  /**
   * Dashboard (MN-225 / #168) — ordered metric tiles. Unlike other view types
   * a dashboard's `filters`/`sorts` still apply (they scope every tile's
   * aggregate); it just renders KPI tiles instead of a record list. Phase 1 is
   * metric tiles only — charts/grouped widgets are a later phase.
   */
  dashboard_tiles: z.array(dashboardTileSchema).default([]),
  /**
   * Dashboard (MN-225 / #168, Phase 2) — ordered chart / grouped-table widgets,
   * rendered after the metric tiles. Each groups records by a field and
   * aggregates into a series; the view's `filters`/`sorts` scope them the same
   * way they scope tiles.
   */
  dashboard_widgets: z.array(dashboardWidgetSchema).default([]),
  /** Form (MN-094) — ordered inputs + presentation + optional public token. */
  form: z
    .object({
      title: z.string().max(200).optional(),
      description: z.string().max(2000).optional(),
      submit_text: z.string().max(50).optional(),
      fields: z
        .array(
          z.object({
            field_id: z.uuid(),
            required: z.boolean().optional(),
            label: z.string().max(100).optional(),
            help: z.string().max(500).optional(),
            /** #263 — show this field only when an EARLIER answer matches. */
            visible_when: formVisibilityRuleSchema.optional(),
          }),
        )
        .default([]),
      public_token: z.string().max(64).optional(),
      /** Who may open/submit the form (MN-101). members = signed-in only;
       * link = anyone with the token; public = same, advertised as open. */
      access: z.enum(['members', 'link', 'public']).default('members'),
      /** Shown after a successful submit; optional redirect instead. */
      success_message: z.string().max(500).optional(),
      redirect_url: z.string().url().max(500).optional(),
    })
    .optional(),
  /**
   * Public read-only sharing (#264) — mirrors `form` above: presence of
   * `public_token` is what makes a view reachable at `GET /public/views/:token`,
   * minted/cleared only through `POST`/`DELETE .../views/:view/share` (never
   * hand-set through the ordinary view PATCH, unlike a form's token — publishing
   * a view is a deliberate act with an explicit field/relation allowlist, not a
   * value a client could accidentally carry over from a duplicate).
   *
   * `visible_field_api_names` undefined = the view's own non-hidden fields
   * (`hidden_field_ids`, inverted) — EXCEPT a computed field (rollup/formula/
   * lookup), which is never exposed by that default: a rollup/formula can read
   * data the public visitor cannot see, so it is opt-in only, requires an
   * EXPLICIT allowlist that names it. `include_relation_api_names` defaults to
   * empty on purpose — the whole point of this ticket is that related records do
   * NOT travel unless the publisher says so.
   */
  share: z
    .object({
      public_token: z.string().max(64).optional(),
      visible_field_api_names: z.array(z.string()).optional(),
      include_relation_api_names: z.array(z.string()).default([]),
      indexable: z.boolean().default(false),
    })
    .optional(),
  /**
   * Column widths come from a resize drag, so they arrive as fractional pixels
   * (247.5) and can overshoot the sane range. Round + clamp rather than reject:
   * a stray pixel must never fail the whole view save (#78) — which auto-save
   * (MN-152) would otherwise retry on every config change.
   */
  column_widths: z
    .record(
      z.uuid(),
      z.number().finite().transform((v) => Math.min(1200, Math.max(40, Math.round(v)))),
    )
    .default({}),
});
export type ViewConfig = z.infer<typeof viewConfigSchema>;

/**
 * #347 — sidebar PLACEMENT, not ownership. A view still belongs to its database;
 * this only says where it appears in the tree. null = nested under its database
 * (the default, and where every view sits today). Set = it lives in that folder
 * instead — one home at a time, never two.
 *
 * There is deliberately no `space_id` here. A view with no database is created
 * through a different route that does not exist yet (#306); accepting a field
 * the endpoint cannot honour is worse than not offering it.
 */
const folderIdSchema = z.string().uuid().nullable().optional();

export const createViewSchema = z.object({
  name: z.string().trim().min(1).max(100),
  type: viewTypeSchema,
  config: viewConfigSchema.default({ sorts: [], hidden_field_ids: [], card_field_ids: [], dashboard_tiles: [], dashboard_widgets: [], column_widths: {} }),
  folder_id: folderIdSchema,
});

export const updateViewSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  config: viewConfigSchema.optional(),
  position: z.number().int().optional(),
  folder_id: folderIdSchema,
});
