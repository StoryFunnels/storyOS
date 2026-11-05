'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useEffect, useRef } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import posthog from 'posthog-js';
import { toast } from 'sonner';
import { api, API_URL, apiErrorMessage } from '@/lib/api';
import { cn } from '@/lib/utils';
import { useDateFormat } from '@/lib/preferences';
import { BaseUrlDialog } from '@/components/connections/base-url-dialog';
import { ApiKeyConnectDialog, HttpConnectDialog } from '@/components/connections/connect-dialogs';
import { useConnections, useIntegrationFacts, useProviders } from '@/components/connections/use-connections';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { PROVIDER_ICONS } from '@/components/settings/provider-icons';
import { confirmDisconnectProvider } from '@/lib/settings-confirmations';
import { friendlySlackTestError } from '@/lib/integration-facts';
import { subLineClass, type PillTone } from '@/lib/connection-card';
import {
  providerPage,
  providerPageSnapshot,
  type CardRow,
  type ConnectOptionView,
  type IntegrationEndpoint,
  type PageSnapshot,
  type ProviderPageDef,
  type ProviderPageId,
} from '@/lib/provider-pages';

/** The prototype's `.pill2`: a 20px tag with a dot (4px radius in the prototype's default tight theme, like the run status pill). Quiet is the neutral wash; ok, warn and bad tint it. */
const PILL: Record<PillTone, string> = {
  quiet: 'bg-hover text-ink-secondary',
  ok: 'bg-[color-mix(in_srgb,var(--success)_13%,var(--bg-card))] text-success',
  warn: 'bg-[var(--warning-soft)] text-warning-text',
  bad: 'bg-[color-mix(in_srgb,var(--error)_12%,var(--bg-card))] text-error',
};

export function SettingsPill({ tone, children }: { tone: PillTone; children: React.ReactNode }) {
  return (
    <span className={cn('inline-flex h-5 shrink-0 items-center gap-[5px] whitespace-nowrap rounded-[var(--radius-chip)] px-2 text-meta font-semibold leading-[normal]!', PILL[tone])}>
      <i className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden />
      {children}
    </span>
  );
}

/** Where the Linear and Slack pages keep their key fields: a card's Connect for them takes you to the field instead of repeating it. */
const CONNECT_ANCHOR: Partial<Record<IntegrationEndpoint, { label: string; target: string }>> = {
  linear: { label: 'Add your API key', target: 'lin-key' },
  slack: { label: 'Add a bot token or webhook', target: 'slack-token' },
};

function connectionCaches(ws: string): ReadonlyArray<readonly unknown[]> {
  return [
    ['connections', ws],
    ['connection-providers', ws],
    ['integrations-directory', ws],
    ['integration-facts', ws],
    ['github-config', ws],
    ['github-install-repos', ws],
    ['linear-config', ws],
    ['slack-config', ws],
  ];
}

/** The page's state from the same three reads the hub makes. `snapshot` is null while the reads that decide it are in flight or failed. */
export function useProviderSnapshot(ws: string, def: ProviderPageDef): { snapshot: PageSnapshot | null; failed: boolean } {
  const fmt = useDateFormat();
  const isConnections = def.backing.kind === 'connections';
  const endpoint = def.backing.kind === 'integration' ? def.backing.endpoint : null;
  const connections = useConnections(ws);
  const providers = useProviders(ws);
  const facts = useIntegrationFacts(ws, endpoint ?? 'github');
  // A failed read is not "not connected": say so rather than draw a Connect button over a credential that may exist.
  const failed = (isConnections && (connections.isError || providers.isError)) || (endpoint !== null && facts.isError);
  if (failed) return { snapshot: null, failed: true };
  if (isConnections && (!connections.data || !providers.data)) return { snapshot: null, failed: false };
  if (endpoint && !facts.data) return { snapshot: null, failed: false };
  return {
    failed: false,
    snapshot: providerPageSnapshot(def, {
      connections: connections.data ?? [],
      providers: providers.data ?? [],
      integrations: endpoint && facts.data ? { [endpoint]: facts.data } : {},
      formatDateTime: (iso) => fmt.dateTime(iso),
    }),
  };
}

