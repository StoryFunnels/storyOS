'use client';

import { useParams, useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api, API_URL, apiErrorMessage } from '@/lib/api';
import { useDateFormat } from '@/lib/preferences';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { Dialog, DialogClose, DialogContent, DialogTrigger } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';

interface Connection {
  id: string;
  provider: string;
  name: string;
  status: 'active' | 'expired' | 'revoked' | 'error';
  scopes: string[];
  last_ok_at: string | null;
  created_at: string;
}

interface ProviderDescriptor {
  id: string;
  label: string;
  auth_kind: 'oauth2' | 'api_key' | 'smtp';
  oauth?: { scopes: string[]; configured: boolean };
}

function useConnections(ws: string) {
  return useQuery({
    queryKey: ['connections', ws],
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/workspaces/{ws}/connections', {
        params: { path: { ws } },
      } as never);
      if (error) throw error;
      return (data as unknown as { data: Connection[] }).data;
    },
  });
}

function useProviders(ws: string) {
  return useQuery({
    queryKey: ['connection-providers', ws],
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/workspaces/{ws}/connections/providers', {
        params: { path: { ws } },
      } as never);
      if (error) throw error;
      return (data as unknown as { data: ProviderDescriptor[] }).data;
    },
  });
}

/**
 * MN-252 — the workspace credential registry. Connect once here, reuse from
 * any automation/action/source (Apify, Resend today; LinkedIn/Meta/YouTube
 * arrive with their own descriptors in the follow-up tickets). Credentials
 * never round-trip to this page after they're saved — only status.
 */
