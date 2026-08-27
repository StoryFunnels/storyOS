import { z } from 'zod';
import { PALETTE } from './colors';
import { descriptionPatchSchema, descriptionSchema } from './descriptions';

export const membershipRoleSchema = z.enum(['admin', 'member', 'guest']);
export type MembershipRole = z.infer<typeof membershipRoleSchema>;

export const createWorkspaceSchema = z.object({
  name: z.string().trim().min(1).max(100),
  /** #400 — a one-line "what this company is doing here". */
  description: descriptionSchema,
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
  /** #400 — null clears it. */
  description: descriptionPatchSchema,
});

/**
 * #399 — DERIVED. Was byte-identical to `databaseColorSchema`: a third copy of
 * the same ten values, which is how the count in this ticket went from two to
 * three when somebody looked.
 */
export const spaceColorSchema = z.enum(PALETTE);

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
  /** #400 — a one-line "what this area of work is". */
  description: descriptionSchema,
});

export const updateSpaceSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  icon: z.string().max(48).nullable().optional(),
  color: spaceColorSchema.nullable().optional(),
  position: z.number().int().optional(),
  /** #400 — null clears it. */
  description: descriptionPatchSchema,
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

/**
 * #177: shape returned by both `POST /invites` and `POST /invites/:invite/resend`.
 * `accept_url` is the plaintext token link — only ever available at (re)send
 * time, since the token itself is stored hashed and never round-trips again.
 */
export const inviteSentResponseSchema = z.object({
  id: z.string(),
  email: z.string(),
  role: membershipRoleSchema,
  accept_url: z.string(),
});
export type InviteSentResponse = z.infer<typeof inviteSentResponseSchema>;

export const updateMemberSchema = z.object({
  role: membershipRoleSchema.optional(),
});
