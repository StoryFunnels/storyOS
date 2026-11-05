'use client';

import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ExternalLink } from 'lucide-react';
import { toast } from 'sonner';
import { api, apiErrorMessage } from '@/lib/api';
import { httpBaseUrlProblem } from '@/lib/http-base-url';
import { CUSTOM_API_PRESETS, customApiPreset, presetForConnection, type CustomApiPreset } from '@/lib/custom-api-presets';
import type { ProviderInfo } from '@/lib/provider-pages';
import { Button } from '@/components/ui/button';
import { Dialog, DialogClose, DialogContent, DialogTrigger } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { MenuSelect } from '@/components/ui/menu-select';

/**
 * The two "paste a credential" connect dialogs, moved out of the old /connections page (ticket #1188) so a provider's own page opens
 * them: the dialog is the same, only its home changed. Credentials never round-trip: after saving, only status is shown.
 */
type Trigger = { label: string; variant?: 'primary' | 'secondary' };

export function ApiKeyConnectDialog({
  ws,
  provider,
  trigger,
  initialName,
  autoOpen = false,
}: {
  ws: string;
  provider: Pick<ProviderInfo, 'id' | 'label' | 'auth_kind'>;
  trigger: Trigger;
  initialName?: string;
  autoOpen?: boolean;
}) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(initialName?.trim() || provider.label);
  const [apiKey, setApiKey] = useState('');
  // #110 — Shopify's api_key connection isn't a bare `{ api_key }`: it's the store domain + Admin API access token.
  const isShopify = provider.id === 'shopify';
  const [shopDomain, setShopDomain] = useState('');
  const [accessToken, setAccessToken] = useState('');
  // MN-256: Resend-only optional extras: a from_address (needed before a send_email action can use this connection; its domain must
  // already be verified on this key) and a webhook_secret (bounce/complaint degradation).
  const [fromAddress, setFromAddress] = useState('');
  const [webhookSecret, setWebhookSecret] = useState('');
  // MN-256: the `smtp` provider's own required shape.
  const [host, setHost] = useState('');
  const [port, setPort] = useState('587');
  const [smtpUser, setSmtpUser] = useState('');
  const [smtpPass, setSmtpPass] = useState('');
  const [smtpFrom, setSmtpFrom] = useState('');
  const isSmtp = provider.auth_kind === 'smtp';

  // #110 — open pre-named when a deep link arrives (`?add=<provider>`).
  useEffect(() => {
    if (autoOpen) setOpen(true);
  }, [autoOpen]);

  function reset() {
    setName(initialName?.trim() || provider.label);
    setApiKey('');
    setShopDomain('');
    setAccessToken('');
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
        : isShopify
          ? { shop_domain: shopDomain.trim(), access_token: accessToken.trim() }
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
      void qc.invalidateQueries({ queryKey: ['integrations-directory', ws] });
    },
    onError: (error) => toast.error(apiErrorMessage(error, `Could not connect ${provider.label} — check the details`)),
  });

  const canSubmit = isSmtp
    ? name.trim() && host.trim() && port.trim() && smtpFrom.trim()
    : isShopify
      ? name.trim() && shopDomain.trim() && accessToken.trim()
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
        <Button size="sm" variant={trigger.variant ?? 'secondary'}>
          {trigger.label}
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
          <p className="text-body text-muted">
            {isSmtp
              ? 'We test the connection before saving, then encrypt it at rest.'
              : `The key is verified against ${provider.label} before saving, then encrypted at rest — it is never shown again.`}
          </p>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="conn-name">Name</Label>
            <Input id="conn-name" required value={name} onChange={(e) => setName(e.target.value)} />
          </div>

          {isSmtp ? (
            <>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="smtp-from">From address</Label>
                <Input id="smtp-from" required type="email" placeholder="automations@yourdomain.com" value={smtpFrom} onChange={(e) => setSmtpFrom(e.target.value)} />
                <p className="text-meta text-muted">Fixed at connect time — an email action can never override it.</p>
              </div>
              {/* MN-256: the raw mail-server details are IT/operator territory: present and required, behind a disclosure so the form
                  leads with the one field most people care about. */}
              <details className="rounded-[var(--radius-card)] border border-border-default bg-card px-3 py-2">
                <summary className="cursor-pointer select-none text-body font-medium text-ink">Advanced / IT settings</summary>
                <p className="mt-2 text-meta text-muted">Your mail server&apos;s connection details — usually from your IT team or email provider.</p>
                <div className="mt-3 grid grid-cols-3 gap-2">
                  <div className="col-span-2 flex flex-col gap-1.5">
                    <Label htmlFor="smtp-host">Host</Label>
                    <Input id="smtp-host" required value={host} onChange={(e) => setHost(e.target.value)} />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="smtp-port">Port</Label>
                    <Input id="smtp-port" required type="number" value={port} onChange={(e) => setPort(e.target.value)} />
                  </div>
                </div>
                <div className="mt-3 flex flex-col gap-1.5">
                  <Label htmlFor="smtp-user">Username (optional)</Label>
                  <Input id="smtp-user" value={smtpUser} onChange={(e) => setSmtpUser(e.target.value)} />
                </div>
                <div className="mt-3 flex flex-col gap-1.5">
                  <Label htmlFor="smtp-pass">Password (optional)</Label>
                  <Input id="smtp-pass" type="password" value={smtpPass} onChange={(e) => setSmtpPass(e.target.value)} />
                </div>
              </details>
            </>
          ) : isShopify ? (
            <>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="shopify-domain">Store domain</Label>
                <Input id="shopify-domain" autoFocus required placeholder="my-store.myshopify.com" value={shopDomain} onChange={(e) => setShopDomain(e.target.value)} />
                <p className="text-meta text-muted">Your store&apos;s .myshopify.com host.</p>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="shopify-token">Admin API access token</Label>
                <Input id="shopify-token" required type="password" placeholder="shpat_…" value={accessToken} onChange={(e) => setAccessToken(e.target.value)} />
                <p className="text-meta text-muted">From a custom app in your Shopify admin, with read_products scope.</p>
              </div>
            </>
          ) : (
            <>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="conn-key">API key</Label>
                <Input id="conn-key" autoFocus required type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
              </div>
              {provider.id === 'resend' && (
                <>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="conn-from">From address (needed to send email)</Label>
                    <Input id="conn-from" type="email" placeholder="automations@yourdomain.com" value={fromAddress} onChange={(e) => setFromAddress(e.target.value)} />
                    <p className="text-meta text-muted">Must be on a domain already verified on this Resend key.</p>
                    <details className="text-meta">
                      <summary className="cursor-pointer select-none text-muted">Why do I need a verified domain?</summary>
                      <p className="mt-1 text-muted">
                        Email providers only deliver mail from domains you&apos;ve proven you own. Verifying your domain in Resend is what keeps your
                        messages out of spam — or from being rejected outright.
                      </p>
                    </details>
                  </div>
                  {/* MN-256: the bounce/complaint webhook signing secret is an optional deliverability nicety, not part of first setup. */}
                  <details className="rounded-[var(--radius-card)] border border-border-default bg-card px-3 py-2">
                    <summary className="cursor-pointer select-none text-body font-medium text-ink">Advanced / IT settings</summary>
                    <div className="mt-3 flex flex-col gap-1.5">
                      <Label htmlFor="conn-webhook-secret">Webhook signing secret (optional)</Label>
                      <Input id="conn-webhook-secret" type="password" placeholder="whsec_…" value={webhookSecret} onChange={(e) => setWebhookSecret(e.target.value)} />
                      <p className="text-meta text-muted">
                        From a Resend webhook pointed at this connection&apos;s own URL (shown after saving) — enables bounce/complaint status degradation.
                      </p>
                    </div>
                  </details>
                </>
              )}
            </>
          )}

          <div className="flex justify-end gap-2">
            <DialogClose asChild>
              <Button type="button" variant="secondary">Cancel</Button>
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

