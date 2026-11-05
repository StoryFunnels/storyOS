import { redirect } from 'next/navigation';

/**
 * Ticket #1187 — Governance is now Agent rules, at `/settings/agent-rules`. This old path stays so a bookmarked or documented link
 * does not 404. `next.config.mjs` redirects it too, before any layout, so a member following it gets the Agent rules refusal sentence.
 */
export default async function LegacyGovernancePage({ params }: { params: Promise<{ ws: string }> }) {
  const { ws } = await params;
  redirect(`/w/${ws}/settings/agent-rules`);
}