/** The header every provider page shares: the way back, the name, one line on what it does. */
export function ProviderPageHeader({ ws, id, children }: { ws: string; id: ProviderPageId; children?: React.ReactNode }) {
  const def = providerPage(id);
  if (!def) return null;
  return (
    <header className="flex flex-col gap-1">
      <Link href={`/w/${ws}/settings/integrations`} className="mb-2 self-start text-label text-primary-text hover:underline">
        ← Integrations
      </Link>
      <h1 className="text-lg font-bold leading-[1.3] tracking-[-0.01em] text-ink">{def.label}</h1>
      <p className="text-body text-muted">{children ?? def.blurb}</p>
    </header>
  );
}

/** The OAuth redirect: a top-level navigation, the API 302s to the provider and back to its page. */
function oauthStart(ws: string, providerId: string) {
  window.location.href = `${API_URL}/api/v1/workspaces/${ws}/connections/oauth/${providerId}/start`;
}

/**
 * Ticket #1188 — THE connection card. Every provider page renders this one component: connect, test, disconnect, and the health line.
 * What it shows is `providerPageSnapshot`'s verdict (pure, tested per state); this file only draws it and calls the API.
 *
 * Disconnect asks first through the shared confirm (`confirmDisconnectProvider`), naming what stops. A provider the API cannot test
 * live says so when Test is pressed rather than reporting a check that never happened.
 */
export function ProviderConnectionCard({ ws, id }: { ws: string; id: ProviderPageId }) {
  const def = providerPage(id);
  if (!def) return null;
  return <Card ws={ws} def={def} />;
}

