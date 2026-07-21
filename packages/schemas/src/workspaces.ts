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
  /** #201: when on, `GET /files/:id` (inline editor-image serve) also requires
   * an authenticated, access-checked request instead of relying on the id being
   * unguessable. Off by default — existing capability-URL behavior is
   * unchanged. Mechanism only; no billing-tier gate is enforced here. */
  private_attachments: z.boolean().optional(),
});

export const spaceColorSchema = z.enum([
  'gray', 'brown', 'gold', 'orange', 'red', 'pink', 'purple', 'blue', 'teal', 'green',
]);

/**
 * #283: this schema only bounds length — it doesn't reject raw emoji, because
 * the actual invariant ("only `set:<name>` refs get persisted") is enforced
 * one layer down, in SpacesService.create/update (via
 * `normalizeIconInput` from `@storyos/schemas/icons`). That's deliberate: a
 * zod `.transform()` here would only run for requests that go through this
 * DTO, but templates and integrations (linear.service.ts, github.service.ts,
 * agents.service.ts) construct spaces by calling SpacesService directly,
 * bypassing this schema entirely. Normalizing in the service is the only
 * choke point that covers every entry point.
 */
export const createSpaceSchema = z.object({
  name: z.string().trim().min(1).max(100),
  icon: z.string().max(48).optional(),
  color: spaceColorSchema.optional(),
});

export const updateSpaceSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  icon: z.string().max(48).nullable().optional(),
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
