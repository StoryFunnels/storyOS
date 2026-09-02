import { z } from 'zod';

/**
 * ADR-0007: graded scope access. `contributor` (MN-121) = read + create + update
 * records, no delete — and the boundary the billing layer reads for a paid seat.
 */
export const grantRoleSchema = z.enum([
  'viewer',
  'commenter',
  'contributor',
  'editor',
  'creator',
]);
export type GrantRoleInput = z.infer<typeof grantRoleSchema>;

/** #472 — exactly one of the three scopes, the general form (a 2-way XOR
 * doesn't extend to three by chaining `!==`). */
function exactlyOneScope(v: { space_id?: string; database_id?: string; record_id?: string }): boolean {
  return [v.space_id, v.database_id, v.record_id].filter(Boolean).length === 1;
}

export const grantScopeSchema = z
  .object({
    space_id: z.uuid().optional(),
    database_id: z.uuid().optional(),
    /** #472 — third scope: one specific record. */
    record_id: z.uuid().optional(),
    role: grantRoleSchema,
  })
  .refine(exactlyOneScope, {
    message: 'provide exactly one of space_id / database_id / record_id',
    path: ['space_id'],
  });

export const createGrantSchema = z
  .object({
    user_id: z.string().min(1),
    space_id: z.uuid().optional(),
    database_id: z.uuid().optional(),
    record_id: z.uuid().optional(),
    role: grantRoleSchema,
  })
  .refine(exactlyOneScope, {
    message: 'provide exactly one of space_id / database_id / record_id',
    path: ['space_id'],
  });
