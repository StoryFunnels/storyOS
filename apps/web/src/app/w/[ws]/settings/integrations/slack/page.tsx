'use client';

import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Segmented } from '@/components/ui/segmented';

/* #738 — stable identity across renders. */
const SLACK_METHOD_OPTIONS = [
  { value: 'bot' as const, label: <>Bot token <span className="opacity-75">(recommended)</span></> },
  { value: 'webhook' as const, label: <>Webhook URL <span className="opacity-75">(simpler)</span></> },
];
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { SetupDisclosure } from '@/components/settings/setup-disclosure';
import { IntegrationSetupGuide } from '@/components/integration-setup-guide';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ProviderConnectionCard, ProviderPageHeader } from '@/components/settings/provider-card';

const DOCS_URL = 'https://docs.storyos.dev/integrations/slack';
const BOT_TOKEN_PATTERN = /^xoxb-/;
const WEBHOOK_PATTERN = /^https:\/\/hooks\.slack\.com\/services\//;

type Method = 'bot' | 'webhook';

type SlackConfigResponse = {
  has_token: boolean;
  has_webhook: boolean;
  default_channel: string | null;
};
type ApiError = { error?: { message?: string } };

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

  const botTokenValid =
    config.data?.has_token && !botToken.trim() ? true : BOT_TOKEN_PATTERN.test(botToken.trim());
  const webhookValid =
    config.data?.has_webhook && !webhookUrl.trim() ? true : WEBHOOK_PATTERN.test(webhookUrl.trim());
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
      void qc.invalidateQueries({ queryKey: ['slack-config', ws] });
      void qc.invalidateQueries({ queryKey: ['integration-facts', ws] });
    },
    onError: (error) =>
      toast.error((error as ApiError)?.error?.message ?? 'Could not save Slack settings'),
  });

  return (
    <div className="mx-auto max-w-3xl p-4 sm:p-8">
      <div className="mb-5 flex flex-col gap-[18px]">
        <ProviderPageHeader ws={ws} id="slack">
          Post messages to Slack from automations — add a &quot;Send Slack message&quot; action to any button or automation once this is connected.
        </ProviderPageHeader>
        <ProviderConnectionCard ws={ws} id="slack" />
      </div>

      <SetupDisclosure label="Slack" connected={Boolean(connected)}>
      <IntegrationSetupGuide
        steps={[
          {
            label: 'Connect Slack',
            description: 'Save either a bot token or a single-channel webhook.',
            complete: Boolean(connected),
          },
          {
            label: 'Send a test',
            description: 'Press Test on the card above to verify the token, channel membership, and delivery before using it.',
            complete: false,
          },
          {
            label: 'Add it to a workflow',
            description: 'Choose Send Slack message inside a button or automation action.',
            complete: false,
          },
        ]}
      />

      {/* 1. Method choice first (progressive disclosure) */}
      {/* #738 — the `solid` variant: a louder selected state than the other
          three groups, kept deliberately because this chooser IS the step.
          `itemClassName` carries the font-medium that this site applied to
          BOTH members, so the unselected label keeps its weight. */}
      <Segmented
        label="Slack connection method"
        variant="solid"
        size="default"
        className="mb-4 bg-card"
        itemClassName="font-medium"
        value={method}
        onChange={(m) => {
          setMethod(m);
          setMethodTouched(true);
        }}
        options={SLACK_METHOD_OPTIONS}
      />
      <p className="mb-4 text-body text-muted">
        {method === 'bot'
          ? 'A bot token can post to any channel — recommended if you want different automations posting to different channels.'
          : 'An incoming webhook always posts to one fixed channel, chosen when you create it in Slack — simplest if one channel is all you need.'}
      </p>

      {/* 2. Doable instruction inline, per method */}
      <ol className="mb-2 flex list-decimal flex-col gap-1.5 pl-5 text-body text-ink-secondary">
        {method === 'bot' ? (
          <>
            <li>
              Go to <code className="rounded bg-hover px-1 py-0.5">api.slack.com/apps</code> →
              Create New App → From scratch.
            </li>
            <li>
              Open <strong>OAuth &amp; Permissions</strong> → add the{' '}
              <code className="rounded bg-hover px-1 py-0.5">chat:write</code> scope → Install to
              Workspace.
            </li>
            <li>Copy the Bot User OAuth Token (starts with xoxb-) and paste it below.</li>
            <li>
              In Slack, invite the bot to a channel:{' '}
              <code className="rounded bg-hover px-1 py-0.5">/invite @YourAppName</code>.
            </li>
          </>
        ) : (
          <>
            <li>
              Go to <code className="rounded bg-hover px-1 py-0.5">api.slack.com/apps</code> → your
              app → Incoming Webhooks → activate.
            </li>
            <li>Add New Webhook to Workspace → pick a channel.</li>
            <li>Copy the URL (starts with hooks.slack.com/services/) and paste it below.</li>
          </>
        )}
      </ol>
      <p className="mb-5 text-body">
        <a href={DOCS_URL} target="_blank" rel="noreferrer" className="text-primary-text underline">
          Full setup guide with screenshots →
        </a>
      </p>

      <div className="flex flex-col gap-3">
        {method === 'bot' ? (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="slack-token">
              Bot token {config.data?.has_token && '(saved — enter to replace)'}
            </Label>
            <Input
              id="slack-token"
              type="password"
              placeholder="xoxb-…"
              value={botToken}
              onChange={(e) => setBotToken(e.target.value)}
            />
            <p className="text-label text-muted">
              Paste the Bot User OAuth Token from your Slack app. Starts with xoxb-.
            </p>
            {botToken.trim() && !botTokenValid && (
              <p className="text-label text-error">
                That doesn&apos;t look like a bot token — it should start with xoxb-.
              </p>
            )}
          </div>
        ) : (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="slack-webhook">
              Webhook URL {config.data?.has_webhook && '(saved — enter to replace)'}
            </Label>
            <Input
              id="slack-webhook"
              type="password"
              placeholder="https://hooks.slack.com/services/…"
              value={webhookUrl}
              onChange={(e) => setWebhookUrl(e.target.value)}
            />
            <p className="text-label text-muted">
              Paste the Incoming Webhook URL from your Slack app. Starts with
              hooks.slack.com/services/.
            </p>
            {webhookUrl.trim() && !webhookValid && (
              <p className="text-label text-error">
                That doesn&apos;t look like a Slack webhook URL — it should start with
                hooks.slack.com/services/.
              </p>
            )}
          </div>
        )}

        {method === 'bot' && (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="slack-channel">Default channel</Label>
            <Input
              id="slack-channel"
              placeholder="#general or C0123456789"
              value={defaultChannel}
              onChange={(e) => setDefaultChannel(e.target.value)}
            />
            <p className="text-label text-muted">
              Where messages go if an action doesn&apos;t specify a channel. Use #channel-name.
            </p>
          </div>
        )}

        <p className="text-label text-muted">
          Credentials stay on your server and are never shown again once saved.
        </p>

        {/* 3. Verify before trusting */}
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={() => save.mutate()} disabled={save.isPending || !canSave}>
            {save.isPending ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </div>
      </SetupDisclosure>
    </div>
  );
}
