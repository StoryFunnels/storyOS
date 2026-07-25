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

/**
 * #346 — the integration tier of a provider, by who owns the credential
 * (parent #344's standing convention). Orthogonal to `auth_kind` (which is the
 * mechanical shape of the credential):
 *
 *  - `api_key`      — the user brings their own key/secret; works on hosted AND
 *                     self-managed (apify, resend, smtp, http).
 *  - `oauth_managed`— needs a verified OAuth app. Hosted StoryOS provides the
 *                     managed app; a self-managed operator brings their own via
 *                     the descriptor's clientIdEnv/clientSecretEnv (google,
 *                     google-calendar; future youtube/meta/linkedin/x).
 *  - `hosted_only`  — only meaningful on hosted StoryOS. No provider uses this
 *                     today; the value is reserved so callers/UI can handle it.
 */
export const providerTierSchema = z.enum(['api_key', 'oauth_managed', 'hosted_only']);
export type ProviderTier = z.infer<typeof providerTierSchema>;

/**
 * #345 — the server-authoritative "can this workspace connect this provider on
 * THIS deployment right now" verdict, resolved from the provider's tier, the
 * deployment mode (hosted vs self-managed), and whether the operator's OAuth
 * env vars are present:
 *
 *  - `connectable`     — connect it now (Tier A always; Tier B once its OAuth
 *                        app env vars are present, which hosted provides; Tier C
 *                        on hosted).
 *  - `operator_config` — self-managed and the operator has NOT set this Tier B
 *                        provider's OAuth env vars yet; they can, so the UI shows
 *                        "configure it" rather than an upsell. This is the
 *                        "not configured because self-managed" case #346 needs
 *                        distinguished from a genuine "unavailable".
 *  - `cloud_only`      — genuinely unavailable on this self-managed deployment
 *                        (Tier C off hosted); the UI shows the
 *                        "Available on StoryOS Cloud" upsell.
 */
export const providerAvailabilitySchema = z.enum(['connectable', 'operator_config', 'cloud_only']);
export type ProviderAvailability = z.infer<typeof providerAvailabilitySchema>;

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
  /** #346 — the credential-ownership tier (see providerTierSchema). */
  tier: providerTierSchema,
  /**
   * #345 — this deployment's verdict for this provider (see
   * providerAvailabilitySchema). Server-authoritative: it already folds in the
   * deployment mode and the operator's OAuth env, so #347's gallery renders it
   * verbatim (connect / configure / upsell) without re-deriving anything.
   */
  availability: providerAvailabilitySchema,
  /** #346 — optional copy for the "Available on StoryOS Cloud"-style note. */
  availability_note: z.string().optional(),
  oauth: z
    .object({
      scopes: z.array(z.string()),
      /** Whether this server has the provider's OAuth client id/secret env vars set. */
      configured: z.boolean(),
    })
    .optional(),
});
export type ProviderDescriptorSummary = z.infer<typeof providerDescriptorSummarySchema>;
