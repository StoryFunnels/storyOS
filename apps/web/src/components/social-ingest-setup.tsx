'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { AtSign, MessagesSquare, Users } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { IntegrationSetupGuide } from '@/components/integration-setup-guide';
import { SOCIAL_INGEST, type SocialIngestId } from '@/lib/social-ingest';

interface Connection {
  id: string;
  provider: string;
  name: string;
  status: 'active' | 'expired' | 'revoked' | 'error';
}

const ICONS: Record<SocialIngestId, LucideIcon> = {
  meta: MessagesSquare,
  x: AtSign,
  linkedin: Users,
};

/**
 * #112 — the top-level setup page for a social engagement ingest platform. A
 * discoverable home for "pull in our Meta/X/LinkedIn comments" that follows the
 * #215 Connect → Configure → Verify pattern, and seeds a per-platform-named
 * HTTP connection so tokens can't be mis-paired. Full dedicated OAuth providers
 * are a follow-up; labeling + discoverability is this slice.
 */
export function SocialIngestSetup({ platform }: { platform: SocialIngestId }) {
  const { ws } = useParams<{ ws: string }>();
  const cfg = SOCIAL_INGEST[platform];
  const Icon = ICONS[platform];

  const connections = useQuery({
    queryKey: ['connections', ws],
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/workspaces/{ws}/connections', {
        params: { path: { ws } },
      } as never);
      if (error) throw error;
      return (data as unknown as { data: Connection[] }).data;
    },
  });

  const matching = (connections.data ?? []).filter(
    (c) => c.provider === 'http' && cfg.connectionMatch.test(c.name),
  );
  const connected = matching.some((c) => c.status === 'active');

  const addConnectionHref = `/w/${ws}/settings/connections?add=http&name=${encodeURIComponent(
    cfg.defaultConnectionName,
  )}`;

  return (
    <div className="mx-auto max-w-2xl p-4 sm:p-8">
      <Link className="text-[12px] text-muted hover:text-ink" href={`/w/${ws}/settings/integrations`}>
        ← Integrations
      </Link>
      <div className="mt-6 flex items-center gap-3">
        <span className="flex h-11 w-11 items-center justify-center rounded-[var(--radius-control)] bg-hover">
          <Icon className="h-6 w-6 text-ink" />
        </span>
        <div>
          <h1 className="text-lg font-semibold text-ink">{cfg.label}</h1>
          <p className="text-[13px] text-muted">{cfg.blurb}</p>
        </div>
      </div>

      <IntegrationSetupGuide
        className="mt-6"
        steps={[
          {
            label: `Add the ${cfg.label} connection`,
            description: 'Save the access token as a named HTTP connection so it stays identifiable.',
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

      <section className="mt-6 rounded-[var(--radius-card)] border border-border-default bg-card p-5">
        <h2 className="text-sm font-semibold text-ink">
          {connected ? `${cfg.label} is connected` : `Connect ${cfg.label}`}
        </h2>
        <ol className="mt-3 flex list-decimal flex-col gap-2 pl-5 text-[13px] text-muted">
          {cfg.tokenSteps.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
        <div className="mt-4 flex flex-wrap gap-2">
          <Link href={addConnectionHref}>
            <Button>{connected ? 'Add another connection' : `Add ${cfg.label} connection`}</Button>
          </Link>
          <Link href={`/w/${ws}/settings/connections`}>
            <Button variant="secondary">Manage connections</Button>
          </Link>
        </div>
      </section>

      {matching.length > 0 && (
        <section className="mt-5 rounded-[var(--radius-card)] border border-border-default bg-card p-5">
          <h2 className="text-sm font-semibold text-ink">This platform&apos;s connections</h2>
          <div className="mt-3 flex flex-col gap-2">
            {matching.map((c) => (
              <div
                key={c.id}
                className="flex items-center justify-between gap-3 rounded-[var(--radius-control)] border border-border-default px-3 py-2"
              >
                <span className="truncate text-[13px] text-ink">{c.name}</span>
                <span
                  className={
                    c.status === 'active'
                      ? 'rounded bg-accent-soft px-1.5 py-0.5 text-[11px] text-ink'
                      : 'rounded bg-hover px-1.5 py-0.5 text-[11px] text-error'
                  }
                >
                  {c.status}
                </span>
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="mt-5 rounded-[var(--radius-card)] border border-border-default bg-accent-soft p-5">
        <h2 className="text-sm font-semibold text-ink">Where do records land?</h2>
        <p className="mt-1 text-[13px] text-muted">
          Comments and mentions become ordinary records. Open any database, choose{' '}
          <strong>Sources</strong> in its menu, add the <strong>{cfg.label}</strong> source, pick the
          connection you named above, and map its fields — then run <strong>Sync now</strong>.
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
