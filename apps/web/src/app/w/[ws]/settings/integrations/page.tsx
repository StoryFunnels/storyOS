'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDownToLine, Bot, CalendarDays, GitBranch, MessageSquare, Sparkles, Target } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';

type AuthKind = 'oauth2' | 'config' | 'delegate';
type Status = 'available' | 'soon';

interface IntegrationEntry {
  id: string;
  label: string;
  built_by: string;
  description: string;
  auth_kind: AuthKind;
  status: Status;
  connected: boolean;
}

/**
 * Icons are the one thing the registry (integration-registry.ts, #44) doesn't
 * carry — `packages/schemas` has no business depending on `lucide-react`, so
 * this is the client-rendering half of "id, metadata, auth kind, config
 * schema, status": an id → icon map, next to the id → route convention below.
 */
const ICONS: Record<string, LucideIcon> = {
  github: GitBranch,
  linear: ArrowDownToLine,
  slack: MessageSquare,
  'google-calendar': CalendarDays,
  'delegate-agent': Bot,
  storyfunnels: Target,
  storypages: Sparkles,
};

/**
 * MN-249: platforms whose config page exposes a real "disconnect" endpoint —
 * clears the stored credential and flips `connected` back to false. Built-in
 * cards (delegate-agent) and not-yet-built ones (google-calendar,
 * storyfunnels, storypages) have nothing to disconnect.
 */
const DISCONNECTABLE = new Set(['github', 'linear', 'slack']);

/**
 * MN-249: the row's primary call-to-action label. Linear gets called out by
 * name in the ticket — an already-configured integration with empty fields
 * gave no cue that clicking Preview/Import was all that was left to do — so
 * its row leads with that verb instead of a generic "Configure".
 */
function primaryLabel(entry: IntegrationEntry): string {
  if (entry.auth_kind === 'delegate') return 'Open';
  if (entry.id === 'linear') return 'Preview / Import →';
  return 'Configure';
}

/**
 * Integrations directory (MN-099, rebuilt generically for #44, split into
 * Connected/Add-new sections for MN-249): the gallery card grid — icon,
 * "built by", description, status pill — renders off one `GET /integrations`
 * response instead of a hardcoded platform array plus one useQuery per
 * platform.
 *
 * MN-249: a flat catalog gave an already-connected integration no more
 * visual weight than an unconnected one, so a founder set up Linear, came
 * back later, and didn't realize the "Set up →" pill in front of them was
 * actually "click through and hit Preview/Import" — the fields just looked
 * empty (write-only credentials never round-trip). Connected integrations
 * now get their own section, their own row each, and a labelled primary
 * action instead of a status pill as the only affordance.
 */
