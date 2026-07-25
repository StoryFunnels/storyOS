import type { ProviderAvailability } from '@storyos/schemas';
import type { ProviderDescriptor } from './types';

/** Everything availabilityFor() needs about the environment, injectable so the
 * truth table is unit-testable without touching real process.env or config. */
export interface AvailabilityContext {
  /** DeploymentService.isHosted — is this hosted StoryOS Cloud? */
  isHosted: boolean;
  /** The env to read a Tier B provider's OAuth client id/secret from.
   * Defaults to process.env; overridden in tests. */
  env?: Record<string, string | undefined>;
}

/** Both halves of a Tier B provider's OAuth app are present (mirrors what
 * ConnectionsService.authorizeUrl requires before it will start a connect, and
 * what listProviders reports as `oauth.configured`). */
function oauthConfigured(descriptor: ProviderDescriptor, env: Record<string, string | undefined>): boolean {
  const { oauth } = descriptor;
  if (!oauth) return false;
  return Boolean(env[oauth.clientIdEnv]?.trim() && env[oauth.clientSecretEnv]?.trim());
}

/**
 * #345 — resolve a provider's availability on THIS deployment. Server-
 * authoritative: it folds the provider's tier, the deployment mode, and the
 * operator's OAuth env into a single verdict #347's gallery renders verbatim.
 *
 * Truth table (parent #344's model):
 *
 *   tier           | hosted | oauth env present | result
 *   ---------------|--------|-------------------|----------------
 *   api_key        |  any   |        n/a        | connectable
 *   oauth_managed  |  any   |        yes        | connectable
 *   oauth_managed  | hosted |        no         | connectable   (managed app)
 *   oauth_managed  |  self  |        no         | operator_config
 *   hosted_only    | hosted |        n/a        | connectable
 *   hosted_only    |  self  |        n/a        | cloud_only
 *
 * The oauth_managed rows encode #346's key distinction: a self-managed operator
 * who hasn't wired their own OAuth app gets `operator_config` ("you can turn
 * this on"), NOT the `cloud_only` upsell — that's reserved for what's genuinely
 * unavailable off hosted (hosted_only). On hosted, the managed app's env is
 * present in practice, so the "hosted + env absent" row is a belt-and-braces
 * fallback that still reads `connectable`.
 */
export function availabilityFor(
  descriptor: ProviderDescriptor,
  ctx: AvailabilityContext,
): ProviderAvailability {
  const env = ctx.env ?? process.env;
  switch (descriptor.tier) {
    case 'api_key':
      return 'connectable';
    case 'oauth_managed':
      if (oauthConfigured(descriptor, env)) return 'connectable';
      return ctx.isHosted ? 'connectable' : 'operator_config';
    case 'hosted_only':
      return ctx.isHosted ? 'connectable' : 'cloud_only';
  }
}
