'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { ArrowDownToLine, Bot, CalendarDays, GitBranch, MessageSquare, Sparkles, Target } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';

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
 * Integrations directory (MN-099, rebuilt generically for #44): the gallery
 * card grid — icon, "built by", description, status pill — renders off one
 * `GET /integrations` response instead of a hardcoded platform array plus one
 * useQuery per platform. Each available card still routes to its own
 * connect/config page — GitHub/Linear/Slack keep their existing bespoke setup
 * flows, "delegate-agent" gets a new one — see integration-registry.ts for
 * why that split is deliberate rather than merely not-yet-generalized.
 */
export default function IntegrationsPage() {
  const { ws } = useParams<{ ws: string }>();

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

  return (
    <div className="mx-auto max-w-4xl p-4 sm:p-8">
      <h1 className="mb-1 text-lg font-semibold text-ink">Integrations</h1>
      <p className="mb-6 text-[13px] text-muted">
        Connect StoryOS to the tools you already use. Credentials are stored on your server and never leave it —
        that's the point of self-hosting.
      </p>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {(integrations.data ?? []).map((entry) => {
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
                  {entry.connected ? (
                    <span className="rounded-full bg-accent-soft px-2 py-0.5 text-[11px] font-medium text-ink">Connected</span>
                  ) : entry.status === 'soon' ? (
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
    </div>
  );
}