export default function ConnectionsSettingsPage() {
  const { ws } = useParams<{ ws: string }>();
  const searchParams = useSearchParams();
  const qc = useQueryClient();
  const fmt = useDateFormat();
  const confirm = useConfirm();
  const connections = useConnections(ws);
  const providers = useProviders(ws);

  useEffect(() => {
    const connected = searchParams.get('connected');
    const error = searchParams.get('error');
    if (connected) toast.success(`${connected} connected`);
    if (error) toast.error(`Connection failed: ${error}`);
  }, [searchParams]);

  const providerLabel = (id: string) => providers.data?.find((p) => p.id === id)?.label ?? id;

  const test = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await api.POST('/api/v1/workspaces/{ws}/connections/{id}/test', {
        params: { path: { ws, id } },
      } as never);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success('Connection is healthy');
      void qc.invalidateQueries({ queryKey: ['connections', ws] });
    },
    onError: (error) => toast.error(apiErrorMessage(error, 'Connection check failed')),
  });

  const remove = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await api.DELETE('/api/v1/workspaces/{ws}/connections/{id}', {
        params: { path: { ws, id } },
      } as never);
      if (error) throw error;
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['connections', ws] }),
    onError: () => toast.error('Could not disconnect'),
  });

  function reconnect(providerId: string) {
    window.location.href = `${API_URL}/api/v1/workspaces/${ws}/connections/oauth/${providerId}/start`;
  }

  const connectedProviderIds = new Set((connections.data ?? []).map((c) => c.provider));

  return (
    <div className="mx-auto max-w-3xl p-8">
      <h1 className="mb-1 text-lg font-semibold text-ink">Connections</h1>
      <p className="mb-6 text-[13px] text-muted">
        Connect an external account once, then use it from any automation, action or source.
        Credentials are encrypted at rest and never shown again after saving.
      </p>

      <h2 className="mb-2 text-sm font-semibold text-ink">Connected</h2>
      <div className="mb-8 overflow-hidden rounded-[var(--radius-card)] border border-border-default bg-card">
        {(connections.data ?? []).length === 0 && (
          <p className="px-4 py-6 text-[13px] text-muted">No connections yet — add one below.</p>
        )}
        {(connections.data ?? []).map((c) => (
          <div
            key={c.id}
            className="flex items-center justify-between gap-3 border-b border-border-default px-4 py-3 last:border-b-0"
          >
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-ink">
                {c.name} <span className="text-[12px] font-normal text-faint">· {providerLabel(c.provider)}</span>
              </p>
              <p className="mt-0.5 text-[12px] text-muted">
                <StatusPill status={c.status} />
                {c.last_ok_at ? ` · last ok ${fmt.dateTime(c.last_ok_at)}` : ''}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <Button variant="ghost" size="sm" onClick={() => test.mutate(c.id)} disabled={test.isPending}>
                Test
              </Button>
              {c.status !== 'active' && providers.data?.find((p) => p.id === c.provider)?.auth_kind === 'oauth2' && (
                <Button variant="ghost" size="sm" onClick={() => reconnect(c.provider)}>
                  Reconnect
                </Button>
              )}
              <Button
                variant="ghost"
                size="sm"
                onClick={async () => {
                  if (
                    !(await confirm({
                      title: 'Disconnect this connection?',
                      message: `${c.name} will stop working in every automation, action or source that uses it. This cannot be undone.`,
                      confirmLabel: 'Disconnect',
                      danger: true,
                    }))
                  )
                    return;
                  remove.mutate(c.id);
                }}
              >
                Disconnect
              </Button>
            </div>
          </div>
        ))}
      </div>

      <h2 className="mb-2 text-sm font-semibold text-ink">Add a connection</h2>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {(providers.data ?? []).map((p) => (
          <div
            key={p.id}
            className="flex flex-col justify-between gap-3 rounded-[var(--radius-card)] border border-border-default bg-card p-4"
          >
            <div>
              <p className="text-sm font-semibold text-ink">{p.label}</p>
              <p className="mt-0.5 text-[12px] text-muted">
                {p.auth_kind === 'oauth2' ? 'Connect via OAuth' : 'Connect with an API key'}
                {connectedProviderIds.has(p.id) && ' · already connected'}
              </p>
            </div>
            {p.auth_kind === 'oauth2' ? (
              <Button
                size="sm"
                variant="secondary"
                disabled={!p.oauth?.configured}
                title={p.oauth?.configured ? undefined : 'This server has no client id/secret configured for this provider'}
                onClick={() => reconnect(p.id)}
              >
                {p.oauth?.configured ? 'Connect' : 'Not configured'}
              </Button>
            ) : (
              <ApiKeyConnectDialog ws={ws} provider={p} />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function StatusPill({ status }: { status: Connection['status'] }) {
  const ok = status === 'active';
  return (
    <span
      className={cn(
        'rounded px-1.5 py-0.5 text-[11px]',
        ok ? 'bg-accent-soft text-ink' : 'bg-hover text-error',
      )}
    >
      {status}
    </span>
  );
}

function ApiKeyConnectDialog({ ws, provider }: { ws: string; provider: ProviderDescriptor }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(provider.label);
  const [apiKey, setApiKey] = useState('');

  const create = useMutation({
    mutationFn: async () => {
      const { error } = await api.POST('/api/v1/workspaces/{ws}/connections', {
        params: { path: { ws } },
        body: { provider: provider.id, name, auth: { api_key: apiKey } } as never,
      } as never);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success(`${provider.label} connected`);
      setOpen(false);
      void qc.invalidateQueries({ queryKey: ['connections', ws] });
    },
    onError: (error) => toast.error(apiErrorMessage(error, `Could not connect ${provider.label} — check the API key`)),
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          setName(provider.label);
          setApiKey('');
        }
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm" variant="secondary">
          Connect
        </Button>
      </DialogTrigger>
      <DialogContent title={`Connect ${provider.label}`}>
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (!name.trim() || !apiKey.trim()) return;
            create.mutate();
          }}
        >
          <p className="text-[13px] text-muted">
            The key is verified against {provider.label} before saving, then encrypted at rest —
            it is never shown again.
          </p>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="conn-name">Name</Label>
            <Input id="conn-name" required value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="conn-key">API key</Label>
            <Input
              id="conn-key"
              autoFocus
              required
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
            />
          </div>
          <div className="flex justify-end gap-2">
            <DialogClose asChild>
              <Button type="button" variant="secondary">
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" disabled={create.isPending}>
              {create.isPending ? 'Connecting…' : 'Connect'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
