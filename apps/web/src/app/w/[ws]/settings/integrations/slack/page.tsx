'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, CheckCircle2, MessageSquare, XCircle } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

const DOCS_URL = 'https://docs.storyos.dev/integrations/slack';
const BOT_TOKEN_PATTERN = /^xoxb-/;
const WEBHOOK_PATTERN = /^https:\/\/hooks\.slack\.com\/services\//;

type Method = 'bot' | 'webhook';

type SlackConfigResponse = { has_token: boolean; has_webhook: boolean; default_channel: string | null };
type TestResult = { ok: true; via: 'bot' | 'webhook'; channel?: string };
type ApiError = { error?: { message?: string } };

/** Friendlier copy for the Slack errors people actually hit when testing the connection. */
function friendlyTestError(message: string): string {
  if (message.includes('channel_not_found')) {
    return "Slack couldn't find that channel. Invite the bot to it first: /invite @YourAppName";
  }
  if (message.includes('not_in_channel')) {
    return 'The bot isn’t in that channel yet. Run /invite @YourAppName in Slack, then test again.';
  }
  if (message.includes('invalid_auth') || message.includes('token_revoked')) {
    return 'That token is invalid or was revoked. Copy a fresh Bot User OAuth Token from your Slack app.';
  }
  return message;
}

/**
 * Slack setup (MN-021, phase 1) — rewritten for #256: pick a connection method,
 * follow four inline numbered steps for it, then save and test. Phase 2 will
 * replace the token paste with a real OAuth install.
 */
