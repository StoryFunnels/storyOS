import { redirect } from 'next/navigation';

/**
 * Ticket #875 — Connect your AI moved to `/settings/connect-ai` (its own route, gated like API
 * tokens). This old path stays so a bookmarked or documented link does not 404.
 */
export default async function LegacyMcpIntegrationPage({ params }: { params: Promise<{ ws: string }> }) {
  const { ws } = await params;
  redirect(`/w/${ws}/settings/connect-ai`);
}
