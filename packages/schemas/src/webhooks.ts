import { z } from 'zod';

/**
 * MN-032: outgoing webhooks. The event names are the `activity_events.type`
 * taxonomy, which ADR-0004 designated a public contract from day 1 — so a
 * subscription's `events` are literally the outbox types the dispatcher scans.
 */
export const webhookEventSchema = z.enum([
  'record.created',
  'record.updated',
  'record.deleted',
  'record.restored',
  'relation.linked',
  'relation.unlinked',
  'comment.created',
]);
export type WebhookEvent = z.infer<typeof webhookEventSchema>;

/**
 * https only, and never a loopback/private host: a workspace admin could
 * otherwise point a webhook at the API's own network and use signed, retried
 * POSTs as an SSRF probe (the receiver is attacker-chosen by design).
 */
export const webhookUrlSchema = z
  .url()
  .max(2000)
  .refine((raw) => {
    // Hand-parsed rather than via URL: this package is shared with the browser and
    // compiles without the DOM/node libs.
    const match = /^https:\/\/([^/?#]+)/i.exec(raw.trim());
    if (!match) return false; // https only
    const authority = match[1]!;
    const hostPart = authority.includes('@') ? authority.slice(authority.lastIndexOf('@') + 1) : authority;
    const host = (hostPart.startsWith('[')
      ? hostPart.slice(1, hostPart.indexOf(']'))
      : hostPart.split(':')[0]!
    ).toLowerCase();

    if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal')) {
      return false;
    }
    // Literal private/loopback/link-local addresses. DNS names that resolve into
    // private space are re-checked at send time (assertPublicHost).
    if (/^(127\.|10\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|0\.)/.test(host)) return false;
    if (host === '::1' || host === '::' || /^(fe80:|fc|fd)/.test(host)) return false;
    return true;
  }, 'must be an https URL on a public host');

export const createWebhookSchema = z.object({
  url: webhookUrlSchema,
  /** Omit for every database in the workspace. */
  database_id: z.uuid().optional(),
  events: z.array(webhookEventSchema).min(1).max(20),
  enabled: z.boolean().default(true),
});

export const updateWebhookSchema = z.object({
  url: webhookUrlSchema.optional(),
  events: z.array(webhookEventSchema).min(1).max(20).optional(),
  enabled: z.boolean().optional(),
});
