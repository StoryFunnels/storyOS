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

/**
 * Auto-link rules (MN-085): link an A record to a B record when field-to-field
 * conditions all match — e.g. this.customer_email == target.email AND this.region
 * == target.region. Fields are named by api_name or id; the server resolves and
 * validates them (must be comparable scalar fields on the right side). Comparison
 * is case-insensitive by default; empty values on either side never match.
 */
export const autoLinkConditionSchema = z.object({
  /** A field on database A (api_name or id). */
  field_a: z.string().trim().min(1),
  /** A field on database B (api_name or id). */
  field_b: z.string().trim().min(1),
});
export const autoLinkRulesSchema = z.object({
  conditions: z.array(autoLinkConditionSchema).min(1).max(5),
  case_sensitive: z.boolean().default(false),
});
export type AutoLinkRules = z.infer<typeof autoLinkRulesSchema>;

/** PATCH a relation: set (or clear, with null) its auto-link rules. */
export const updateRelationSchema = z.object({
  auto_link: autoLinkRulesSchema.nullable(),
});

export const linkRecordsSchema = z.object({
  record_ids: z.array(z.uuid()).min(1).max(100),
});

export const replaceLinksSchema = z.object({
  record_ids: z.array(z.uuid()).max(100),
});