function Card({ ws, def }: { ws: string; def: ProviderPageDef }) {
  const { snapshot, failed } = useProviderSnapshot(ws, def);
  const search = useSearchParams();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const toasted = useRef(false);

  // The OAuth callback and the old /connections links land here with `?connected=` / `?error=`: say so once.
  useEffect(() => {
    if (toasted.current) return;
    const connected = search.get('connected');
    const error = search.get('error');
    if (!connected && !error) return;
    toasted.current = true;
    if (connected) toast.success(`${def.label} connected`);
    if (error) toast.error(`Connection failed: ${error}`);
  }, [search, def.label]);

  const invalidate = () => connectionCaches(ws).forEach((queryKey) => void qc.invalidateQueries({ queryKey }));

  const disconnect = useMutation({
    mutationFn: async (row: CardRow) => {
      if (row.connectionId) {
        const { error } = await api.DELETE('/api/v1/workspaces/{ws}/connections/{id}', { params: { path: { ws, id: row.connectionId } } } as never);
        if (error) throw error;
        return;
      }
      if (def.backing.kind !== 'integration') return;
      // Each platform is its own literal OpenAPI path (no `{id}` path param exists on the server), so dispatch explicitly.
      const path =
        def.backing.endpoint === 'github'
          ? '/api/v1/workspaces/{ws}/integrations/github/disconnect'
          : def.backing.endpoint === 'linear'
            ? '/api/v1/workspaces/{ws}/integrations/linear/disconnect'
            : '/api/v1/workspaces/{ws}/integrations/slack/disconnect';
      const { error } = await api.POST(path, { params: { path: { ws } } } as never);
      if (error) throw error;
    },
    onSuccess: (_d, row) => {
      toast.success(`Disconnected ${row.name}`);
      posthog.capture('integration_disconnected', { integration_id: def.id });
      invalidate();
    },
    onError: () => toast.error('Could not disconnect. Try again.'),
  });

  const test = useMutation({
    mutationFn: async (row: CardRow): Promise<{ message: string; live: boolean }> => {
      if (row.connectionId) {
        const { error } = await api.POST('/api/v1/workspaces/{ws}/connections/{id}/test', { params: { path: { ws, id: row.connectionId } } } as never);
        if (error) throw error;
        return { message: `${row.name} is working.`, live: true };
      }
      if (def.backing.kind !== 'integration') return { message: '', live: false };
      if (def.backing.endpoint === 'slack') {
        const { error } = await api.POST('/api/v1/workspaces/{ws}/integrations/slack/test', { params: { path: { ws } } } as never);
        if (error) throw new Error(friendlySlackTestError((error as { error?: { message?: string } })?.error?.message ?? 'Test message failed'));
        return { message: 'Test message sent to Slack.', live: true };
      }
      if (def.backing.endpoint === 'github') {
        // The one live read the API offers for GitHub: the installation's repositories, fetched from GitHub with the saved credential.
        const { error } = await api.GET('/api/v1/workspaces/{ws}/integrations/github/repos', { params: { path: { ws } } } as never);
        if (error) {
          const message = (error as { error?: { message?: string } })?.error?.message ?? '';
          if (/Connect the GitHub App|not configured/i.test(message)) {
            return { message: 'A personal access token has no live check yet. Sync now is the way to confirm it works.', live: false };
          }
          throw new Error(message || 'GitHub did not answer.');
        }
        return { message: 'GitHub answered: the installation can list its repositories.', live: true };
      }
      // Linear: no read-only live check exists (a Preview reads every issue). Say what was refreshed instead of claiming a test.
      return { message: 'Status refreshed. This reads the last sync StoryOS recorded; it does not call Linear, which has no quick check yet.', live: false };
    },
    // A check that did not call the provider is reported as information, never as a pass.
    onSuccess: ({ message, live }) => {
      if (live) toast.success(message);
      else toast.info(message);
      invalidate();
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : apiErrorMessage(error, 'The check failed')),
  });

  const resume = useMutation({
    mutationFn: async (row: CardRow) => {
      const { error } = await api.POST('/api/v1/workspaces/{ws}/connections/{id}/resume', { params: { path: { ws, id: row.connectionId } } } as never);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success('Resumed. Jobs will start claiming again.');
      invalidate();
    },
    onError: (error) => toast.error(apiErrorMessage(error, 'Could not resume this connection')),
  });

  if (failed) {
    return (
      <p role="alert" className="rounded-[var(--radius-card)] border border-border-default bg-card px-3.5 py-3 text-body text-error">
        Could not read the status of {def.label}. Reload to try again; nothing was changed.
      </p>
    );
  }
  if (!snapshot) return <div className="rounded-[var(--radius-card)] border border-border-default bg-card px-3.5 py-3 text-body text-muted">Loading…</div>;

  const Icon = PROVIDER_ICONS[def.id];
  const showConnect = snapshot.rows.length === 0 || (def.backing.kind === 'connections' && def.backing.addAnother);

  async function askAndDisconnect(row: CardRow) {
    if (!def.disconnectEffect) return;
    if (!(await confirm(confirmDisconnectProvider(row.name, def.disconnectEffect)))) return;
    disconnect.mutate(row);
  }

  return (
    <section
      className="rounded-[var(--radius-card)] border border-border-default bg-card"
      aria-label={`${def.label} connection`}
      data-testid="connection-card"
      data-state={snapshot.overall.state}
    >
      {snapshot.rows.map((row) => (
        <ConnectionRowView
          key={row.key}
          row={row}
          icon={<Icon className="h-3.5 w-3.5" aria-hidden />}
          testLabel={def.backing.kind === 'integration' && def.backing.test === 'status' ? 'Refresh status' : 'Test'}
          busy={disconnect.isPending || test.isPending}
          onTest={() => test.mutate(row)}
          onDisconnect={() => void askAndDisconnect(row)}
          onReconnect={() => row.connection && oauthStart(ws, row.connection.provider)}
          onResume={() => resume.mutate(row)}
          ws={ws}
        />
      ))}

      {snapshot.rows.length === 0 && (
        <div className="flex min-h-[46px] flex-wrap items-center gap-3 px-3.5 py-2 text-body">
          <span className="flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-[var(--radius-chip)] bg-hover text-ink-secondary">
            <Icon className="h-3.5 w-3.5" aria-hidden />
          </span>
          <span className="flex min-w-0 flex-1 basis-48 flex-col leading-[1.35]">
            <b className="font-medium text-ink">{def.label}</b>
            <span className="text-label text-muted">{snapshot.overall.summary}</span>
          </span>
          <SettingsPill tone={snapshot.overall.pill.tone}>{snapshot.overall.pill.label}</SettingsPill>
        </div>
      )}

      {showConnect && (
        <ConnectArea
          ws={ws}
          def={def}
          options={snapshot.connect}
          hasRows={snapshot.rows.length > 0}
          addParam={search.get('add')}
          nameParam={search.get('name')}
        />
      )}
    </section>
  );
}

