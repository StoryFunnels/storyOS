import { z } from 'zod';

/**
 * #534 — identity and lifecycle only. `token` returned to the caller is a
 * signed, minted credential (#602 — `id.version.hmac`, see
 * portal-recipient-token.ts), never accepted from the client — creating one
 * never takes a token.
 */
export const createPortalRecipientSchema = z.object({
  label: z.string().trim().min(1).max(200),
  email: z.email().optional(),
  /** #535 — which record this recipient IS, for a relation-typed recipient-scope rule. */
  linked_record_id: z.uuid().optional(),
  /** #602 — an expired token is refused the same way a revoked one is. Absent = never expires. */
  expires_at: z.iso.datetime().optional(),
});
export type CreatePortalRecipientInput = z.infer<typeof createPortalRecipientSchema>;

export const portalRecipientSchema = z.object({
  id: z.uuid(),
  workspace_id: z.uuid(),
  label: z.string(),
  email: z.string().nullable(),
  linked_record_id: z.uuid().nullable(),
  /** #602 — the current, live bearer credential, re-minted from id + token_version on every read. */
  token: z.string(),
  revoked_at: z.iso.datetime().nullable(),
  expires_at: z.iso.datetime().nullable(),
  created_at: z.iso.datetime(),
  updated_at: z.iso.datetime(),
});
export type PortalRecipient = z.infer<typeof portalRecipientSchema>;

/** #537 — did the request get content, or was it turned away (and why)? */
export const portalAccessOutcomeSchema = z.enum(['served', 'rejected']);
export type PortalAccessOutcome = z.infer<typeof portalAccessOutcomeSchema>;

/**
 * #537 — one recorded portal-recipient access, read shape. `recipient_label`
 * and `view_name` are resolved at read time (never denormalized onto the log
 * row itself) so a later rename shows up immediately; `view_name` falls back
 * to "(deleted view)" the same way a deleted field's name does in #454's
 * audit log, since `view_id` carries no FK (see schema.ts's own comment).
 */
export const portalAccessLogEntrySchema = z.object({
  id: z.uuid(),
  recipient_id: z.uuid(),
  recipient_label: z.string(),
  view_id: z.uuid(),
  view_name: z.string(),
  outcome: portalAccessOutcomeSchema,
  reason: z.string().nullable(),
  created_at: z.iso.datetime(),
});
export type PortalAccessLogEntry = z.infer<typeof portalAccessLogEntrySchema>;