export default function IntegrationsPage() {
  const { ws } = useParams<{ ws: string }>();
  const qc = useQueryClient();
  const [disconnecting, setDisconnecting] = useState<string | null>(null);

  const integrations = useQuery({
    queryKey: ['integrations-directory', ws],
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/workspaces/{ws}/integrations', {
        params: { path: { ws } },
      } as never);
      if (error) throw error;
      return (data as unknown as { data: IntegrationEntry[] }).data;
    },
  });

  const disconnect = useMutation({
    mutationFn: async (id: string) => {
      // Each platform is its own literal OpenAPI path (no `{id}` path param
      // exists on the server) — dispatch to the matching one explicitly
      // rather than trying to string-template a route the SDK doesn't know.
      const path =
        id === 'github'
          ? '/api/v1/workspaces/{ws}/integrations/github/disconnect'
          : id === 'linear'
            ? '/api/v1/workspaces/{ws}/integrations/linear/disconnect'
            : '/api/v1/workspaces/{ws}/integrations/slack/disconnect';
      const { error } = await api.POST(path, { params: { path: { ws } } } as never);
      if (error) throw error;
    },
    onMutate: (id) => setDisconnecting(id),
    onSuccess: (_data, id) => {
      const label = integrations.data?.find((e) => e.id === id)?.label ?? id;
      toast.success(`Disconnected ${label}`);
      void qc.invalidateQueries({ queryKey: ['integrations-directory', ws] });
    },
    onError: () => toast.error('Could not disconnect — try again'),
    onSettled: () => setDisconnecting(null),
  });

  const data = integrations.data ?? [];
  const connectedEntries = data.filter((e) => e.connected);
  const catalogEntries = data.filter((e) => !e.connected);

  return (
    <div className="mx-auto max-w-4xl p-4 sm:p-8">
      <h1 className="mb-1 text-lg font-semibold text-ink">Integrations</h1>
      <p className="mb-6 text-[13px] text-muted">
        Connect StoryOS to the tools you already use. Credentials are stored on your server and never leave it —
        that's the point of self-hosting.
      </p>

      {connectedEntries.length > 0 && (
        <section className="mb-8">
          <h2 className="mb-1 text-[13px] font-semibold uppercase tracking-wide text-muted">Connected</h2>
          <p className="mb-3 text-[12px] text-faint">
            Already set up — open one to preview/import, adjust its config, or disconnect.
          </p>
          <div className="flex flex-col gap-2">
            {connectedEntries.map((entry) => {
              const Icon = ICONS[entry.id] ?? Bot;
              const canDisconnect = DISCONNECTABLE.has(entry.id);
              return (
                <div
                  key={entry.id}
                  className="flex flex-col gap-3 rounded-[var(--radius-card)] border border-border-default bg-card p-3 sm:flex-row sm:items-center"
                >
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--radius-control)] bg-hover">
                    <Icon className="h-5 w-5 text-ink" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-semibold text-ink">{entry.label}</span>
                      <span className="rounded-full bg-accent-soft px-2 py-0.5 text-[11px] font-medium text-ink">Connected</span>
                    </div>
                    <p className="truncate text-[12px] text-faint">{entry.description}</p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <Link href={`/w/${ws}/settings/integrations/${entry.id}`}>
                      <Button size="sm" variant={entry.id === 'linear' ? 'primary' : 'secondary'}>
                        {primaryLabel(entry)}
                      </Button>
                    </Link>
                    {canDisconnect && (
                      <Button
                        size="sm"
                        variant="destructive"
                        disabled={disconnecting === entry.id}
                        onClick={() => {
                          if (window.confirm(`Disconnect ${entry.label}? You'll need to reconnect to use it again.`)) {
                            disconnect.mutate(entry.id);
                          }
                        }}
                      >
                        {disconnecting === entry.id ? 'Disconnecting…' : 'Disconnect'}
                      </Button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}

      <section>
        <h2 className="mb-1 text-[13px] font-semibold uppercase tracking-wide text-muted">Add an integration</h2>
        <p className="mb-3 text-[12px] text-faint">Platforms you haven't connected yet.</p>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {catalogEntries.map((entry) => {
            const Icon = ICONS[entry.id] ?? Bot;
            const card = (
              <div
                className={cn(
                  'flex h-full flex-col rounded-[var(--radius-card)] border border-border-default bg-card p-4 transition-colors',
                  entry.status === 'available' ? 'hover:border-border-strong' : 'opacity-70',
                )}
              >
                <div className="mb-2 flex items-center gap-2">
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--radius-control)] bg-hover">
                    <Icon className="h-5 w-5 text-ink" />
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-semibold text-ink">{entry.label}</span>
                    <span className="block truncate text-[11px] text-faint">Built by {entry.built_by}</span>
                  </span>
                  <span className="ml-auto shrink-0">
                    {entry.status === 'soon' ? (
                      <span className="rounded-full bg-hover px-2 py-0.5 text-[11px] text-faint">Coming soon</span>
                    ) : entry.auth_kind === 'delegate' ? (
                      <span className="rounded-full border border-border-default px-2 py-0.5 text-[11px] text-muted">Enable →</span>
                    ) : (
                      <span className="rounded-full border border-border-default px-2 py-0.5 text-[11px] text-muted">Set up →</span>
                    )}
                  </span>
                </div>
                <p className="text-[13px] leading-snug text-muted">{entry.description}</p>
              </div>
            );
            return entry.status === 'available' ? (
              <Link key={entry.id} href={`/w/${ws}/settings/integrations/${entry.id}`}>
                {card}
              </Link>
            ) : (
              <div key={entry.id} className="cursor-default">{card}</div>
            );
          })}
        </div>
      </section>
    </div>
  );
}