function ConnectionRowView({
  ws,
  row,
  icon,
  testLabel,
  busy,
  onTest,
  onDisconnect,
  onReconnect,
  onResume,
}: {
  ws: string;
  row: CardRow;
  icon: React.ReactNode;
  testLabel: string;
  busy: boolean;
  onTest: () => void;
  onDisconnect: () => void;
  onReconnect: () => void;
  onResume: () => void;
}) {
  const fmt = useDateFormat();
  const { model, advanced } = row;
  const has = (a: string) => model.actions.includes(a as never);
  const hasAdvanced = advanced.errorCount24h > 0 || advanced.breakerOpenUntil || advanced.baseUrl || advanced.bounceWebhook;
  return (
    <div className="border-t border-border-default first:border-t-0" data-testid="connection-row">
      <div className="flex min-h-[46px] flex-wrap items-center gap-3 px-3.5 py-2 text-body max-md:[&>button]:h-9 max-md:[&>button]:flex-1">
        <span className="flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-[var(--radius-chip)] bg-hover text-ink-secondary">{icon}</span>
        <span className="flex min-w-0 flex-1 flex-col leading-[1.35] max-md:basis-full">
          <b className="truncate font-medium text-ink">
            {row.name}
            {row.preset && <span className="ml-1.5 font-normal text-muted">· {row.preset.label} preset</span>}
          </b>
          <span className={subLineClass(model.state)} data-testid="connection-summary">
            {model.state === 'needs_attention' ? model.summary : (row.subtitle ?? model.summary)}
          </span>
        </span>
        <span className="max-md:mr-[100%]">
          <SettingsPill tone={model.pill.tone}>{model.pill.label}</SettingsPill>
        </span>
        {row.advanced.needsBaseUrl && row.connection && <BaseUrlDialog ws={ws} connection={row.connection} />}
        {has('test') && (
          <Button size="sm" variant="secondary" onClick={onTest} disabled={busy}>
            {testLabel}
          </Button>
        )}
        {has('reconnect') && (
          <Button size="sm" variant="secondary" onClick={onReconnect}>
            Reconnect
          </Button>
        )}
        {has('disconnect') && (
          <Button size="sm" variant="destructive" onClick={onDisconnect} disabled={busy}>
            Disconnect
          </Button>
        )}
      </div>
      {(hasAdvanced || (row.connection?.provider === 'http' && !advanced.needsBaseUrl)) && (
        <details className="border-t border-border-default px-3.5 py-2 text-label text-muted">
          <summary className="cursor-pointer select-none font-medium text-ink-secondary">Advanced</summary>
          <div className="mt-2 flex flex-col gap-2">
            {row.connection?.provider === 'http' && !advanced.needsBaseUrl && (
              <div className="flex flex-wrap items-center gap-2">
                <span className="min-w-0 flex-1 truncate">{advanced.baseUrl ? `Sends its credential only to ${advanced.baseUrl}` : 'No base URL set.'}</span>
                <BaseUrlDialog ws={ws} connection={row.connection} />
              </div>
            )}
            {advanced.errorCount24h > 0 && (
              <p className={advanced.errorCount24h >= 5 ? 'text-error' : 'text-warning-text'}>
                {advanced.errorCount24h} failed {advanced.errorCount24h === 1 ? 'job' : 'jobs'} in the last 24 hours
              </p>
            )}
            {advanced.breakerOpenUntil && (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-error">Paused until {fmt.dateTime(advanced.breakerOpenUntil)}</span>
                <Button size="sm" variant="secondary" onClick={onResume}>
                  Resume
                </Button>
              </div>
            )}
            {advanced.bounceWebhook && row.connection && (
              <p className="truncate text-meta">Bounce webhook: {API_URL}/api/v1/providers/resend/webhook/{row.connection.id}</p>
            )}
          </div>
        </details>
      )}
    </div>
  );
}

