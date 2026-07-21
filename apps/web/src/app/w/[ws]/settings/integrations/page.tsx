'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { ArrowDownToLine, CalendarDays, GitBranch, MessageSquare, Sparkles, Target } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';

type Status = 'available' | 'soon';
interface Platform {
  slug: string;
  name: string;
  Icon: LucideIcon;
  description: string;
  status: Status;
}

/**
 * Integrations directory (MN-099): a catalog of platforms with logos + descriptions.
 * Each available one links to its own setup page — so today's API keys can become
 * tomorrow's OAuth without cramming every flow onto one page.
 */
const PLATFORMS: Platform[] = [
  { slug: 'github', name: 'GitHub', Icon: GitBranch, description: 'Import Issues & Pull Requests; PRs auto-link to the issues they reference.', status: 'available' },
  { slug: 'linear', name: 'Linear', Icon: ArrowDownToLine, description: 'One-shot migration — teams become spaces with Issues, Sprints and Projects.', status: 'available' },
  { slug: 'slack', name: 'Slack', Icon: MessageSquare, description: 'Send messages to Slack from automations — post updates to a channel when records change.', status: 'available' },
  { slug: 'google-calendar', name: 'Google Calendar', Icon: CalendarDays, description: 'Two-way sync between date fields and your calendar.', status: 'soon' },
  { slug: 'storyfunnels', name: 'StoryFunnels', Icon: Target, description: 'Native integration with StoryFunnels — pipelines and content in sync.', status: 'soon' },
  { slug: 'storypages', name: 'StoryPages', Icon: Sparkles, description: 'Native integration with StoryPages — publish and track pages from here.', status: 'soon' },
];

export default function IntegrationsPage() {
  const { ws } = useParams<{ ws: string }>();

  const github = useQuery({
    queryKey: ['github-config', ws],
    queryFn: async () => {
      const { data } = await api.GET('/api/v1/workspaces/{ws}/integrations/github', { params: { path: { ws } } } as never);
      return data as unknown as { has_token: boolean } | undefined;
    },
  });
  const linear = useQuery({
    queryKey: ['linear-config', ws],
    queryFn: async () => {
      const { data } = await api.GET('/api/v1/workspaces/{ws}/integrations/linear', { params: { path: { ws } } } as never);
      return data as unknown as { has_key: boolean } | undefined;
    },
  });
  const slack = useQuery({
    queryKey: ['slack-config', ws],
    queryFn: async () => {
      const { data } = await api.GET('/api/v1/workspaces/{ws}/integrations/slack', { params: { path: { ws } } } as never);
      return data as unknown as { has_token: boolean; has_webhook: boolean } | undefined;
    },
  });
  const connected = (slug: string) =>
    (slug === 'github' && github.data?.has_token) ||
    (slug === 'linear' && linear.data?.has_key) ||
    (slug === 'slack' && (slack.data?.has_token || slack.data?.has_webhook));

  return (
    <div className="mx-auto max-w-4xl p-4 sm:p-8">
      <h1 className="mb-1 text-lg font-semibold text-ink">Integrations</h1>
      <p className="mb-6 text-[13px] text-muted">
        Connect StoryOS to the tools you already use. Credentials are stored on your server and never leave it —
        that's the point of self-hosting.
      </p>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {PLATFORMS.map((p) => {
          const isConnected = connected(p.slug);
          const card = (
            <div
              className={cn(
                'flex h-full flex-col rounded-[var(--radius-card)] border border-border-default bg-card p-4 transition-colors',
                p.status === 'available' ? 'hover:border-border-strong' : 'opacity-70',
              )}
            >
              <div className="mb-2 flex items-center gap-2">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--radius-control)] bg-hover">
                  <p.Icon className="h-5 w-5 text-ink" />
                </span>
                <span className="text-sm font-semibold text-ink">{p.name}</span>
                <span className="ml-auto">
                  {isConnected ? (
                    <span className="rounded-full bg-accent-soft px-2 py-0.5 text-[11px] font-medium text-ink">Connected</span>
                  ) : p.status === 'soon' ? (
                    <span className="rounded-full bg-hover px-2 py-0.5 text-[11px] text-faint">Coming soon</span>
                  ) : (
                    <span className="rounded-full border border-border-default px-2 py-0.5 text-[11px] text-muted">Set up →</span>
                  )}
                </span>
              </div>
              <p className="text-[13px] leading-snug text-muted">{p.description}</p>
            </div>
          );
          return p.status === 'available' ? (
            <Link key={p.slug} href={`/w/${ws}/settings/integrations/${p.slug}`}>
              {card}
            </Link>
          ) : (
            <div key={p.slug} className="cursor-default">{card}</div>
          );
        })}
      </div>
    </div>
  );
}
