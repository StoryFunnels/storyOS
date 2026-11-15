'use client';

import Link from 'next/link';
import { useParams, useSearchParams } from 'next/navigation';
import { useEffect, useRef } from 'react';
import { ChevronRight } from 'lucide-react';
import { toast } from 'sonner';
import { useWorkspace } from '@/lib/queries';
import { useDateFormat } from '@/lib/preferences';
import { settingsPageHref } from '@/lib/settings-nav';
import { PROVIDER_PAGES, providerPageHref, providerPageSnapshot, type IntegrationEndpoint, type IntegrationFacts, type PageSnapshot } from '@/lib/provider-pages';
import { Button } from '@/components/ui/button';
import { useConnections, useIntegrationFacts, useProviders } from '@/components/connections/use-connections';
import { PROVIDER_ICONS } from '@/components/settings/provider-icons';
import { SettingsPill } from '@/components/settings/provider-card';
import { cn } from '@/lib/utils';
import { subLineClass, type ConnectionCardState } from '@/lib/connection-card';
import { EmptyState } from '@/components/ui/empty-state';

const ROW = 'flex min-h-[46px] flex-wrap items-center gap-3 border-t border-border-default px-3.5 py-2 text-body first:border-t-0';

function Logo({ snapshot }: { snapshot: PageSnapshot }) {
  const Icon = PROVIDER_ICONS[snapshot.def.id];
  return (
    <span className="flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-[var(--radius-chip)] bg-hover text-ink-secondary">
      <Icon className="h-3.5 w-3.5" aria-hidden />
    </span>
  );
}

/** What a connected row says under its name: the problem if there is one, else how many connections, else what it last did. */
function connectedSummary(s: PageSnapshot): { text: string; state: ConnectionCardState } {
  const attention = s.rows.find((r) => r.model.state === 'needs_attention');
  if (attention) return { text: attention.model.summary, state: attention.model.state };
  if (s.rows.length > 1) return { text: `${s.rows.length} connections`, state: s.overall.state };
  return { text: s.rows[0]?.subtitle ?? s.def.blurb, state: s.overall.state };
}

/**
 * Integrations (ticket #1188): the hub every provider page hangs off. Two lists, from one read of the credentials, the provider catalog
 * and GitHub's, Linear's and Slack's own config: what is connected (with what needs a look), and what could be.
 *
 * It no longer carries Disconnect, a Connect-your-AI hero or a link to /connections. Disconnect is on each provider's own page, in the
 * one shared connection card; Connect your AI is one link; /connections redirects here. A provider that this deployment cannot
 * connect says why in a sentence and has no Connect button (`operator_config` / `cloud_only`).
 */
