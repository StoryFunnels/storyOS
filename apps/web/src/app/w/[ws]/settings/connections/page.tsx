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
  /** MN-264: last-24h failed-job count + circuit-breaker state. */
  error_count_24h: number;
  breaker_open_until: string | null;
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

  const resume = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await api.POST('/api/v1/workspaces/{ws}/connections/{id}/resume', {
        params: { path: { ws, id } },
      } as never);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success('Circuit breaker closed — jobs will resume claiming');
      void qc.invalidateQueries({ queryKey: ['connections', ws] });
    },
    onError: (error) => toast.error(apiErrorMessage(error, 'Could not resume this connection')),
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
              {/* MN-264: connection health strip. */}
              <p className="mt-0.5 text-[12px] text-muted">
                {c.error_count_24h > 0 && (
                  <span className={c.error_count_24h >= 5 ? 'text-error' : 'text-warning'}>
                    {c.error_count_24h} failed job{c.error_count_24h === 1 ? '' : 's'} in the last 24h
                  </span>
                )}
                {c.breaker_open_until && (
                  <span className="ml-1.5 rounded bg-hover px-1.5 py-0.5 text-[11px] text-error">
                    circuit open until {fmt.dateTime(c.breaker_open_until)}
                  </span>
                )}
              </p>
              {c.provider === 'resend' && c.scopes.some((s) => s.startsWith('from:')) && (
                <p className="mt-1 truncate text-[11px] text-faint">
                  Bounce webhook: {API_URL}/api/v1/providers/resend/webhook/{c.id}
                </p>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <Button variant="ghost" size="sm" onClick={() => test.mutate(c.id)} disabled={test.isPending}>
                Test
              </Button>
              {c.breaker_open_until && (
                <Button variant="ghost" size="sm" onClick={() => resume.mutate(c.id)} disabled={resume.isPending}>
                  Resume
                </Button>
              )}
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
            ) : p.id === 'http' ? (
              <HttpConnectDialog ws={ws} provider={p} />
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
  // MN-256: Resend-only optional extras — a from_address (required before a
  // send_email action can use this connection; its domain must already be
  // verified on this key) and a webhook_secret (enables bounce/complaint
  // degradation via this connection's own /providers/resend/webhook/:id URL,
  // shown once the connection exists — see the tip below the fields).
  const [fromAddress, setFromAddress] = useState('');
  const [webhookSecret, setWebhookSecret] = useState('');
  // MN-256: the `smtp` provider's own required shape.
  const [host, setHost] = useState('');
  const [port, setPort] = useState('587');
  const [smtpUser, setSmtpUser] = useState('');
  const [smtpPass, setSmtpPass] = useState('');
  const [smtpFrom, setSmtpFrom] = useState('');
  const isSmtp = provider.auth_kind === 'smtp';

  function reset() {
    setName(provider.label);
    setApiKey('');
    setFromAddress('');
    setWebhookSecret('');
    setHost('');
    setPort('587');
    setSmtpUser('');
    setSmtpPass('');
    setSmtpFrom('');
  }

  const create = useMutation({
    mutationFn: async () => {
      const auth = isSmtp
        ? { host, port: Number(port), user: smtpUser || undefined, pass: smtpPass || undefined, from_address: smtpFrom }
        : {
            api_key: apiKey,
            ...(fromAddress.trim() ? { from_address: fromAddress.trim() } : {}),
            ...(webhookSecret.trim() ? { webhook_secret: webhookSecret.trim() } : {}),
          };
      const { error } = await api.POST('/api/v1/workspaces/{ws}/connections', {
        params: { path: { ws } },
        body: { provider: provider.id, name, auth } as never,
      } as never);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success(`${provider.label} connected`);
      setOpen(false);
      void qc.invalidateQueries({ queryKey: ['connections', ws] });
    },
    onError: (error) => toast.error(apiErrorMessage(error, `Could not connect ${provider.label} — check the details`)),
  });

  const canSubmit = isSmtp
    ? name.trim() && host.trim() && port.trim() && smtpFrom.trim()
    : name.trim() && apiKey.trim();

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) reset();
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
            if (!canSubmit) return;
            create.mutate();
          }}
        >
          <p className="text-[13px] text-muted">
            {isSmtp
              ? 'Verified with transporter.verify() before saving, then encrypted at rest.'
              : `The key is verified against ${provider.label} before saving, then encrypted at rest — it is never shown again.`}
          </p>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="conn-name">Name</Label>
            <Input id="conn-name" required value={name} onChange={(e) => setName(e.target.value)} />
          </div>

          {isSmtp ? (
            <>
              <div className="grid grid-cols-3 gap-2">
                <div className="col-span-2 flex flex-col gap-1.5">
                  <Label htmlFor="smtp-host">Host</Label>
                  <Input id="smtp-host" required value={host} onChange={(e) => setHost(e.target.value)} />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="smtp-port">Port</Label>
                  <Input id="smtp-port" required type="number" value={port} onChange={(e) => setPort(e.target.value)} />
                </div>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="smtp-user">Username (optional)</Label>
                <Input id="smtp-user" value={smtpUser} onChange={(e) => setSmtpUser(e.target.value)} />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="smtp-pass">Password (optional)</Label>
                <Input id="smtp-pass" type="password" value={smtpPass} onChange={(e) => setSmtpPass(e.target.value)} />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="smtp-from">From address</Label>
                <Input
                  id="smtp-from"
                  required
                  type="email"
                  placeholder="automations@yourdomain.com"
                  value={smtpFrom}
                  onChange={(e) => setSmtpFrom(e.target.value)}
                />
                <p className="text-[11px] text-faint">
                  Fixed at connect time — a send_email action can never override it.
                </p>
              </div>
            </>
          ) : (
            <>
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
              {provider.id === 'resend' && (
                <>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="conn-from">From address (needed for send_email)</Label>
                    <Input
                      id="conn-from"
                      type="email"
                      placeholder="automations@yourdomain.com"
                      value={fromAddress}
                      onChange={(e) => setFromAddress(e.target.value)}
                    />
                    <p className="text-[11px] text-faint">
                      Must be on a domain already verified on this Resend key.
                    </p>
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="conn-webhook-secret">Webhook signing secret (optional)</Label>
                    <Input
                      id="conn-webhook-secret"
                      type="password"
                      placeholder="whsec_…"
                      value={webhookSecret}
                      onChange={(e) => setWebhookSecret(e.target.value)}
                    />
                    <p className="text-[11px] text-faint">
                      From a Resend webhook pointed at this connection&apos;s own URL (shown after
                      saving) — enables bounce/complaint status degradation.
                    </p>
                  </div>
                </>
              )}
            </>
          )}

          <div className="flex justify-end gap-2">
            <DialogClose asChild>
              <Button type="button" variant="secondary">
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" disabled={create.isPending || !canSubmit}>
              {create.isPending ? 'Connecting…' : 'Connect'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

type HttpAuthStyle = 'bearer' | 'basic' | 'headers';

/**
 * MN-263 — the 'http' provider's auth shape isn't a bare `{ api_key }` like
 * Resend/Apify: it's one of bearer/basic/headers (http.ts's HttpConnectionAuth).
 * healthCheck() never probes the network (there's no universal endpoint to hit
 * for "any API"), so this just needs to collect a shape-valid credential.
 */
function HttpConnectDialog({ ws, provider }: { ws: string; provider: ProviderDescriptor }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('My API');
  const [style, setStyle] = useState<HttpAuthStyle>('bearer');
  const [token, setToken] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [headerName, setHeaderName] = useState('X-Api-Key');
  const [headerValue, setHeaderValue] = useState('');

  function reset() {
    setName('My API');
    setStyle('bearer');
    setToken('');
    setUsername('');
    setPassword('');
    setHeaderName('X-Api-Key');
    setHeaderValue('');
  }

  const valid =
    style === 'bearer' ? Boolean(token.trim())
    : style === 'basic' ? Boolean(username.trim()) && password.length > 0
    : Boolean(headerName.trim()) && Boolean(headerValue.trim());

  const create = useMutation({
    mutationFn: async () => {
      const auth =
        style === 'bearer' ? { auth_style: 'bearer', token }
        : style === 'basic' ? { auth_style: 'basic', username, password }
        : { auth_style: 'headers', headers: { [headerName]: headerValue } };
      const { error } = await api.POST('/api/v1/workspaces/{ws}/connections', {
        params: { path: { ws } },
        body: { provider: provider.id, name, auth } as never,
      } as never);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success(`${name} connected`);
      setOpen(false);
      void qc.invalidateQueries({ queryKey: ['connections', ws] });
    },
    onError: (error) => toast.error(apiErrorMessage(error, 'Could not save this connection')),
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) reset();
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm" variant="secondary">
          Add
        </Button>
      </DialogTrigger>
      <DialogContent title="Connect an HTTP API">
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (!name.trim() || !valid) return;
            create.mutate();
          }}
        >
          <p className="text-[13px] text-muted">
            Used only by the http_request automation action — auth is merged into each request at
            send time and never stored in the rule config.
          </p>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="http-conn-name">Name</Label>
            <Input id="http-conn-name" required value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="http-conn-style">Auth style</Label>
            <select
              id="http-conn-style"
              className="h-9 rounded-[var(--radius-control)] border border-border-default bg-card px-2 text-[13px] text-ink"
              value={style}
              onChange={(e) => setStyle(e.target.value as HttpAuthStyle)}
            >
              <option value="bearer">Bearer token</option>
              <option value="basic">Basic (username/password)</option>
              <option value="headers">Custom header</option>
            </select>
          </div>
          {style === 'bearer' && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="http-conn-token">Token</Label>
              <Input id="http-conn-token" required type="password" value={token} onChange={(e) => setToken(e.target.value)} />
            </div>
          )}
          {style === 'basic' && (
            <>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="http-conn-user">Username</Label>
                <Input id="http-conn-user" required value={username} onChange={(e) => setUsername(e.target.value)} />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="http-conn-pass">Password</Label>
                <Input id="http-conn-pass" required type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
              </div>
            </>
          )}
          {style === 'headers' && (
            <>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="http-conn-hname">Header name</Label>
                <Input id="http-conn-hname" required value={headerName} onChange={(e) => setHeaderName(e.target.value)} />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="http-conn-hvalue">Header value</Label>
                <Input id="http-conn-hvalue" required type="password" value={headerValue} onChange={(e) => setHeaderValue(e.target.value)} />
              </div>
            </>
          )}
          <div className="flex justify-end gap-2">
            <DialogClose asChild>
              <Button type="button" variant="secondary">
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" disabled={create.isPending || !valid}>
              {create.isPending ? 'Connecting…' : 'Connect'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
