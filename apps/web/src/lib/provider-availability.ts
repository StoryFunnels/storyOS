/**
 * #347 — the three honest states the Connections gallery and the Sources
 * "Sync from…" picker render for every provider, derived verbatim from the
 * server-authoritative `availability` verdict #345/#346 put on the provider
 * catalog (GET .../connections/providers). The web app never re-derives
 * availability — it only maps the verdict to presentation, so this helper is a
 * pure lookup table and is unit-tested as one.
 *
 * The three `ProviderAvailability` values map one-to-one onto the ticket's
 * three states:
 *
 *  - `connectable`     → state 1: show the normal Connect affordance + existing
 *                        connect flow (managed cloud app, Tier A api_key, or an
 *                        operator-configured own OAuth app — the server already
 *                        folded all of that in).
 *  - `cloud_only`      → state 2: a quiet "Available on StoryOS Cloud" upsell.
 *                        NOT a Connect button that fails, NOT a wall of API-key
 *                        instructions.
 *  - `operator_config` → state 3: operator-only. The BYO OAuth-app / API-key
 *                        path lives in the self-hosting docs; the gallery does
 *                        NOT surface per-user setup here — just a subtle
 *                        "configured by your admin" hint.
 */
export type ProviderAvailability = 'connectable' | 'operator_config' | 'cloud_only';

export interface AvailabilityPresentation {
  state: ProviderAvailability;
  /** Whether the UI should offer a connect / select affordance at all. Only
   * `connectable` is actionable; the other two are informational states. */
  actionable: boolean;
  /** Short badge/label for the state (also used as the disabled `<option>`
   * suffix in the Sources picker). Empty for `connectable`, which uses the
   * existing per-provider connect controls rather than a badge. */
  label: string;
  /** One-sentence explanation. For `cloud_only` a server-provided
   * `availability_note` overrides the default upsell copy. */
  description: string;
}

const CLOUD_ONLY_DEFAULT =
  'Available on StoryOS Cloud — this integration isn’t offered on a self-managed deployment.';
const OPERATOR_CONFIG_DEFAULT =
  'Configured by your admin — set up in the self-hosting settings, not per user here.';

/**
 * Map a provider's server-resolved `availability` (plus its optional
 * `availability_note`) to how the gallery/picker should present it. Pure: no
 * environment, no deployment-mode re-derivation — the server already did that.
 */
export function presentAvailability(
  availability: ProviderAvailability,
  availabilityNote?: string,
): AvailabilityPresentation {
  switch (availability) {
    case 'connectable':
      return { state: availability, actionable: true, label: '', description: '' };
    case 'cloud_only':
      return {
        state: availability,
        actionable: false,
        label: 'Available on StoryOS Cloud',
        description: availabilityNote?.trim() || CLOUD_ONLY_DEFAULT,
      };
    case 'operator_config':
      return {
        state: availability,
        actionable: false,
        label: 'Configured by your admin',
        description: availabilityNote?.trim() || OPERATOR_CONFIG_DEFAULT,
      };
  }
}
