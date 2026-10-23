'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import posthog from 'posthog-js';
import { CheckCircle2, CircleAlert, Clipboard, ExternalLink, Loader2, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { AiConnectionsSection } from '@/components/settings/ai-connections-list';
import { ClientLogo } from '@/components/connect-ai-logos';
import { cn } from '@/lib/utils';
import { MCP_ENDPOINT, MCP_ORIGIN, api } from '@/lib/api';
import { canConnectAi } from '@/lib/settings-nav';
import { useAiConnected } from '@/lib/sidebar-ai';
import {
  CONNECTOR_NAME,
  CONNECT_CLIENTS,
  type ConnectClient,
  type ConnectStep,
} from '@/lib/connect-ai-steps';

/** Public PKCE client registered for Claude's claude.ai and claude.com MCP callbacks. */
const CLAUDE_OAUTH_CLIENT_ID = 'nLwKFQBfhAnwhztfvCnlrNXyJmwHdJdI';

type CheckState = 'idle' | 'checking' | 'ready' | 'failed';

const CLIENT_IDS = Object.keys(CONNECT_CLIENTS) as ConnectClient[];

async function copy(value: string, event: string, properties?: Record<string, string>) {
  await navigator.clipboard.writeText(value);
  posthog.capture(event, properties);
  toast.success('Copied');
}

/** The connector name or the server address, in a box with its own Copy button. */
function CopyBox({ value, label, onCopy }: { value: string; label: string; onCopy: () => void }) {
  return (
    <div className="mt-1.5 flex items-center gap-2 rounded-[var(--radius-control)] border border-border-default bg-card py-1.5 pl-2.5 pr-1.5">
      <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap font-mono text-[11px] text-ink">
        {value}
      </code>
      <Button size="sm" variant="secondary" aria-label={`Copy ${label}`} onClick={onCopy}>
        <Clipboard className="mr-1 h-3 w-3" />
        Copy
      </Button>
    </div>
  );
}

function Step({ step, client }: { step: ConnectStep; client: ConnectClient }) {
  return (
    <li className="mb-3 pl-1 marker:text-muted">
      {step.runs.map((r, i) =>
        r.bold ? (
          <b key={i} className="font-semibold text-ink">
            {r.text}
          </b>
        ) : (
          <span key={i} className={r.muted ? 'text-muted' : undefined}>
            {r.text}
          </span>
        ),
      )}
      {step.block === 'name' && (
        <CopyBox
          value={CONNECTOR_NAME}
          label="connector name"
          onCopy={() =>
            void copy(CONNECTOR_NAME, 'mcp_connector_name_copied', { client, auth_path: 'oauth' })
          }
        />
      )}
      {step.block === 'addr' && (
        <CopyBox
          value={MCP_ENDPOINT}
          label="server address"
          onCopy={() => {
            posthog.capture('mcp_setup_started', { client, auth_path: 'oauth' });
            void copy(MCP_ENDPOINT, 'mcp_endpoint_copied', { client, auth_path: 'oauth' });
          }}
        />
      )}
    </li>
  );
}

/**
 * #1003 — the connected state (the prototype's okcard). Today the API says only THAT an AI is connected
 * (`ai_connected || mcp_oauth_connected`), not which one or since when, so this card says exactly that and no more.
 * The per-client list and the Disconnect button wait for ticket #1008's endpoint; until then the way to disconnect is
 * the one that is true today — remove StoryOS in the AI client's own connector settings.
 */
function ConnectedCard({ onAnother }: { onAnother: () => void }) {
  return (
    <>
      <div className="mb-3 rounded-[var(--radius-card)] border border-border-default bg-card p-4" data-testid="ai-connected">
        <div className="mb-2 flex items-center gap-2">
          <span aria-hidden className="h-[9px] w-[9px] rounded-full bg-success" />
          <b className="font-semibold text-ink">Your AI is connected</b>
        </div>
        <p className="mb-2 text-body leading-[1.55] text-ink-secondary">
          Everything it does in StoryOS is marked as its own in history, under your name — so you always
          know what you did and what it did.
        </p>
        <p className="mb-3 text-body leading-[1.55] text-ink-secondary">
          To disconnect, use the list below, or remove <b className="font-semibold text-ink">{CONNECTOR_NAME}</b> in
          your AI’s connector settings.
        </p>
        <p className="mb-1 text-label font-semibold uppercase tracking-[0.06em] text-muted">Try asking it</p>
        {[
          'What’s waiting for me in StoryOS?',
          'Summarise the open bugs on Issues by priority',
          'Draft a ticket for: the sidebar caret is too small on phones',
        ].map((q) => (
          <div key={q} className="mb-1.5 rounded-[var(--radius-control)] bg-hover px-[11px] py-2 text-body text-ink">
            “{q}”
          </div>
        ))}
      </div>
      <button type="button" className="text-label font-medium text-accent-text hover:underline" onClick={onAnother}>
        Connect another AI →
      </button>
    </>
  );
}

function ConnectAiContent({ workspaceName }: { workspaceName: string }) {
  const { ws } = useParams<{ ws: string }>();
  const [client, setClient] = useState<ConnectClient>('claude');
  const [adding, setAdding] = useState(false);
  const [checking, setChecking] = useState(false);
  const [notYet, setNotYet] = useState(false);
  const [checkState, setCheckState] = useState<CheckState>('idle');
  const [checkMessage, setCheckMessage] = useState('');
  const connected = useAiConnected(ws);
  const selected = CONNECT_CLIENTS[client];
  const showConnected = connected.data === true && !adding;

  async function checkConnection() {
    setChecking(true);
    setNotYet(false);
    posthog.capture('mcp_setup_connection_checked', { client, auth_path: 'oauth' });
    const fresh = await connected.refetch();
    setChecking(false);
    const ok = fresh.data === true;
    if (ok) {
      setAdding(false);
      toast.success('Your AI is connected');
    } else setNotYet(true);
  }

  async function checkHostedService() {
    setCheckState('checking');
    setCheckMessage('');
    posthog.capture('mcp_setup_check_started', { client, auth_path: 'oauth' });
    try {
      const [health, metadata] = await Promise.all([
        fetch(`${MCP_ORIGIN}/health`, { headers: { Accept: 'application/json' } }),
        fetch(`${MCP_ORIGIN}/.well-known/oauth-protected-resource`, {
          headers: { Accept: 'application/json' },
        }),
      ]);
      if (!health.ok || !metadata.ok) {
        throw new Error(`Endpoint returned ${!health.ok ? health.status : metadata.status}`);
      }
      const oauth = (await metadata.json()) as {
        authorization_servers?: string[];
        scopes_supported?: string[];
      };
      if (
        !oauth.authorization_servers?.length ||
        !oauth.scopes_supported?.includes('storyos.mcp')
      ) {
        throw new Error('OAuth discovery is incomplete');
      }
      setCheckState('ready');
      setCheckMessage(
        'The hosted endpoint is online and advertising StoryOS OAuth. Continue in your selected client.',
      );
      posthog.capture('mcp_setup_check_succeeded', { client, auth_path: 'oauth' });
    } catch (error) {
      setCheckState('failed');
      setCheckMessage(
        `The hosted endpoint could not be verified${error instanceof Error ? `: ${error.message}` : ''}.`,
      );
      posthog.capture('mcp_setup_check_failed', {
        client,
        auth_path: 'oauth',
        reason: error instanceof Error ? error.message.slice(0, 120) : 'unknown',
      });
    }
  }

  return (
    <div className="mx-auto max-w-[700px] p-4 sm:p-8">
      <h1 className="text-[22px] font-bold tracking-[-0.02em] text-ink">Connect your AI</h1>
      <p className="mb-4 mt-1 text-body leading-normal text-muted">
        {showConnected
          ? 'Your AI can work in StoryOS — and everything it does is marked as its own.'
          : 'Use StoryOS from the AI you already talk to. Pick yours:'}
      </p>

      {showConnected ? (
        <ConnectedCard onAnother={() => setAdding(true)} />
      ) : (
        <>
          <div className="mb-2 mt-1 flex flex-wrap gap-1.5" role="tablist" aria-label="AI client">
            {CLIENT_IDS.map((id) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={client === id}
                className={cn(
                  'inline-flex h-[34px] items-center gap-2 rounded-[var(--radius-control)] border bg-card px-3.5 text-body font-semibold',
                  client === id
                    ? 'border-ink text-ink shadow-[inset_0_0_0_1px_var(--text-primary)]'
                    : 'border-border-default text-ink-secondary hover:border-border-strong',
                )}
                onClick={() => {
                  setClient(id);
                  posthog.capture('mcp_setup_client_selected', { client: id, auth_path: 'oauth' });
                }}
              >
                <ClientLogo client={id} />
                {CONNECT_CLIENTS[id].label}
              </button>
            ))}
          </div>
          <p className="text-label text-muted">{selected.plans}</p>
          <ol className="mb-[18px] mt-3.5 list-decimal pl-[22px] text-body leading-[1.6] text-ink">
            {selected.steps(workspaceName).map((step, i) => (
              <Step key={`${client}-${i}`} step={step} client={client} />
            ))}
          </ol>
          <div className="flex flex-wrap items-center gap-3">
            <Button size="sm" disabled={checking} onClick={() => void checkConnection()}>
              {checking && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
              I’ve done it — check the connection
            </Button>
            {notYet && (
              <span className="text-label text-muted" role="status">
                Not connected yet — finish the steps in {selected.label} and check again.
              </span>
            )}
          </div>
        </>
      )}

      <AiConnectionsSection ws={ws} />

      <details className="mt-3.5 text-label text-muted">
        <summary className="cursor-pointer font-semibold">Advanced — tokens and self-managed StoryOS</summary>
        <p className="mt-2 leading-[1.6]">
          Create a workspace-scoped personal access token (shown once) and send it as{' '}
          <code className="font-mono text-[11px]">Authorization: Bearer mn_pat_…</code>. On a self-managed
          deployment, use your own address ending in <code className="font-mono text-[11px]">/mcp</code>. Do
          not paste a token into the hosted sign-in flow.{' '}
          <Link
            className="font-medium text-accent-text hover:underline"
            href={`/w/${ws}/settings/api`}
            onClick={() => posthog.capture('mcp_setup_started', { client: 'advanced', auth_path: 'pat' })}
          >
            Manage API tokens →
          </Link>
        </p>
      </details>

      <details className="mt-3.5 text-label text-muted">
        <summary className="cursor-pointer font-semibold">Troubleshooting</summary>
        <ul className="mt-2 list-disc space-y-1 pl-[18px] leading-[1.7]">
          <li>
            Claude says it couldn’t register with StoryOS — remove the draft connector and add it again. If it
            still fails, open <b>Advanced settings</b>, paste this public Client ID and leave Client Secret empty:
            <CopyBox
              value={CLAUDE_OAUTH_CLIENT_ID}
              label="Claude client ID"
              onCopy={() =>
                void copy(CLAUDE_OAUTH_CLIENT_ID, 'mcp_oauth_client_id_copied', {
                  client: 'claude',
                  auth_path: 'oauth',
                })
              }
            />
          </li>
          <li>
            The client says the address is invalid — use the whole address above, including{' '}
            <code className="font-mono text-[11px]">/mcp</code>. Not the page address of StoryOS.
          </li>
          <li>No sign-in window appears — check your browser’s pop-up blocker, then remove the draft connector and add it again.</li>
          <li>Access expired or was revoked — disconnect StoryOS in your AI’s connector settings and connect again.</li>
          <li>A workspace is missing — sign in with the StoryOS account that belongs to it; you can only pick workspaces you are a member of.</li>
        </ul>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <Button size="sm" variant="secondary" disabled={checkState === 'checking'} onClick={() => void checkHostedService()}>
            {checkState === 'checking' ? (
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
            )}
            Check hosted service
          </Button>
          <a
            className="inline-flex items-center gap-1 text-label text-muted hover:text-ink"
            href={selected.reference}
            target="_blank"
            rel="noreferrer"
          >
            {selected.label} connector reference
            <ExternalLink className="h-3 w-3" />
          </a>
        </div>
        {checkState !== 'idle' && checkState !== 'checking' && (
          <div
            className={cn(
              'mt-3 flex items-start gap-2 rounded-[var(--radius-control)] border p-3 text-label',
              checkState === 'ready'
                ? 'border-green-600/25 bg-green-600/5 text-ink'
                : 'border-red-600/25 bg-red-600/5 text-ink',
            )}
            role="status"
          >
            {checkState === 'ready' ? (
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-green-700" />
            ) : (
              <CircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-red-700" />
            )}
            <span>{checkMessage}</span>
          </div>
        )}
      </details>
    </div>
  );
}

/**
 * Ticket #875 — Connect your AI, at its OWN route (it used to live under the admin-only
 * Integrations catalogue). Gated like API tokens: anyone who can mint the credential this page
 * explains (`role !== 'guest'`) can open it; a guest cannot. The nav hides the entry from a guest,
 * and this page refuses a guest who types the URL, because hiding a link is not a gate.
 */
export default function ConnectAiPage() {
  const { ws } = useParams<{ ws: string }>();
  const workspace = useQuery({
    queryKey: ['workspace', ws],
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/workspaces/{ws}', { params: { path: { ws } } } as never);
      if (error) throw error;
      return data as unknown as { role: string; name: string };
    },
  });
  if (workspace.isPending) return <p className="p-6 text-body text-muted">Loading…</p>;
  if (workspace.isError) {
    return (
      <p className="p-6 text-body text-error" role="alert">
        Could not check your access. Try again in a moment.
      </p>
    );
  }
  if (!canConnectAi(workspace.data.role)) {
    return (
      <div className="p-6">
        <h1 className="text-title font-semibold text-ink">Connect your AI</h1>
        <p className="mt-2 max-w-prose text-body text-muted">
          Connecting an AI client needs a personal access token, which guests cannot create. Ask a workspace admin if you need access.
        </p>
      </div>
    );
  }
  return <ConnectAiContent workspaceName={workspace.data.name} />;
}
