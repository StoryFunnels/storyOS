'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import posthog from 'posthog-js';
import {
  Blocks,
  BookOpen,
  Bot,
  BriefcaseBusiness,
  Code2,
  Headphones,
  PenTool,
  Sparkles,
  Square,
  Users,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { api } from '@/lib/api';
import { isErrorEnvelope } from '@storyos/sdk';
import { AuthCard } from '../(auth)/auth-card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';

interface PackCard {
  slug: string;
  name: string;
  summary: string;
  highlights: string[];
}

interface PackEntry extends PackCard {
  manifest: unknown;
}

interface PackInstallResult {
  spaces: Array<{ id: string; name: string; action: 'created' | 'reused' | 'skipped' }>;
  databases: Array<{ id: string; name: string; action: 'created' | 'reused' | 'skipped' }>;
}

const QUICK_PICKS = [
  { id: 'agency', label: 'Running an agency', slug: 'agency-os' },
  { id: 'new-client', label: 'Onboarding a new client', slug: 'client-portal' },
  { id: 'dev', label: 'Starting a dev project', slug: 'dev-project-os' },
  { id: 'blog', label: 'Launching a content engine', slug: 'content-engine' },
  { id: 'book', label: 'Writing and launching a book', slug: 'book-launch' },
  { id: 'coaching', label: 'Running a coaching practice', slug: 'coaching-os' },
  { id: 'consulting', label: 'Running consulting engagements', slug: 'consulting-os' },
] as const;

const PACK_ICONS: Record<string, LucideIcon> = {
  'agency-os': BriefcaseBusiness,
  'client-portal': Users,
  'dev-project-os': Code2,
  'content-engine': PenTool,
  'book-launch': BookOpen,
  'coaching-os': Users,
  'consulting-os': Blocks,
  'support-inbox': Headphones,
};

function PackChoice({
  pack,
  label,
  selected,
  onClick,
}: {
  pack: PackCard;
  label?: string;
  selected: boolean;
  onClick: () => void;
}) {
  const Icon = PACK_ICONS[pack.slug] ?? Blocks;
  return (
    <button
      type="button"
      className={cn(
        'flex items-start gap-3 rounded-[var(--radius-card)] border p-3 text-left',
        selected ? 'border-[var(--accent)] bg-accent-soft' : 'border-border-default hover:bg-hover',
      )}
      onClick={onClick}
    >
      <Icon className="mt-0.5 h-4 w-4 shrink-0 text-muted" />
      <span className="min-w-0">
        <span className="block text-[13px] font-medium text-ink">{label ?? pack.name}</span>
        <span className="line-clamp-2 block text-[12px] text-muted">{pack.summary}</span>
        <span className="mt-1 block text-[11px] text-faint">
          Includes databases, views, automations, and an approval-aware agent
        </span>
      </span>
    </button>
  );
}

/**
 * New-workspace onboarding uses the same Business Pack registry as the
 * in-workspace gallery. This removes the old split where onboarding promised a
 * static template while the real agentic pack lived elsewhere.
 */
export default function NewWorkspacePage() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [choice, setChoice] = useState<string>('pack:agency-os');
  const [clientName, setClientName] = useState('');
  const [browsing, setBrowsing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const workspaces = useQuery({
    queryKey: ['workspaces'],
    queryFn: async () => {
      const { data, error: apiError } = await api.GET('/api/v1/workspaces');
      if (apiError) throw apiError;
      return data as unknown as Array<{ id: string; name: string }>;
    },
  });

  const registry = useQuery({
    queryKey: ['packs-registry'],
    queryFn: async () => {
      const { data, error: apiError } = await api.GET(
        '/api/v1/packs/registry' as never,
        {} as never,
      );
      if (apiError) throw apiError;
      return data as unknown as PackCard[];
    },
    staleTime: 5 * 60_000,
  });

  const packs = registry.data ?? [];
  const packBySlug = new Map(packs.map((pack) => [pack.slug, pack]));
  const selectedSlug = choice.startsWith('pack:') ? choice.slice(5) : null;
  const selectedQuickPick = QUICK_PICKS.find((pick) => pick.slug === selectedSlug);

  async function installPack(wsId: string, slug: string): Promise<PackInstallResult> {
    const { data: entryData, error: entryError } = await api.GET(
      '/api/v1/packs/registry/{slug}' as never,
      { params: { path: { slug } } } as never,
    );
    if (entryError) throw entryError;
    const entry = entryData as unknown as PackEntry;
    const { data: installData, error: installError } = await api.POST(
      '/api/v1/workspaces/{ws}/packs/install' as never,
      {
        params: { path: { ws: wsId } },
        body: { manifest: entry.manifest, resolutions: {} } as never,
      } as never,
    );
    if (installError) throw installError;
    return installData as unknown as PackInstallResult;
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { data, error: apiError } = await api.POST('/api/v1/workspaces', {
      body: { name },
    });
    if (apiError) {
      setBusy(false);
      setError(isErrorEnvelope(apiError) ? apiError.error.message : 'Could not create workspace');
      return;
    }
    const wsId = (data as { id: string }).id;
    posthog.capture('workspace_created', {
      has_pack: Boolean(selectedSlug),
      pack_slug: selectedSlug,
      onboarding_path: choice === 'marketplace' ? 'marketplace' : selectedSlug ? 'pack' : 'blank',
    });

    if (choice === 'marketplace') {
      router.replace(`/w/${wsId}/packs#community-marketplace`);
      return;
    }
    if (!selectedSlug) {
      router.replace(`/w/${wsId}`);
      return;
    }

    try {
      const result = await installPack(wsId, selectedSlug);
      const firstSpace = result.spaces.find((space) => space.action !== 'skipped');
      if (selectedSlug === 'client-portal' && clientName.trim() && firstSpace) {
        await api.PATCH('/api/v1/workspaces/{ws}/spaces/{space}', {
          params: { path: { ws: wsId, space: firstSpace.id } },
          body: { name: clientName.trim() },
        });
      }
      posthog.capture('onboarding_pack_installed', { pack_slug: selectedSlug });
      if (selectedSlug === 'client-portal' && firstSpace) {
        router.replace(
          `/w/${wsId}/settings/members?invite=guest&space=${firstSpace.id}&grant=editor`,
        );
        return;
      }
      const firstDatabase = result.databases.find((database) => database.action !== 'skipped');
      router.replace(firstDatabase ? `/w/${wsId}/d/${firstDatabase.id}` : `/w/${wsId}`);
    } catch {
      // The workspace is already safe and usable. Send the user to the pack
      // gallery where the preview can explain an unmet requirement/collision.
      router.replace(`/w/${wsId}/packs`);
    }
  }

  return (
    <AuthCard title="Create your workspace">
      <form onSubmit={onSubmit} className="flex flex-col gap-4">
        {(workspaces.data?.length ?? 0) > 0 && (
          <div className="rounded-[var(--radius-control)] border border-border-default bg-card p-3 text-[12px] text-muted">
            Need another workspace? Multiple workspaces are available on Enterprise.{' '}
            <a
              href={`mailto:hello@storyos.dev?subject=${encodeURIComponent('StoryOS Enterprise — multiple workspaces')}`}
              className="font-medium text-ink underline underline-offset-2"
              onClick={() =>
                posthog.capture('enterprise_contact_clicked', { source: 'new_workspace' })
              }
            >
              Contact us
            </a>
            .
          </div>
        )}

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="name">Workspace name</Label>
          <Input
            id="name"
            required
            autoFocus
            placeholder="e.g. JCM Agency"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <Label>What are you working on?</Label>
          <p className="text-[11px] text-faint">
            Pick a complete Business Pack now, or install any other pack later.
          </p>
          <div className="flex max-h-[48vh] flex-col gap-1.5 overflow-y-auto pr-1">
            {!browsing
              ? QUICK_PICKS.map((pick) => {
                  const pack = packBySlug.get(pick.slug);
                  return pack ? (
                    <PackChoice
                      key={pick.id}
                      pack={pack}
                      label={pick.label}
                      selected={choice === `pack:${pick.slug}`}
                      onClick={() => setChoice(`pack:${pick.slug}`)}
                    />
                  ) : null;
                })
              : packs.map((pack) => (
                  <PackChoice
                    key={pack.slug}
                    pack={pack}
                    selected={choice === `pack:${pack.slug}`}
                    onClick={() => setChoice(`pack:${pack.slug}`)}
                  />
                ))}

            <button
              type="button"
              className={cn(
                'flex items-start gap-3 rounded-[var(--radius-card)] border p-3 text-left',
                choice === 'marketplace'
                  ? 'border-[var(--accent)] bg-accent-soft'
                  : 'border-border-default hover:bg-hover',
              )}
              onClick={() => setChoice('marketplace')}
            >
              <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-muted" />
              <span>
                <span className="block text-[13px] font-medium text-ink">
                  Browse the Community Marketplace
                </span>
                <span className="block text-[12px] text-muted">
                  Create the workspace, then explore reviewed packs from other builders.
                </span>
              </span>
            </button>

            <button
              type="button"
              className={cn(
                'flex items-start gap-3 rounded-[var(--radius-card)] border p-3 text-left',
                choice === 'blank'
                  ? 'border-[var(--accent)] bg-accent-soft'
                  : 'border-border-default hover:bg-hover',
              )}
              onClick={() => setChoice('blank')}
            >
              <Square className="mt-0.5 h-4 w-4 shrink-0 text-muted" />
              <span>
                <span className="block text-[13px] font-medium text-ink">Blank workspace</span>
                <span className="block text-[12px] text-muted">Start from scratch.</span>
              </span>
            </button>
          </div>

          <button
            type="button"
            className="self-start text-[12px] text-muted underline-offset-2 hover:underline"
            onClick={() => setBrowsing((value) => !value)}
          >
            {browsing ? '← Back to quick picks' : `Browse all ${packs.length || ''} StoryOS packs`}
          </button>
        </div>

        {selectedQuickPick?.id === 'new-client' && (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="client-name">Client name</Label>
            <Input
              id="client-name"
              placeholder="e.g. Globex Corp"
              value={clientName}
              onChange={(e) => setClientName(e.target.value)}
            />
          </div>
        )}

        {error && <p className="text-[13px] text-error">{error}</p>}
        <Button type="submit" disabled={busy || registry.isLoading}>
          {busy ? 'Setting things up…' : 'Create workspace'}
        </Button>

        <div className="flex items-start gap-2 rounded-[var(--radius-control)] bg-hover p-3">
          <Bot className="mt-0.5 h-4 w-4 shrink-0 text-muted" />
          <p className="text-[11px] text-muted">
            After setup, connect Claude or ChatGPT from Settings → Integrations to work with this
            workspace through StoryOS MCP.
          </p>
        </div>
      </form>
    </AuthCard>
  );
}
