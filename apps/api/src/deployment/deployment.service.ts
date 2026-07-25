import { Injectable, Logger } from '@nestjs/common';
import { env } from '../config/env';

/**
 * #345 — the deployment-mode signal for the "cloud vs self-managed
 * integrations" initiative (parent #344). Answers one question the integration
 * catalog needs: is THIS instance hosted StoryOS Cloud (where we provide the
 * managed OAuth apps and hosted-only providers work), or a self-managed
 * deployment (where an operator brings their own OAuth apps and hosted-only
 * providers are unavailable)?
 *
 * Derived from config, never a build-time flag — and it deliberately reuses
 * StripeService.enabled's shape ("billing configured ⇒ hosted-ish") rather than
 * inventing a parallel mechanism:
 *   - STORYOS_HOSTED explicitly set ⇒ that wins ('true'/'1' hosted,
 *     'false'/'0' self-managed) — the escape hatch for a hosted instance that
 *     hasn't wired Stripe yet, or a self-managed one that has.
 *   - STORYOS_HOSTED unset ⇒ hosted iff STRIPE_SECRET_KEY is set, exactly the
 *     signal StripeService already treats as "this is the paid, hosted product".
 * So a plain self-host (no Stripe, no STORYOS_HOSTED) reads self-managed with
 * zero new configuration.
 */
/**
 * The pure hosted-vs-self-managed decision, exported and tested directly the
 * same way env.ts exports resolveAuthSecret/resolveConnectionsMasterKey (env()
 * is cached, so the resolver — not the constructed service — is the unit under
 * test).
 *
 *   - `storyosHosted` explicit ('true'/'1' | 'false'/'0') wins outright.
 *   - otherwise: hosted iff billing is configured (STRIPE_SECRET_KEY set),
 *     reusing StripeService.enabled's "billing configured ⇒ hosted-ish" signal.
 */
export function resolveHosted(
  storyosHosted: string | undefined,
  stripeSecretKey: string | undefined,
): boolean {
  const explicit = parseBool(storyosHosted);
  if (explicit !== undefined) return explicit;
  return Boolean(stripeSecretKey?.trim());
}

@Injectable()
export class DeploymentService {
  private readonly logger = new Logger(DeploymentService.name);
  private readonly hosted: boolean;

  constructor() {
    this.hosted = resolveHosted(env().STORYOS_HOSTED, env().STRIPE_SECRET_KEY);
    this.logger.log(
      `Deployment mode: ${this.hosted ? 'hosted (StoryOS Cloud)' : 'self-managed'}` +
        ` (STORYOS_HOSTED=${env().STORYOS_HOSTED ?? 'unset'}, billing ${env().STRIPE_SECRET_KEY?.trim() ? 'configured' : 'off'}).`,
    );
  }

  /** True on hosted StoryOS Cloud; false on a self-managed deployment. */
  get isHosted(): boolean {
    return this.hosted;
  }
}

/**
 * Parse an explicit STORYOS_HOSTED override. Returns undefined when unset/blank
 * (so the caller falls back to the billing-configured signal), and treats only
 * 'true'/'1' as hosted and 'false'/'0' as self-managed — the same guard against
 * `Boolean("false") === true` the env schema uses for its other boolean flags.
 */
function parseBool(raw: string | undefined): boolean | undefined {
  const v = raw?.trim().toLowerCase();
  if (v === undefined || v === '') return undefined;
  if (v === 'true' || v === '1') return true;
  if (v === 'false' || v === '0') return false;
  return undefined;
}