export default function SlackIntegrationPage() {
  const { ws } = useParams<{ ws: string }>();
  const qc = useQueryClient();
  const [method, setMethod] = useState<Method>('bot');
  const [methodTouched, setMethodTouched] = useState(false);
  const [botToken, setBotToken] = useState('');
  const [webhookUrl, setWebhookUrl] = useState('');
  const [defaultChannel, setDefaultChannel] = useState('');
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);

  const config = useQuery({
    queryKey: ['slack-config', ws],
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/workspaces/{ws}/integrations/slack', {
        params: { path: { ws } },
      } as never);
      if (error) throw error;
      const cfg = data as unknown as SlackConfigResponse;
      setDefaultChannel((prev) => prev || cfg.default_channel || '');
      return cfg;
    },
  });

  // Default the method toggle to whatever is already connected, once (don't fight the user afterwards).
  useEffect(() => {
    if (methodTouched || !config.data) return;
    if (config.data.has_webhook && !config.data.has_token) setMethod('webhook');
  }, [config.data, methodTouched]);

  const connected = config.data?.has_token || config.data?.has_webhook;

  const botTokenValid = config.data?.has_token && !botToken.trim() ? true : BOT_TOKEN_PATTERN.test(botToken.trim());
  const webhookValid = config.data?.has_webhook && !webhookUrl.trim() ? true : WEBHOOK_PATTERN.test(webhookUrl.trim());
  const canSave = method === 'bot' ? botTokenValid : webhookValid;

  const save = useMutation({
    mutationFn: async () => {
      const body: Record<string, unknown> = {};
      if (method === 'bot' && botToken.trim()) body.bot_token = botToken.trim();
      if (method === 'webhook' && webhookUrl.trim()) body.webhook_url = webhookUrl.trim();
      if (defaultChannel.trim()) body.default_channel = defaultChannel.trim();
      const { error } = await api.POST('/api/v1/workspaces/{ws}/integrations/slack', {
        params: { path: { ws } },
        body: body as never,
      } as never);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success('Slack settings saved');
      setBotToken('');
      setWebhookUrl('');
      setTestResult(null);
      void qc.invalidateQueries({ queryKey: ['slack-config', ws] });
    },
    onError: (error) => toast.error((error as ApiError)?.error?.message ?? 'Could not save Slack settings'),
  });

  const test = useMutation({
    mutationFn: async () => {
      const { data, error } = await api.POST('/api/v1/workspaces/{ws}/integrations/slack/test', {
        params: { path: { ws } },
      } as never);
      if (error) throw error;
      return data as unknown as TestResult;
    },
    onSuccess: (result) => {
      const where = result.channel ? ` to ${result.channel}` : '';
      setTestResult({ ok: true, message: `Test message sent${where} via ${result.via === 'bot' ? 'bot token' : 'webhook'}.` });
    },
    onError: (error) => {
      const message = (error as ApiError)?.error?.message ?? 'Test message failed';
      setTestResult({ ok: false, message: friendlyTestError(message) });
    },
  });

  return (
    <div className="mx-auto max-w-2xl p-4 sm:p-8">
      <Link href={`/w/${ws}/settings/integrations`} className="mb-4 inline-flex items-center gap-1.5 text-[13px] text-muted hover:text-ink">
        <ArrowLeft className="h-3.5 w-3.5" /> Integrations
      </Link>
      <div className="mb-3 flex items-center gap-2">
        <MessageSquare className="h-6 w-6 text-ink" />
        <h1 className="text-lg font-semibold text-ink">Slack</h1>
        {connected && <span className="rounded-full bg-accent-soft px-2 py-0.5 text-[11px] text-ink">connected</span>}
      </div>
      <p className="mb-5 text-[13px] text-muted">
        Post messages to Slack from automations — add a &quot;Send Slack message&quot; action to any button or
        automation once this is connected.
      </p>

      {/* 1. Method choice first (progressive disclosure) */}
      <div className="mb-4 inline-flex rounded-[var(--radius-control)] border border-border-default bg-card p-0.5">
        <button
          type="button"
          onClick={() => {
            setMethod('bot');
            setMethodTouched(true);
          }}
          className={cn(
            'rounded-[calc(var(--radius-control)-2px)] px-3 py-1.5 text-[13px] font-medium transition-colors',
            method === 'bot' ? 'bg-primary text-[var(--text-on-dark)]' : 'text-ink-secondary hover:bg-hover',
          )}
        >
          Bot token <span className="opacity-75">(recommended)</span>
        </button>
        <button
          type="button"
          onClick={() => {
            setMethod('webhook');
            setMethodTouched(true);
          }}
          className={cn(
            'rounded-[calc(var(--radius-control)-2px)] px-3 py-1.5 text-[13px] font-medium transition-colors',
            method === 'webhook' ? 'bg-primary text-[var(--text-on-dark)]' : 'text-ink-secondary hover:bg-hover',
          )}
        >
          Webhook URL <span className="opacity-75">(simpler)</span>
        </button>
      </div>
      <p className="mb-4 text-[13px] text-muted">
        {method === 'bot'
          ? 'A bot token can post to any channel — recommended if you want different automations posting to different channels.'
          : 'An incoming webhook always posts to one fixed channel, chosen when you create it in Slack — simplest if one channel is all you need.'}
      </p>

      {/* 2. Doable instruction inline, per method */}
      <ol className="mb-2 flex list-decimal flex-col gap-1.5 pl-5 text-[13px] text-ink-secondary">
        {method === 'bot' ? (
          <>
            <li>
              Go to <code className="rounded bg-hover px-1 py-0.5">api.slack.com/apps</code> → Create New App → From
              scratch.
            </li>
            <li>
              Open <strong>OAuth &amp; Permissions</strong> → add the <code className="rounded bg-hover px-1 py-0.5">chat:write</code> scope → Install
              to Workspace.
            </li>
            <li>Copy the Bot User OAuth Token (starts with xoxb-) and paste it below.</li>
            <li>
              In Slack, invite the bot to a channel: <code className="rounded bg-hover px-1 py-0.5">/invite @YourAppName</code>.
            </li>
          </>
        ) : (
          <>
            <li>
              Go to <code className="rounded bg-hover px-1 py-0.5">api.slack.com/apps</code> → your app → Incoming
              Webhooks → activate.
            </li>
            <li>Add New Webhook to Workspace → pick a channel.</li>
            <li>Copy the URL (starts with hooks.slack.com/services/) and paste it below.</li>
          </>
        )}
      </ol>
      <p className="mb-5 text-[13px]">
        <a href={DOCS_URL} target="_blank" rel="noreferrer" className="text-accent hover:underline">
          Full setup guide with screenshots →
        </a>
      </p>

      <div className="flex flex-col gap-3">
        {method === 'bot' ? (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="slack-token">Bot token {config.data?.has_token && '(saved — enter to replace)'}</Label>
            <Input
              id="slack-token"
              type="password"
              placeholder="xoxb-…"
              value={botToken}
              onChange={(e) => setBotToken(e.target.value)}
            />
            <p className="text-[12px] text-muted">Paste the Bot User OAuth Token from your Slack app. Starts with xoxb-.</p>
            {botToken.trim() && !botTokenValid && (
              <p className="text-[12px] text-error">That doesn&apos;t look like a bot token — it should start with xoxb-.</p>
            )}
          </div>
        ) : (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="slack-webhook">Webhook URL {config.data?.has_webhook && '(saved — enter to replace)'}</Label>
            <Input
              id="slack-webhook"
              type="password"
              placeholder="https://hooks.slack.com/services/…"
              value={webhookUrl}
              onChange={(e) => setWebhookUrl(e.target.value)}
            />
            <p className="text-[12px] text-muted">Paste the Incoming Webhook URL from your Slack app. Starts with hooks.slack.com/services/.</p>
            {webhookUrl.trim() && !webhookValid && (
              <p className="text-[12px] text-error">That doesn&apos;t look like a Slack webhook URL — it should start with hooks.slack.com/services/.</p>
            )}
          </div>
        )}

        {method === 'bot' && (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="slack-channel">Default channel</Label>
            <Input id="slack-channel" placeholder="#general or C0123456789" value={defaultChannel} onChange={(e) => setDefaultChannel(e.target.value)} />
            <p className="text-[12px] text-muted">Where messages go if an action doesn&apos;t specify a channel. Use #channel-name.</p>
          </div>
        )}

        <p className="text-[12px] text-muted">Credentials stay on your server and are never shown again once saved.</p>

        {/* 3. Verify before trusting */}
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={() => save.mutate()} disabled={save.isPending || !canSave}>
            {save.isPending ? 'Saving…' : 'Save'}
          </Button>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              setTestResult(null);
              test.mutate();
            }}
            disabled={test.isPending || !connected}
            title={connected ? undefined : 'Save a bot token or webhook URL first'}
          >
            {test.isPending ? 'Sending…' : 'Send test message'}
          </Button>
        </div>

        {testResult && (
          <div
            className={cn(
              'flex items-start gap-2 rounded-[var(--radius-control)] border p-3 text-[13px]',
              testResult.ok ? 'border-border-default bg-accent-soft text-ink' : 'border-error/40 bg-error/5 text-error',
            )}
          >
            {testResult.ok ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" /> : <XCircle className="mt-0.5 h-4 w-4 shrink-0" />}
            <span>{testResult.message}</span>
          </div>
        )}
      </div>
    </div>
  );
}
