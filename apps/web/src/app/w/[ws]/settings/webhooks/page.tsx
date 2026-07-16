'use client';

import { useParams } from 'next/navigation';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { useDateFormat } from '@/lib/preferences';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { Dialog, DialogClose, DialogContent, DialogTrigger } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';

/** MN-032. The event names are the activity-event taxonomy (ADR-0004). */
const EVENTS = [
  { id: 'record.created', label: 'Record created' },
  { id: 'record.updated', label: 'Record updated' },
  { id: 'record.deleted', label: 'Record deleted' },
  { id: 'record.restored', label: 'Record restored' },
  { id: 'relation.linked', label: 'Relation linked' },
  { id: 'relation.unlinked', label: 'Relation unlinked' },
  { id: 'comment.created', label: 'Comment added' },
] as const;

interface Webhook {
  id: string;
  url: string;
  database_id: string | null;
  events: string[];
  enabled: boolean;
  last_status: string | null;
  last_status_code: number | null;
  last_error: string | null;
  last_delivered_at: string | null;
  created_at: string;
}

interface Delivery {
  id: string;
  event_type: string;
  status: string;
  attempts: number;
  status_code: number | null;
  error: string | null;
  next_attempt_at: string | null;
  created_at: string;
}

function useWebhooks(ws: string) {
  return useQuery({
    queryKey: ['webhooks', ws],
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/workspaces/{ws}/webhooks', {
        params: { path: { ws } },
      });
      if (error) throw error;
      return (data as unknown as { data: Webhook[] }).data;
    },
  });
}

export default function WebhooksSettingsPage() {
  const { ws } = useParams<{ ws: string }>();
  const qc = useQueryClient();
  const fmt = useDateFormat();
  const confirm = useConfirm();
  const webhooks = useWebhooks(ws);
  const [expanded, setExpanded] = useState<string | null>(null);

  const databases = useQuery({
    queryKey: ['databases', ws],
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/workspaces/{ws}/databases', {
        params: { path: { ws } },
      });
      if (error) throw error;
      return (data as unknown as { data: Array<{ id: string; name: string }> }).data;
    },
  });
  const dbName = (id: string | null) =>
    id ? (databases.data ?? []).find((d) => d.id === id)?.name ?? 'a deleted database' : 'All databases';

  const toggle = useMutation({
    mutationFn: async ({ id, enabled }: { id: string; enabled: boolean }) => {
      const { error } = await api.PATCH('/api/v1/workspaces/{ws}/webhooks/{id}', {
        params: { path: { ws, id } },
        body: { enabled },
      });
      if (error) throw error;
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['webhooks', ws] }),
    onError: () => toast.error('Could not update the webhook'),
  });

  const remove = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await api.DELETE('/api/v1/workspaces/{ws}/webhooks/{id}', {
        params: { path: { ws, id } },
      });
      if (error) throw error;
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['webhooks', ws] }),
    onError: () => toast.error('Could not delete the webhook'),
  });

  return (
    <div className="mx-auto max-w-3xl p-8">
      <div className="mb-2 flex items-center justify-between">
        <h1 className="text-lg font-semibold text-ink">Webhooks</h1>
        <CreateWebhookDialog ws={ws} databases={databases.data ?? []} />
      </div>
      <p className="mb-6 text-[13px] text-muted">
        StoryOS POSTs to your URL when records change — wire it into n8n, Make, Zapier or your own
        endpoint. Each payload is signed: verify{' '}
        <code className="rounded bg-hover px-1">X-StoryOS-Signature</code> as{' '}
        <code className="rounded bg-hover px-1">
          sha256=HMAC(secret, &quot;{'{timestamp}'}.{'{body}'}&quot;)
        </code>{' '}
        using <code className="rounded bg-hover px-1">X-StoryOS-Timestamp</code>. Failures retry with
        backoff for about 15 minutes.
      </p>

      <div className="overflow-hidden rounded-[var(--radius-card)] border border-border-default bg-card">
        {(webhooks.data ?? []).length === 0 && (
          <p className="px-4 py-6 text-[13px] text-muted">
            No webhooks yet. Add one to push changes into another tool.
          </p>
        )}
        {(webhooks.data ?? []).map((hook) => (
          <div key={hook.id} className="border-b border-border-default last:border-b-0">
            <div className="flex items-start justify-between gap-3 px-4 py-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-ink">{hook.url}</p>
                <p className="mt-0.5 text-[12px] text-muted">
                  {dbName(hook.database_id)} · {hook.events.length} event
                  {hook.events.length === 1 ? '' : 's'} · added {fmt.date(hook.created_at)}
                </p>
                <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                  <StatusPill hook={hook} fmt={fmt} />
                  {!hook.enabled && (
                    <span className="rounded bg-hover px-1.5 py-0.5 text-[11px] text-muted">
                      Disabled
                    </span>
                  )}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setExpanded(expanded === hook.id ? null : hook.id)}
                >
                  {expanded === hook.id ? 'Hide' : 'Deliveries'}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => toggle.mutate({ id: hook.id, enabled: !hook.enabled })}
                >
                  {hook.enabled ? 'Disable' : 'Enable'}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={async () => {
                    if (
                      !(await confirm({
                        title: 'Delete this webhook?',
                        message: `${hook.url} will stop receiving events. Records are not affected.`,
                        confirmLabel: 'Delete',
                        danger: true,
                      }))
                    )
                      return;
                    remove.mutate(hook.id);
                  }}
                >
                  Delete
                </Button>
              </div>
            </div>
            {expanded === hook.id && <Deliveries ws={ws} id={hook.id} />}
          </div>
        ))}
      </div>
    </div>
  );
}

