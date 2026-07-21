import { z } from 'zod';

/**
 * MN-252 — the workspace credential registry. Shared shapes for the
 * connections API (create/list/provider-catalog); the auth material itself
 * (`auth`) is intentionally typed loose here — each provider descriptor
 * validates its own shape server-side (an Apify connection needs `api_key`,
 * an OAuth one is never created through this endpoint at all).
 */

export const connectionAuthKindSchema = z.enum(['oauth2', 'api_key', 'smtp']);
export type ConnectionAuthKind = z.infer<typeof connectionAuthKindSchema>;

export const connectionStatusSchema = z.enum(['active', 'expired', 'revoked', 'error']);
export type ConnectionStatus = z.infer<typeof connectionStatusSchema>;

/** POST body for an api_key/smtp connection. OAuth2 connections never go through
 * this endpoint — they're created by the provider callback after the redirect. */
export const createConnectionSchema = z.object({
  /** Provider descriptor id (see the provider catalog at GET .../connections/providers). */
  provider: z.string().min(1).max(50),
  name: z.string().min(1).max(100),
  /** Provider-specific auth material, e.g. `{ api_key: "..." }`. Never echoed back. */
  auth: z.record(z.string(), z.unknown()),
});
export type CreateConnectionInput = z.infer<typeof createConnectionSchema>;

/** The client-safe read shape — never the sealed auth material (MN-252 AC). */
export const connectionSummarySchema = z.object({
  id: z.uuid(),
  provider: z.string(),
  name: z.string(),
  status: connectionStatusSchema,
  scopes: z.array(z.string()),
  last_ok_at: z.string().nullable(),
  created_at: z.string(),
});
export type ConnectionSummary = z.infer<typeof connectionSummarySchema>;

/** One entry in the "Add a connection" catalog (GET .../connections/providers). */
export const providerDescriptorSummarySchema = z.object({
  id: z.string(),
  label: z.string(),
  auth_kind: connectionAuthKindSchema,
  oauth: z
    .object({
      scopes: z.array(z.string()),
      /** Whether this server has the provider's OAuth client id/secret env vars set. */
      configured: z.boolean(),
    })
    .optional(),
});
export type ProviderDescriptorSummary = z.infer<typeof providerDescriptorSummarySchema>;
