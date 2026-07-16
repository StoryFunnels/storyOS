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

export const grantScopeSchema = z
  .object({
    space_id: z.uuid().optional(),
    database_id: z.uuid().optional(),
    role: grantRoleSchema,
  })
  .refine((v) => Boolean(v.space_id) !== Boolean(v.database_id), {
    message: 'provide exactly one of space_id / database_id',
    path: ['space_id'],
  });

export const createGrantSchema = z.object({
  user_id: z.string().min(1),
  space_id: z.uuid().optional(),
  database_id: z.uuid().optional(),
  role: grantRoleSchema,
}).refine((v) => Boolean(v.space_id) !== Boolean(v.database_id), {
  message: 'provide exactly one of space_id / database_id',
  path: ['space_id'],
});
