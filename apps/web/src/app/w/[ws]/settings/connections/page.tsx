import { redirect } from 'next/navigation';
import { connectionsRedirectTarget, type ConnectionsSearch } from '@/lib/connections-redirect';

/**
 * Ticket #1188 — the old Connections page is merged into the provider pages (one shared connection card each) and this URL redirects.
 * It keeps resolving because the OAuth callback, the button and automation editors, the pack installer and the docs all link to it;
 * `?connected=`, `?error=`, `?add=` and `?name=` are carried to the page that now handles them (`connectionsRedirectTarget`).
 *
 * A server redirect, so it happens before the admins-only layout renders: a member is sent to Integrations, which refuses them in
 * words, and never sees a flash of a connections list.
 */
export default async function LegacyConnectionsPage({
  params,
  searchParams,
}: {
  params: Promise<{ ws: string }>;
  searchParams: Promise<ConnectionsSearch>;
}) {
  const { ws } = await params;
  redirect(connectionsRedirectTarget(ws, await searchParams));
}
