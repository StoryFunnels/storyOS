import { PROVIDER_PAGES, providerPageHref, type ProviderPageId } from '@/lib/provider-pages';

/**
 * Ticket #1188 — `/settings/connections` no longer exists as a page: every credential is on its own provider's page now. The URL
 * keeps resolving (it is linked from the OAuth callback, from button and automation editors, from the pack installer and from docs),
 * and it keeps its query: the API's OAuth callback redirects to `/settings/connections?connected=<provider>` (or `?error=...`), and the
 * connect deep links are `?add=<provider>&name=...`. Dropping them would lose the "connected" toast and the pre-named connect form.
 *
 * Pure, so the mapping is a table the test reads rather than a branch nobody exercises.
 */
export type ConnectionsSearch = Partial<Record<'connected' | 'error' | 'add' | 'name', string | string[] | undefined>>;

/** The registry provider id → the page that owns it. Derived from the registry so a new provider cannot be forgotten here. */
export function pageForProvider(providerId: string): ProviderPageId | null {
  for (const p of PROVIDER_PAGES) {
    if (p.backing.kind !== 'connections') continue;
    // The first page that lists the provider as something it CONNECTS owns it (HTTP belongs to Custom API, not to a preset page).
    if (p.backing.connect.some((c) => c.providerId === providerId && !c.presetId)) return p.id;
  }
  // A provider whose only connect path is a preset (none today) would fall through to its row owner.
  for (const p of PROVIDER_PAGES) if (p.backing.kind === 'connections' && p.backing.providers.includes(providerId)) return p.id;
  return null;
}

const first = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);

export function connectionsRedirectTarget(ws: string, search: ConnectionsSearch): string {
  const hub = `/w/${ws}/settings/integrations`;
  const params = new URLSearchParams();
  const add = first(search.add);
  const connected = first(search.connected);
  const error = first(search.error);
  const name = first(search.name);
  const addPage = add ? pageForProvider(add) : null;
  const connectedPage = connected ? pageForProvider(connected) : null;
  if (addPage && add) {
    params.set('add', add);
    if (name) params.set('name', name);
    return `${providerPageHref(ws, addPage)}?${params}`;
  }
  if (connectedPage && connected) {
    params.set('connected', connected);
    return `${providerPageHref(ws, connectedPage)}?${params}`;
  }
  // An error carries no provider; a connected provider this build does not know still deserves its toast.
  if (connected) params.set('connected', connected);
  if (error) params.set('error', error);
  const q = params.toString();
  return q ? `${hub}?${q}` : hub;
}