const AUTH_STYLES: Array<{ value: HttpAuthStyle; label: string }> = [
  { value: 'bearer', label: 'Bearer token' },
  { value: 'basic', label: 'Basic (username/password)' },
  { value: 'headers', label: 'Custom header' },
];

const BLANK = 'blank';

/**
 * MN-263 — the 'http' provider's auth shape isn't a bare `{ api_key }`: it's one of bearer/basic/headers (http.ts's HttpConnectionAuth).
 * healthCheck() never probes the network (there's no universal endpoint to hit for "any API"), so this collects a shape-valid credential.
 *
 * Ticket #1188 — presets. "Start from" pre-fills the name, base URL and auth style for Meta, X or LinkedIn (`lib/custom-api-presets.ts`)
 * and shows where its docs are. It changes nothing about what is stored: the connection is the same generic HTTP one it always was.
 */
export function HttpConnectDialog({
  ws,
  trigger,
  presetId,
  initialName,
  autoOpen = false,
}: {
  ws: string;
  trigger: Trigger;
  /** Open with this preset chosen (a preset's own page, or a deep link). */
  presetId?: string;
  initialName?: string;
  autoOpen?: boolean;
}) {
  const qc = useQueryClient();
  // A deep link that only carries a name (the old /connections?add=http&name=Meta%20comments) still lands on its preset.
  const startPreset = customApiPreset(presetId) ?? (initialName ? presetForConnection({ provider: 'http', name: initialName }) : null);
  const [open, setOpen] = useState(false);
  const [preset, setPreset] = useState<CustomApiPreset | null>(startPreset);
  const [name, setName] = useState(startPreset?.defaultName ?? (initialName?.trim() || 'My API'));
  const [style, setStyle] = useState<HttpAuthStyle>('bearer');
  const [token, setToken] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [headerName, setHeaderName] = useState('X-Api-Key');
  const [headerValue, setHeaderValue] = useState('');
  // #1035 — the one address the credential may be sent to; the API refuses a connection without one.
  const [baseUrl, setBaseUrl] = useState(startPreset?.baseUrl ?? '');

  // #112 — open pre-named when a deep link arrives.
  useEffect(() => {
    if (autoOpen) setOpen(true);
  }, [autoOpen]);

  function choosePreset(next: CustomApiPreset | null) {
    setPreset(next);
    setName(next?.defaultName ?? 'My API');
    setBaseUrl(next?.baseUrl ?? '');
    setStyle('bearer');
  }

  function reset() {
    choosePreset(startPreset);
    setToken('');
    setUsername('');
    setPassword('');
    setHeaderName('X-Api-Key');
    setHeaderValue('');
  }

  const valid =
    httpBaseUrlProblem(baseUrl) === null &&
    (style === 'bearer'
      ? Boolean(token.trim())
      : style === 'basic'
        ? Boolean(username.trim()) && password.length > 0
        : Boolean(headerName.trim()) && Boolean(headerValue.trim()));

  const create = useMutation({
    mutationFn: async () => {
      const credential =
        style === 'bearer'
          ? { auth_style: 'bearer', token }
          : style === 'basic'
            ? { auth_style: 'basic', username, password }
            : { auth_style: 'headers', headers: { [headerName]: headerValue } };
      const auth = { ...credential, base_url: baseUrl.trim() };
      const { error } = await api.POST('/api/v1/workspaces/{ws}/connections', {
        params: { path: { ws } },
        body: { provider: 'http', name, auth } as never,
      } as never);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success(`${name} connected`);
      setOpen(false);
      void qc.invalidateQueries({ queryKey: ['connections', ws] });
      void qc.invalidateQueries({ queryKey: ['integrations-directory', ws] });
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
        <Button size="sm" variant={trigger.variant ?? 'secondary'}>
          {trigger.label}
        </Button>
      </DialogTrigger>
      <DialogContent title={preset ? `Connect ${preset.label}` : 'Connect a custom API'}>
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (!name.trim() || !valid) return;
            create.mutate();
          }}
        >
          <p className="text-body text-muted">
            Used by the http_request automation action{preset ? ` and by the ${preset.label} source` : ''} — auth is merged into each request at send
            time and never stored in the rule config.
          </p>
          <div className="flex flex-col gap-1.5">
            <Label>Start from</Label>
            <MenuSelect
              label="Start from"
              className="w-full max-w-none"
              contentClassName="w-64"
              value={preset?.id ?? BLANK}
              onChange={(v) => choosePreset(customApiPreset(v))}
              options={[
                { value: BLANK, label: 'Custom API (blank)' },
                ...CUSTOM_API_PRESETS.map((p) => ({ value: p.id, label: p.label })),
              ]}
            />
            {preset && (
              <p className="text-label text-muted" data-testid="preset-hint">
                {preset.tokenHint}{' '}
                <a className="inline-flex items-center gap-1 text-ink underline underline-offset-2" href={preset.docsUrl} target="_blank" rel="noreferrer">
                  Docs <ExternalLink className="h-3 w-3" aria-hidden />
                </a>
              </p>
            )}
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="http-conn-name">Name</Label>
            <Input id="http-conn-name" required value={name} onChange={(e) => setName(e.target.value)} />
            {preset && (
              <p className="text-label text-muted">Keep the name starting with “{preset.label.split(' ')[0]}”: that is how StoryOS knows which connection is this one.</p>
            )}
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="http-conn-base-url-new">Base URL</Label>
            <Input id="http-conn-base-url-new" required inputMode="url" placeholder="https://api.example.com/v1" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
            <p className="text-label text-muted">
              The one address this credential may be sent to (host and, optionally, a path prefix). A rule that points anywhere else is refused.
            </p>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label>Auth style</Label>
            <MenuSelect label="Auth style" className="w-full max-w-none" contentClassName="w-64" value={style} onChange={(v) => setStyle(v as HttpAuthStyle)} options={AUTH_STYLES} />
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
              <Button type="button" variant="secondary">Cancel</Button>
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