export default function IntegrationsPage() {
  const { ws } = useParams<{ ws: string }>();
  const search = useSearchParams();
  const fmt = useDateFormat();
  const workspace = useWorkspace(ws);
  const connections = useConnections(ws);
  const providers = useProviders(ws);
  const github = useIntegrationFacts(ws, 'github');
  const linear = useIntegrationFacts(ws, 'linear');
  const slack = useIntegrationFacts(ws, 'slack');
  const toasted = useRef(false);

  // Where /connections now lands for an OAuth callback with no single provider page (an unknown provider, or an error).
  useEffect(() => {
    if (toasted.current) return;
    const connected = search.get('connected');
    const error = search.get('error');
    if (!connected && !error) return;
    toasted.current = true;
    if (connected) toast.success(`${connected} connected`);
    if (error) toast.error(`Connection failed: ${error}`);
  }, [search]);

  const facts: Partial<Record<IntegrationEndpoint, IntegrationFacts>> = {};
  if (github.data) facts.github = github.data;
  if (linear.data) facts.linear = linear.data;
  if (slack.data) facts.slack = slack.data;
  const failed = [
    github.isError && 'GitHub',
    linear.isError && 'Linear',
    slack.isError && 'Slack',
    connections.isError && 'your saved connections',
    providers.isError && 'the provider list',
  ].filter(Boolean) as string[];
  const ready = connections.data && providers.data && github.isFetched && linear.isFetched && slack.isFetched;

  const snapshots = ready
    ? PROVIDER_PAGES.map((def) => providerPageSnapshot(def, { connections: connections.data!, providers: providers.data!, integrations: facts, formatDateTime: (iso) => fmt.dateTime(iso) }))
    : [];
  const connected = snapshots.filter((s) => s.rows.length > 0).sort((a, b) => Number(b.overall.state === 'needs_attention') - Number(a.overall.state === 'needs_attention'));
  const available = snapshots.filter((s) => s.rows.length === 0);

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-[18px] p-4 sm:p-8">
      <header>
        <h1 className="text-lg font-bold leading-[1.3] tracking-[-0.01em] text-ink">Integrations</h1>
        <p className="mt-1 text-body text-muted">Accounts and tools connected to {workspace.data?.name ?? 'this workspace'}</p>
      </header>

      {failed.length > 0 && (
        <p role="alert" className="text-body text-error">
          Could not read {failed.join(', ')}. What is listed below may be incomplete.
        </p>
      )}
      {!ready && failed.length === 0 && <p className="text-body text-muted">Loading…</p>}

      {ready && (
        <>
          <section className="rounded-[var(--radius-card)] border border-border-default bg-card" aria-label="Connected" data-testid="integrations-connected">
            <div className="flex items-center gap-2 border-b border-border-default px-3.5 py-[11px] text-body font-[650]">
              Connected
              <span className="flex-1" />
              <span className="text-label font-medium text-muted">{connected.length}</span>
            </div>
            {connected.length === 0 && <EmptyState variant="list" title="Nothing is connected yet. Add a connection below." />}
            {connected.map((s) => {
              const summary = connectedSummary(s);
              return (
                <Link key={s.def.id} href={providerPageHref(ws, s.def.id)} className={cn(ROW, 'w-full text-left hover:bg-hover')} data-testid={`integration-${s.def.id}`}>
                  <Logo snapshot={s} />
                  <span className="flex min-w-0 flex-1 flex-col leading-[1.35] max-md:basis-48">
                    <b className="truncate font-medium text-ink">{s.def.label}</b>
                    <span className={subLineClass(summary.state)}>{summary.text}</span>
                  </span>
                  <SettingsPill tone={s.overall.pill.tone}>{s.overall.pill.label}</SettingsPill>
                  <ChevronRight className="h-3 w-3 text-faint" aria-hidden />
                </Link>
              );
            })}
          </section>

          <section className="rounded-[var(--radius-card)] border border-border-default bg-card" aria-label="Add a connection" data-testid="integrations-available">
            <div className="border-b border-border-default px-3.5 py-[11px] text-body font-[650]">Add a connection</div>
            {available.map((s) => {
              const canConnect = s.overall.actions.includes('connect');
              const builtin = s.def.backing.kind === 'builtin';
              return (
                <div key={s.def.id} className={ROW} data-testid={`integration-${s.def.id}`} data-state={s.overall.state}>
                  <Logo snapshot={s} />
                  <span className="flex min-w-0 flex-1 flex-col leading-[1.35] max-md:basis-48">
                    <b className="truncate font-medium text-ink">{s.def.label}</b>
                    <span className="text-label text-muted">{canConnect || builtin ? s.def.blurb : s.overall.summary}</span>
                  </span>
                  {!canConnect && !builtin && <SettingsPill tone="quiet">{s.overall.pill.label}</SettingsPill>}
                  {(canConnect || builtin) && (
                    <Link href={providerPageHref(ws, s.def.id)}>
                      <Button size="sm" variant="secondary">
                        {builtin ? 'Open' : 'Connect'}
                      </Button>
                    </Link>
                  )}
                  {!canConnect && !builtin && (
                    <Link href={providerPageHref(ws, s.def.id)} className="text-label text-muted underline underline-offset-2 hover:text-ink">
                      Details
                    </Link>
                  )}
                </div>
              );
            })}
          </section>

          <p className="text-label text-muted">
            Connecting an AI app lives in{' '}
            <Link href={settingsPageHref(ws, 'connect-ai')} className="text-ink underline underline-offset-2">
              Connect your AI
            </Link>
            .
          </p>
        </>
      )}
    </div>
  );
}
