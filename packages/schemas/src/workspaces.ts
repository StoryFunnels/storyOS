import { z } from 'zod';
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

/**
 * #417 — deleting a space is the LARGEST destructive action in the product.
 *
 * `spaces → databases → records` is a hard-delete CASCADE at the database level.
 * Records have soft-delete for the trash, but a cascade removes the rows
 * outright, so the trash cannot help: every record in every database in the
 * space is gone, unrecoverably, in one statement.
 *
 * The guard mirrors `deleteDatabaseSchema` deliberately — a space is a strictly
 * larger blast radius than a database, so it cannot ask for less. Typing the
 * name is the API-level equivalent of "type the name to delete".
 *
 * Optional, because an EMPTY space has nothing to lose: the service requires it
 * only when the space still holds databases. Demanding a typed name to remove an
 * empty scratch space would be friction that teaches people to ignore the
 * prompt, which is how a real one gets confirmed on autopilot.
 */
export const deleteSpaceSchema = z
  .object({
    /** Must equal the space name exactly. Required only when the space is not empty. */
    confirm: z.string().optional(),
  })
  /*
   * `.default({})` so an ABSENT body parses instead of 422-ing.
   *
   * Not cosmetic: the DTO's validation pipe runs BEFORE the controller's
   * `assertSpace`, so a required body made a guest deleting a space they cannot
   * see get 422 instead of 404 — confirming the space exists. `permissions-epic`
   * asserts 404 there precisely so the API never reveals that ("must 404 — not
   * even confirm it exists"), and this change broke it until the default was
   * added. An empty body is a legitimate call: it is how you delete an empty
   * space.
   */
  .default({});

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
