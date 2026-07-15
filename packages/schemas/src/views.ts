import { z } from 'zod';
import { filterSchema, sortSchema } from './query';

export const viewTypeSchema = z.enum([
  'table', 'board', 'calendar', 'gallery', 'list', 'feed', 'timeline', 'form',
]);
export type ViewType = z.infer<typeof viewTypeSchema>;

/**
 * A view is a SAVED PRESET: the client reads the config and sends the full
 * query to /records/query itself — the server stays dumb (MN-020 decision).
 * Filters/sorts reference fields by api_name (same AST as the query API);
 * structural knobs reference fields by id.
 */
export const viewConfigSchema = z.object({
  filters: filterSchema.optional(),
  sorts: z.array(sortSchema).max(3).default([]),
  hidden_field_ids: z.array(z.uuid()).default([]),
  /** Board only — must reference a single-select field (v1). */
  group_by_field_id: z.uuid().optional(),
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
          }),
        )
        .default([]),
      public_token: z.string().max(64).optional(),
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

export const createViewSchema = z.object({
  name: z.string().trim().min(1).max(100),
  type: viewTypeSchema,
  config: viewConfigSchema.default({ sorts: [], hidden_field_ids: [], card_field_ids: [], column_widths: {} }),
});

export const updateViewSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  config: viewConfigSchema.optional(),
  position: z.number().int().optional(),
});
