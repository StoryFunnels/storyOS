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
 * metric tiles, so a widget only ever aggregates records the viewer can access
 * and the view's own filter scopes every widget. Fields are referenced by
 * api_name (same as tiles/filters/sorts); grouping is computed client-side.
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
