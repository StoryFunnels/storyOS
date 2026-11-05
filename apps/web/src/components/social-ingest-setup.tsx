'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { IntegrationSetupGuide } from '@/components/integration-setup-guide';
import { useConnections } from '@/components/connections/use-connections';
import { ProviderConnectionCard, ProviderPageHeader } from '@/components/settings/provider-card';
import { SOCIAL_INGEST, type SocialIngestId } from '@/lib/social-ingest';

/**
 * #112 — the top-level setup page for a social engagement ingest platform (Meta, X, LinkedIn), following the #215 Connect → Configure →
 * Verify pattern.
 *
 * Ticket #1188: these three are PRESETS of a Custom API connection (`lib/custom-api-presets.ts`). They only ever made a generic HTTP
 * connection, named for the platform so the server can tell which token is which. The page's own connect button, its list of this
 * platform's connections and its "Manage connections" link are now the shared connection card: connect (pre-filled), test and
 * disconnect in one place. What stays here is what only this page knows: how to get the token, and where the records land.
 */
export function SocialIngestSetup({ platform }: { platform: SocialIngestId }) {
  const { ws } = useParams<{ ws: string }>();
  const cfg = SOCIAL_INGEST[platform];
  const connections = useConnections(ws);
  const connected = (connections.data ?? []).some(
    (c) => (c.provider === 'http' || c.provider === platform) && cfg.connectionMatch.test(c.name) && c.status === 'active',
  );

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-[18px] p-4 sm:p-8">
      <ProviderPageHeader ws={ws} id={platform}>
        {cfg.blurb}
      </ProviderPageHeader>

      <ProviderConnectionCard ws={ws} id={platform} />

      <IntegrationSetupGuide
        steps={[
          {
            label: `Add the ${cfg.label} connection`,
            description: 'Save the access token as a named Custom API connection so it stays identifiable.',
            complete: connected,
          },
          {
            label: 'Open the destination database',
            description: 'Records land in an ordinary database — create or open the one you want.',
            complete: false,
          },
          {
            label: 'Add the source and sync',
            description: `In that database choose Sources → New source → "${cfg.label}", pick this connection, then Sync now.`,
            complete: false,
          },
        ]}
      />

      <section className="rounded-[var(--radius-card)] border border-border-default bg-card p-5">
        <h2 className="text-sm font-semibold text-ink">Get your token</h2>
        <ol className="mt-3 flex list-decimal flex-col gap-2 pl-5 text-body text-muted">
          {cfg.tokenSteps.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
      </section>

      <section className="rounded-[var(--radius-card)] border border-border-default bg-hover p-5">
        <h2 className="text-sm font-semibold text-ink">Where do items land?</h2>
        <p className="mt-1 text-body text-muted">
          Comments and mentions become ordinary records. Open any database, choose <strong>Sources</strong> in its menu, add the{' '}
          <strong>{cfg.label}</strong> source, pick the connection you named above, and map its fields — then run <strong>Sync now</strong>.
        </p>
        <div className="mt-4">
          <Link href={`/w/${ws}`}>
            <Button variant="secondary" size="sm">
              Go to workspace
            </Button>
          </Link>
        </div>
      </section>
    </div>
  );
}
