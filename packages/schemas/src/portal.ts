import { z } from 'zod';

/**
 * #534 — identity and lifecycle only. `token` is server-generated
 * (`randomBytes(24)`, matching the public-view share-token primitive) and is
 * never accepted from the client — creating one never takes a token.
 */
export const createPortalRecipientSchema = z.object({
  label: z.string().trim().min(1).max(200),
  email: z.email().optional(),
});
export type CreatePortalRecipientInput = z.infer<typeof createPortalRecipientSchema>;

export const portalRecipientSchema = z.object({
  id: z.uuid(),
  workspace_id: z.uuid(),
  label: z.string(),
  email: z.string().nullable(),
  token: z.string(),
  revoked_at: z.iso.datetime().nullable(),
  created_at: z.iso.datetime(),
  updated_at: z.iso.datetime(),
});
export type PortalRecipient = z.infer<typeof portalRecipientSchema>;
