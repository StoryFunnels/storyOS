import { z } from 'zod';

/** ADR-0007: graded scope access. */
export const grantRoleSchema = z.enum(['viewer', 'commenter', 'editor', 'creator']);
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