function ConnectArea({
  ws,
  def,
  options,
  hasRows,
  addParam,
  nameParam,
}: {
  ws: string;
  def: ProviderPageDef;
  options: ConnectOptionView[];
  hasRows: boolean;
  addParam: string | null;
  nameParam: string | null;
}) {
  const integration = def.backing.kind === 'integration' ? def.backing.endpoint : null;
  const anchor = integration ? CONNECT_ANCHOR[integration] : undefined;
  const controls: React.ReactNode[] = [];
  const notes: string[] = [];

  if (integration === 'github') {
    controls.push(
      <Button key="gh" size="sm" variant="secondary" onClick={() => (window.location.href = `${API_URL}/api/v1/workspaces/${ws}/integrations/github/connect`)}>
        Connect GitHub
      </Button>,
    );
  } else if (anchor) {
    controls.push(
      <Button
        key="anchor"
        size="sm"
        variant="secondary"
        onClick={() => {
          const el = document.getElementById(anchor.target);
          el?.scrollIntoView({ block: 'center' });
          el?.focus();
        }}
      >
        {anchor.label}
      </Button>,
    );
  }

  for (const o of options) {
    if (integration) break;
    const variant = hasRows ? 'secondary' : 'primary';
    if (o.control === 'oauth') {
      controls.push(
        <Button key={o.providerId + o.label} size="sm" variant={variant} disabled={!o.info?.oauth?.configured} onClick={() => oauthStart(ws, o.providerId)}>
          {o.info?.oauth?.configured ? o.label : 'Not configured'}
        </Button>,
      );
      if (!o.info?.oauth?.configured) notes.push('This server has no client id and secret configured for this provider, so it cannot connect yet.');
    } else if (o.control === 'api-key' && o.info) {
      controls.push(
        <ApiKeyConnectDialog
          key={o.providerId}
          ws={ws}
          provider={o.info}
          trigger={{ label: o.label, variant }}
          initialName={nameParam ?? undefined}
          autoOpen={addParam === o.providerId}
        />,
      );
    } else if (o.control === 'http') {
      controls.push(
        <HttpConnectDialog
          key={o.providerId + (o.presetId ?? '')}
          ws={ws}
          trigger={{ label: o.label, variant }}
          presetId={o.presetId}
          initialName={nameParam ?? undefined}
          autoOpen={addParam === 'http' && (o.presetId ? o.presetId === def.id : true)}
        />,
      );
    } else if (o.availability !== 'connectable') {
      // `operator_config` and `cloud_only` are information, never a button: a Connect that cannot work is worse than none. With a
      // single choice and no row the header row already says it, so the note is only added where it would otherwise be missing.
      if (hasRows || options.length > 1) {
        const text =
          o.availability === 'cloud_only'
            ? (o.note ?? 'Available on StoryOS Cloud: this integration is not offered on a self-managed deployment.')
            : (o.note ?? 'Configured by your admin: set up in the self-hosting settings, not per user here.');
        notes.push(`${o.label} is unavailable. ${text}`);
      }
    }
  }

  if (controls.length === 0 && notes.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 border-t border-border-default px-3.5 py-2.5 first:border-t-0 max-md:[&>button]:h-9 max-md:[&>button]:flex-1">
      {controls}
      {notes.map((n) => (
        <p key={n} className="basis-full text-label text-muted" data-testid="availability-note">
          {n}
        </p>
      ))}
    </div>
  );
}
