'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import posthog from 'posthog-js';
import {
  Bot,
  Check,
  CheckCircle2,
  CircleAlert,
  Clipboard,
  Cloud,
  ExternalLink,
  KeyRound,
  Loader2,
  RefreshCw,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

const MCP_ENDPOINT = 'https://mcp.storyos.dev/mcp';
const MCP_ORIGIN = 'https://mcp.storyos.dev';

type Client = 'claude' | 'chatgpt';
type CheckState = 'idle' | 'checking' | 'ready' | 'failed';

const CLIENTS: Record<
  Client,
  {
    label: string;
    availability: string;
    steps: string[];
    reference: string;
  }
> = {
  claude: {
    label: 'Claude',
    availability: 'Claude Pro, Max, Team, and Enterprise',
    steps: [
      'Open Settings → Connectors. Team and Enterprise owners should first choose Organization connectors.',
      'Choose Add custom connector, name it StoryOS, and paste the endpoint below.',
      'Choose Add, then Connect. Sign in to StoryOS and approve access.',
      'In a chat, open Search and tools, enable StoryOS, and ask it to list your workspaces.',
    ],
    reference:
      'https://support.anthropic.com/en/articles/11175166-about-custom-integrations-using-remote-mcp',
  },
  chatgpt: {
    label: 'ChatGPT',
    availability: 'ChatGPT Business, Enterprise, and Edu on the web',
    steps: [
      'An admin or owner enables developer mode in Workspace Settings → Permissions & Roles.',
      'Open Settings → Apps → Create, then provide the StoryOS endpoint below.',
      'Choose OAuth authentication and Scan tools. Sign in to StoryOS when prompted.',
      'Choose Create, start a new chat, enable the StoryOS app, and ask it to list your workspaces.',
    ],
    reference:
      'https://help.openai.com/en/articles/12584461-developer-mode-apps-and-full-mcp-connectors-in-chatgpt-beta',
  },
};

async function copy(value: string, event: string, properties?: Record<string, string>) {
  await navigator.clipboard.writeText(value);
  posthog.capture(event, properties);
  toast.success('Copied');
}

export default function McpIntegrationPage() {
  const { ws } = useParams<{ ws: string }>();
  const [client, setClient] = useState<Client>('claude');
  const [checkState, setCheckState] = useState<CheckState>('idle');
  const [checkMessage, setCheckMessage] = useState('');
  const selected = CLIENTS[client];

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
    <div className="mx-auto max-w-3xl p-4 sm:p-8">
      <Link
        className="text-[12px] text-muted hover:text-ink"
        href={`/w/${ws}/settings/integrations`}
      >
        ← Integrations
      </Link>

      <div className="mt-6 flex items-center gap-3">
        <span className="flex h-11 w-11 items-center justify-center rounded-[var(--radius-control)] bg-hover">
          <Bot className="h-6 w-6 text-ink" />
        </span>
        <div>
          <h1 className="text-lg font-semibold text-ink">Connect Claude or ChatGPT</h1>
          <p className="text-[13px] text-muted">
            Give your AI client access to StoryOS tools through MCP.
          </p>
        </div>
      </div>

      <section className="mt-6 rounded-[var(--radius-card)] border border-border-default bg-card p-5">
        <div className="flex items-start gap-3">
          <Cloud className="mt-0.5 h-5 w-5 shrink-0 text-ink" />
          <div>
            <h2 className="text-sm font-semibold text-ink">Hosted StoryOS — use OAuth</h2>
            <p className="mt-1 text-[13px] text-muted">
              Recommended for app.storyos.dev. You paste one endpoint, then sign in to StoryOS.
              There is no API token to create or copy.
            </p>
          </div>
        </div>

        <div className="mt-5 grid grid-cols-2 gap-2" role="tablist" aria-label="MCP client">
          {(Object.keys(CLIENTS) as Client[]).map((id) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={client === id}
              className={cn(
                'rounded-[var(--radius-control)] border px-3 py-2 text-sm font-medium transition-colors',
                client === id
                  ? 'border-border-strong bg-active text-ink'
                  : 'border-border-default text-muted hover:bg-hover hover:text-ink',
              )}
              onClick={() => {
                setClient(id);
                posthog.capture('mcp_setup_client_selected', {
                  client: id,
                  auth_path: 'oauth',
                });
              }}
            >
              {CLIENTS[id].label}
            </button>
          ))}
        </div>

        <p className="mt-4 text-[12px] text-faint">{selected.availability}</p>
        <ol className="mt-3 space-y-3">
          {selected.steps.map((step, index) => (
            <li key={step} className="flex gap-3 text-[13px] text-muted">
              <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-hover text-[11px] font-semibold text-ink">
                {index + 1}
              </span>
              <span>{step}</span>
            </li>
          ))}
        </ol>

        <div className="mt-5 rounded-[var(--radius-control)] border border-border-default bg-page p-3">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-faint">
            MCP endpoint
          </p>
          <div className="mt-1 flex items-center gap-2">
            <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap text-[13px] text-ink">
              {MCP_ENDPOINT}
            </code>
            <Button
              size="sm"
              variant="secondary"
              aria-label="Copy MCP endpoint"
              onClick={() => {
                posthog.capture('mcp_setup_started', { client, auth_path: 'oauth' });
                void copy(MCP_ENDPOINT, 'mcp_endpoint_copied', {
                  client,
                  auth_path: 'oauth',
                });
              }}
            >
              <Clipboard className="mr-1 h-3.5 w-3.5" />
              Copy
            </Button>
          </div>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Button
            variant="secondary"
            disabled={checkState === 'checking'}
            onClick={() => void checkHostedService()}
          >
            {checkState === 'checking' ? (
              <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="mr-1.5 h-4 w-4" />
            )}
            Check hosted service
          </Button>
          <a
            className="inline-flex items-center gap-1 text-[12px] text-muted hover:text-ink"
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
              'mt-4 flex items-start gap-2 rounded-[var(--radius-control)] border p-3 text-[12px]',
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
      </section>

      <section className="mt-5 rounded-[var(--radius-card)] border border-border-default bg-card p-5">
        <div className="flex items-start gap-3">
          <KeyRound className="mt-0.5 h-5 w-5 shrink-0 text-ink" />
          <div>
            <h2 className="text-sm font-semibold text-ink">Self-managed or advanced client</h2>
            <p className="mt-1 text-[13px] text-muted">
              Keep the PAT path for your own StoryOS deployment, scripts, n8n, or a client that
              supports custom Authorization headers. Do not paste a PAT into the hosted OAuth flow.
            </p>
          </div>
        </div>
        <ol className="mt-4 space-y-2 text-[13px] text-muted">
          <li className="flex gap-2">
            <Check className="mt-0.5 h-4 w-4 shrink-0 text-ink" />
            Create a workspace-scoped personal access token. It is shown only once.
          </li>
          <li className="flex gap-2">
            <Check className="mt-0.5 h-4 w-4 shrink-0 text-ink" />
            Use your deployment's MCP URL ending in <code>/mcp</code>.
          </li>
          <li className="flex gap-2">
            <Check className="mt-0.5 h-4 w-4 shrink-0 text-ink" />
            Send it as <code>Authorization: Bearer mn_pat_…</code> and revoke it if exposed.
          </li>
        </ol>
        <Link
          className="mt-4 inline-block"
          href={`/w/${ws}/settings/api`}
          onClick={() =>
            posthog.capture('mcp_setup_started', {
              client: 'advanced',
              auth_path: 'pat',
            })
          }
        >
          <Button variant="secondary">Manage API tokens</Button>
        </Link>
      </section>

      <section className="mt-5 rounded-[var(--radius-card)] border border-border-default bg-card p-5">
        <h2 className="text-sm font-semibold text-ink">Troubleshooting</h2>
        <dl className="mt-3 space-y-3 text-[13px]">
          <div>
            <dt className="font-medium text-ink">The client says the URL is invalid</dt>
            <dd className="text-muted">
              Use the complete HTTPS endpoint above, including <code>/mcp</code>. Do not use the
              app.storyos.dev page URL.
            </dd>
          </div>
          <div>
            <dt className="font-medium text-ink">No sign-in window appears</dt>
            <dd className="text-muted">
              Run the hosted-service check, remove the draft connector, and add it again so the
              client reloads OAuth discovery.
            </dd>
          </div>
          <div>
            <dt className="font-medium text-ink">Authorization expired or was revoked</dt>
            <dd className="text-muted">
              Disconnect StoryOS in the AI client's connector settings, reconnect it, and approve
              access again.
            </dd>
          </div>
          <div>
            <dt className="font-medium text-ink">A workspace is missing</dt>
            <dd className="text-muted">
              Sign in with the StoryOS account that belongs to that workspace. MCP follows the same
              membership and space permissions as the app.
            </dd>
          </div>
        </dl>
      </section>
    </div>
  );
}