function StatusPill({ hook, fmt }: { hook: Webhook; fmt: ReturnType<typeof useDateFormat> }) {
  if (!hook.last_status) {
    return <span className="text-[12px] text-faint">No deliveries yet</span>;
  }
  const ok = hook.last_status === 'ok';
  return (
    <span
      className={cn(
        'rounded px-1.5 py-0.5 text-[11px]',
        ok ? 'bg-accent-soft text-ink' : 'bg-hover text-error',
      )}
      title={hook.last_error ?? undefined}
    >
      {ok ? `Delivered ${hook.last_status_code ?? ''}` : `Failed${hook.last_status_code ? ` ${hook.last_status_code}` : ''}`}
      {hook.last_delivered_at ? ` · ${fmt.dateTime(hook.last_delivered_at)}` : ''}
    </span>
  );
}

function Deliveries({ ws, id }: { ws: string; id: string }) {
  const fmt = useDateFormat();
  const deliveries = useQuery({
    queryKey: ['webhook-deliveries', ws, id],
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/workspaces/{ws}/webhooks/{id}/deliveries', {
        params: { path: { ws, id } },
      });
      if (error) throw error;
      return (data as unknown as { data: Delivery[] }).data;
    },
  });

  if (deliveries.isLoading) return <p className="px-4 pb-3 text-[12px] text-muted">Loading…</p>;
  if ((deliveries.data ?? []).length === 0) {
    return <p className="px-4 pb-3 text-[12px] text-muted">No deliveries yet.</p>;
  }

  return (
    <div className="border-t border-border-default bg-app px-4 py-2">
      {(deliveries.data ?? []).map((d) => (
        <div key={d.id} className="flex items-center justify-between gap-3 py-1 text-[12px]">
          <span className="truncate text-muted">
            <code>{d.event_type}</code> · {fmt.dateTime(d.created_at)}
          </span>
          <span
            className={cn(
              'shrink-0',
              d.status === 'ok' ? 'text-muted' : d.status === 'failed' ? 'text-error' : 'text-faint',
            )}
          >
            {d.status === 'ok'
              ? `HTTP ${d.status_code}`
              : d.status === 'pending'
                ? `retrying (attempt ${d.attempts})`
                : `failed after ${d.attempts} — ${d.error ?? ''}`}
          </span>
        </div>
      ))}
    </div>
  );
}

function CreateWebhookDialog({
  ws,
  databases,
}: {
  ws: string;
  databases: Array<{ id: string; name: string }>;
}) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState('');
  const [databaseId, setDatabaseId] = useState('');
  const [events, setEvents] = useState<string[]>(['record.created', 'record.updated']);
  const [secret, setSecret] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: async () => {
      const { data, error } = await api.POST('/api/v1/workspaces/{ws}/webhooks', {
        params: { path: { ws } },
        body: {
          url,
          events: events as never,
          ...(databaseId ? { database_id: databaseId } : {}),
        },
      });
      if (error) throw error;
      return data as unknown as { secret: string };
    },
    onSuccess: (data) => {
      setSecret(data.secret);
      void qc.invalidateQueries({ queryKey: ['webhooks', ws] });
    },
    onError: () =>
      toast.error('Could not create the webhook — the URL must be https on a public host'),
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          setUrl('');
          setDatabaseId('');
          setEvents(['record.created', 'record.updated']);
          setSecret(null);
        }
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm">Add webhook</Button>
      </DialogTrigger>
      <DialogContent title={secret ? 'Copy your signing secret' : 'New webhook'}>
        {secret ? (
          <div className="flex flex-col gap-3">
            <p className="text-[13px] text-muted">
              This secret is shown once. Use it to verify the{' '}
              <code className="rounded bg-hover px-1">X-StoryOS-Signature</code> header on every
              payload.
            </p>
            <code className="break-all rounded-[var(--radius-control)] border border-border-default bg-app p-2 text-[12px] text-ink">
              {secret}
            </code>
            <div className="flex justify-end gap-2">
              <Button
                variant="secondary"
                onClick={() => {
                  void navigator.clipboard.writeText(secret);
                  toast.success('Secret copied');
                }}
              >
                Copy
              </Button>
              <DialogClose asChild>
                <Button>Done</Button>
              </DialogClose>
            </div>
          </div>
        ) : (
          <form
            className="flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              if (!url.trim() || events.length === 0) return;
              create.mutate();
            }}
          >
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="hook-url">Endpoint URL</Label>
              <Input
                id="hook-url"
                autoFocus
                required
                type="url"
                placeholder="https://hooks.example.com/storyos"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
              />
              <p className="text-[12px] text-faint">
                Must be https on a public host.
              </p>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="hook-db">Database</Label>
              <select
                id="hook-db"
                className="h-9 rounded-[var(--radius-control)] border border-border-default bg-card px-2 text-sm text-ink"
                value={databaseId}
                onChange={(e) => setDatabaseId(e.target.value)}
              >
                <option value="">All databases</option>
                {databases.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </select>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label>Events</Label>
              <div className="grid grid-cols-2 gap-1.5">
                {EVENTS.map((event) => (
                  <label
                    key={event.id}
                    className="flex items-center gap-2 text-[13px] text-ink"
                  >
                    <input
                      type="checkbox"
                      checked={events.includes(event.id)}
                      onChange={(e) =>
                        setEvents((prev) =>
                          e.target.checked
                            ? [...prev, event.id]
                            : prev.filter((x) => x !== event.id),
                        )
                      }
                    />
                    {event.label}
                  </label>
                ))}
              </div>
            </div>

            <div className="flex justify-end gap-2">
              <DialogClose asChild>
                <Button type="button" variant="secondary">
                  Cancel
                </Button>
              </DialogClose>
              <Button type="submit" disabled={events.length === 0 || create.isPending}>
                {create.isPending ? 'Creating…' : 'Create webhook'}
              </Button>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
