import { PROVIDER_PAGES, type ProviderPageDef } from '@/lib/provider-pages';

/**
 * Ticket #1221 — a connected provider page leads with the connection card; how it was set up (the stepper, the App box, the token
 * or key form) waits under ONE closed disclosure. Not connected, that same content is the page and stays open.
 *
 * One pure function so no provider page decides this for itself: before this, GitHub and Linear showed the full setup under a card
 * that already said "Working".
 */
export interface SetupDisclosureModel {
  /** True: wrap the setup in the closed disclosure. False: draw it as the page, as before. */
  collapsed: boolean;
  title: string;
  summary: string;
}

export function setupDisclosure(label: string, connected: boolean): SetupDisclosureModel {
  return {
    collapsed: connected,
    title: `Change how ${label} is connected`,
    summary: 'Setup steps, keys and tokens',
  };
}

/**
 * The providers whose page has setup content of its own. Every other provider's page is the card alone (it connects in a dialog),
 * and Delegate to agent holds no credential, so it has nothing to be "connected" to. Derived from the registry, not listed by hand,
 * so a new provider with a page is covered by the guard test the moment it is added.
 */
export function providersWithSetup(): ProviderPageDef[] {
  return PROVIDER_PAGES.filter((p) => p.backing.kind !== 'builtin' && OWN_SETUP_PAGES.has(p.id));
}

/** Providers that have their own page folder with setup content (the rest render `[provider]/page.tsx`: the card only). */
export const OWN_SETUP_PAGES: ReadonlySet<string> = new Set([
  'github',
  'linear',
  'slack',
  'youtube',
  'google-calendar',
  'shopify',
  'meta',
  'x',
  'linkedin',
]);
