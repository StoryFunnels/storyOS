import { z } from 'zod';
import { filterSchema, sortSchema } from './query';

export const viewTypeSchema = z.enum(['table', 'board', 'calendar']);
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
  /** Board card body fields (also calendar chip fields). */
  card_field_ids: z.array(z.uuid()).default([]),
  /** Calendar only — the date field that places records on the grid (MN-051). */
  date_field_id: z.uuid().optional(),
  column_widths: z.record(z.uuid(), z.number().int().min(40).max(1200)).default({}),
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
