import { z } from 'zod';

export const membershipRoleSchema = z.enum(['admin', 'member', 'guest']);
export type MembershipRole = z.infer<typeof membershipRoleSchema>;

export const createWorkspaceSchema = z.object({
  name: z.string().trim().min(1).max(100),
  slug: z
    .string()
    .regex(/^[a-z0-9](?:[a-z0-9-]{0,48}[a-z0-9])?$/, 'lowercase letters, digits and dashes')
    .optional(),
});

export const updateWorkspaceSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
});

export const spaceColorSchema = z.enum([
  'gray', 'brown', 'gold', 'orange', 'red', 'pink', 'purple', 'blue', 'teal', 'green',
]);

export const createSpaceSchema = z.object({
  name: z.string().trim().min(1).max(100),
  icon: z.string().max(16).optional(),
  color: spaceColorSchema.optional(),
});

export const updateSpaceSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  icon: z.string().max(16).nullable().optional(),
  color: spaceColorSchema.nullable().optional(),
  position: z.number().int().optional(),
});

import { grantScopeSchema } from './access';

export const createInviteSchema = z
  .object({
    email: z.email(),
    role: membershipRoleSchema,
    /** Required for guests (ADR-0007): what they can access, at which role. */
    grants: z.array(grantScopeSchema).min(1).max(50).optional(),
  })
  .refine((v) => v.role !== 'guest' || (v.grants && v.grants.length > 0), {
    message: 'guest invites require at least one grant',
    path: ['grants'],
  });

export const acceptInviteSchema = z.object({
  token: z.string().min(16),
});

export const updateMemberSchema = z.object({
  role: membershipRoleSchema.optional(),
});
