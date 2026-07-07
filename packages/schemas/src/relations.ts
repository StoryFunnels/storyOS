import { z } from 'zod';

export const relationCardinalitySchema = z.enum(['one_to_many', 'many_to_many']);
export type RelationCardinality = z.infer<typeof relationCardinalitySchema>;

/**
 * Creating a relation provisions a paired field on BOTH databases (meta-model).
 * Side "a" is the "many" side for one_to_many: each A record links to at most
 * one B record; a B record collects many A records.
 */
export const createRelationSchema = z.object({
  database_a_id: z.uuid(),
  database_b_id: z.uuid(),
  cardinality: relationCardinalitySchema,
  /** Field shown on database A (points at B). Defaults to B's name. */
  field_a_name: z.string().trim().min(1).max(100).optional(),
  /** Field shown on database B (points at A). Defaults to A's name. */
  field_b_name: z.string().trim().min(1).max(100).optional(),
});

export const deleteRelationSchema = z.object({
  /** Deleting a relation removes BOTH fields and all links — explicit confirm. */
  confirm: z.literal(true),
});

export const linkRecordsSchema = z.object({
  record_ids: z.array(z.uuid()).min(1).max(100),
});

export const replaceLinksSchema = z.object({
  record_ids: z.array(z.uuid()).max(100),
});
