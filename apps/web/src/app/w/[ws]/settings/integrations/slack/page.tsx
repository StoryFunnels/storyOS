'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, MessageSquare } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

/**
 * Slack setup (MN-021), phase 1 — paste a bot token (or an incoming-webhook URL)
 * and a default channel. Automations can then post with the "Send Slack message"
 * action. Phase 2 will replace the token paste with a real OAuth install.
 */
export default function SlackIntegrationPage() {
  const { ws } = useParams<{ ws: string }>();
  const qc = useQueryClient();
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
      const cfg = data as unknown as { has_token: boolean; has_webhook: boolean; default_channel: string | null };
      setDefaultChannel((prev) => prev || cfg.default_channel || '');
      return cfg;
    },
  });

  const save = useMutation({
    mutationFn: async () => {
      const body: Record<string, unknown> = {};
      if (botToken.trim()) body.bot_token = botToken.trim();
      if (webhookUrl.trim()) body.webhook_url = webhookUrl.trim();
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
    },
    onError: (error) => toast.error((error as { error?: { message?: string } })?.error?.message ?? 'Could not save Slack settings'),
  });

  const connected = config.data?.has_token || config.data?.has_webhook;

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
        Post messages to Slack from automations. Use a bot token (recommended — lets each message target its own
        channel) or an incoming-webhook URL (fixed channel). Credentials stay on your server. Add a
        &quot;Send Slack message&quot; action to any button or automation once this is connected.
      </p>

      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="slack-token">Bot token {config.data?.has_token && '(saved — enter to replace)'}</Label>
          <Input id="slack-token" type="password" placeholder="xoxb-… (OAuth &amp; Permissions → Bot User OAuth Token)" value={botToken} onChange={(e) => setBotToken(e.target.value)} />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="slack-webhook">Webhook URL {config.data?.has_webhook && '(saved — enter to replace)'}</Label>
          <Input id="slack-webhook" type="password" placeholder="https://hooks.slack.com/services/…" value={webhookUrl} onChange={(e) => setWebhookUrl(e.target.value)} />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="slack-channel">Default channel (used when an action doesn&apos;t name one)</Label>
          <Input id="slack-channel" placeholder="#general or C0123456789" value={defaultChannel} onChange={(e) => setDefaultChannel(e.target.value)} />
        </div>
        <div className="flex gap-2">
          <Button size="sm" onClick={() => save.mutate()} disabled={save.isPending}>Save</Button>
        </div>
      </div>
    </div>
  );
}
