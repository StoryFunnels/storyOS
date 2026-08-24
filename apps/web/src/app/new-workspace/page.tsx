'use client';

import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import posthog from 'posthog-js';
import {
  Sparkles,
  Square,
} from 'lucide-react';
import { api, apiErrorMessage } from '@/lib/api';
import { isErrorEnvelope } from '@storyos/sdk';
import { AuthCard } from '../(auth)/auth-card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { guestInviteHref } from '@/lib/guest-invite';
import { cn } from '@/lib/utils';
import { PackVisual } from '@/components/pack-visual';

interface PackCard {
  slug: string;
  name: string;
  summary: string;
  highlights: string[];
  /** #351 — already returned by /packs/registry; the picker just never used it. */
  preview: { databases: number; views: number; automations: number; agents: number };
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

/**
 * The card shows the QUICK_PICKS use-case label ("Running an agency"); the
 * confirm button used to name the PACK ("Agency OS") — a term the picker never
 * showed. Naming a selection back to someone with a word they have not read is
 * how a confirmation stops confirming.
 *
 * The two halves are cased differently on purpose: a use-case label is a PHRASE
 * and folds into the sentence lowercased, while a pack name is a proper noun
 * that must not ("support inbox").
 */
function confirmLabel(slug: string, packName?: string): string {
  const phrase = QUICK_PICKS.find((q) => q.slug === slug)?.label;
  if (phrase) return `Create workspace for ${phrase.toLowerCase()}`;
  return `Create workspace with ${packName ?? 'this pack'}`;
}

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
  return (
    <button
      type="button"
      // #333: aria-pressed, so the choice is announced as a selection rather
      // than being carried entirely by a background tint.
      aria-pressed={selected}
      className={cn(
        /* #351/#376 — an EXPLICIT card height. Summaries and titles differ in
           length, so heights came out 194/212/248 and no container height could
           be a multiple of them: the grid always cut a card in half, which reads
           as a rendering bug rather than "scroll for more". Fixed height + the
           line-clamp below makes the cut land between rows by construction. */
        'flex h-[196px] flex-col gap-2 overflow-hidden rounded-[var(--radius-card)] border p-2 text-left transition-colors',
        selected ? 'border-[var(--accent)] bg-accent-soft' : 'border-border-default hover:bg-hover',
      )}
      onClick={onClick}
    >
      {/* #351 — #77's visual preview instead of a paragraph. "Nobody can picture
          the result" was the complaint; four counts answer it at a glance. */}
      <PackVisual pack={pack} />
      <span className="min-w-0">
        <span className="block truncate text-[13px] font-medium text-ink">{label ?? pack.name}</span>
        {/* #351 — the repeated "Includes databases, views, automations…" line is
            gone from every card. It was identical on all three, so it could not
            help anyone choose; it is said ONCE above the grid instead. The
            "✓ Selected" badge goes with it: nothing is preselected now, so the
            border and background carry the state. */}
        {/* NOT `line-clamp-2 block` — Tailwind's `.block` sets `display:block`
            and wins over `.line-clamp-2`'s `display:-webkit-box` in the
            cascade, so the clamp silently never applied. Support Inbox's
            six-line summary then ate the card and squeezed the preview above
            from 112px to 43px. The class was present and doing nothing. */}
        <span className="line-clamp-2 text-[12px] text-muted">{pack.summary}</span>
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
  /**
   * #351 — NOTHING is pre-selected. `agency-os` used to arrive already marked
   * "✓ Selected", so anyone who scrolled to the button without reading silently
   * accepted a whole workspace template — databases, automations and an agent.
   * A first-run choice should be made, not defaulted into.
   */
  const [choice, setChoice] = useState<string | null>(null);
  const [clientName, setClientName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [nameError, setNameError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);

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
  const selectedSlug = choice?.startsWith('pack:') ? choice.slice(5) : null;
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
    /*
     * #333: the form is noValidate and this is our check, because the browser's
     * `Please fill out this field.` bubble is system-styled and positioned
     * wherever the browser likes — on this layout it landed across the "What are
     * you working on?" heading. Every other error in the product is ours; that
     * one advertised unstyled HTML on the first authenticated screen a new user
     * sees. (Same family as #328, where sonner's defaults read as browser chrome.)
     */
    if (!name.trim()) {
      setNameError('Give your workspace a name.');
      nameRef.current?.focus();
      return;
    }
    setNameError(null);
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
        // Default the client invite to a free guest tier (viewer) so onboarding
        // matches the share dialog / FreeGuestTip promise that viewer and
        // commenter guests are never a paid seat (#106, #271). Granting an
        // editor guest here would contradict that and may bill a seat.
        // #327: the free default now lives in the shared helper, so the other
        // two surfaces cannot drift away from it again.
        router.replace(guestInviteHref({ ws: wsId, spaceId: firstSpace.id }));
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
    <AuthCard title="Create your workspace" wide>
      <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="name">Workspace name</Label>
          <Input
            id="name"
            ref={nameRef}
            autoFocus
            aria-invalid={nameError ? true : undefined}
            aria-describedby={nameError ? 'name-error' : undefined}
            placeholder="e.g. JCM Agency"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              if (nameError) setNameError(null); // clear as soon as they start fixing it
            }}
          />
          {nameError && (
            <p id="name-error" className="text-[12px] text-error">
              {nameError}
            </p>
          )}
        </div>

        <div className="flex flex-col gap-1.5">
          <Label>What are you working on?</Label>
          {/* #351 — ONE word for the concept, DEFINED before it is used. The
              screen previously said "Business Pack", "pack" and "StoryOS packs" —
              three names for one thing a new user has never heard of. And the
              "includes databases, views, automations" line lived on every card,
              identical, so it differentiated nothing; it belongs here, once. */}
          <p className="text-[12px] text-muted">
            Pick a starting point. Each <span className="text-ink">Business Pack</span> is a
            ready-made set of databases, views and automations for one kind of work — you can change
            anything afterwards, or add more later.
          </p>
          {/* #333: 48vh cut the fourth card mid-height on a laptop, which reads
              as a rendering bug rather than as "scroll for more". A shorter box
              lands the cut BETWEEN cards far more often, and the list scrolls
              either way. */}
          {/* #351 — a GRID of every pack, not three in one column with the rest
              behind grey text. Eight packs exist and the one screen guaranteed to
              be seen was showing a third of them. */}
          {/* Exactly two rows: 2 × 196 + one 8px gap. */}
          <div className="grid max-h-[400px] grid-cols-1 gap-2 overflow-y-auto pr-1 sm:grid-cols-2">
            {registry.isError ? (
              <div className="flex flex-col items-start gap-2 rounded-[var(--radius-card)] border border-border-default bg-card p-4 text-[13px] text-error">
                <span>{apiErrorMessage(registry.error, 'Could not load packs')}</span>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  disabled={registry.isFetching}
                  onClick={() => void registry.refetch()}
                >
                  {registry.isFetching ? 'Retrying…' : 'Try again'}
                </Button>
              </div>
            ) : (
              packs.map((pack) => (
                <PackChoice
                  key={pack.slug}
                  /* The quick-pick LABEL ("Running an agency") is the reader's
                     words for the same thing, so it wins over the product name. */
                  label={QUICK_PICKS.find((q) => q.slug === pack.slug)?.label}
                  pack={pack}
                  selected={choice === `pack:${pack.slug}`}
                  onClick={() => setChoice(`pack:${pack.slug}`)}
                />
              ))
            )}


          </div>

          {/* #351 — the ways OUT live OUTSIDE the scroller, so they are visible
              without scrolling. "Blank workspace" existed before but sat below the
              fold of a 38vh box, which is why the screen read as having no escape
              at all. */}
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <button
              type="button"
              aria-pressed={choice === 'blank'}
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
                <span className="block text-[13px] font-medium text-ink">Start empty</span>
                <span className="block text-[12px] text-muted">
                  No databases. Build your own from scratch.
                </span>
              </span>
            </button>
            <button
              type="button"
              aria-pressed={choice === 'marketplace'}
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
                <span className="block text-[13px] font-medium text-ink">Browse the marketplace</span>
                <span className="block text-[12px] text-muted">
                  Create the workspace first, then explore packs from other builders.
                </span>
              </span>
            </button>
          </div>
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
        {/* #333: the primary action used to sit below four dense pack cards and
            a "browse all" link, so on a laptop viewport it needed a hunt. Pinned
            to the bottom of the card instead — the pack list above already
            scrolls in its own container, so nothing is hidden behind it. */}
        <div className="sticky bottom-0 -mx-1 bg-card px-1 pb-1 pt-2">
          <Button
            type="submit"
            className="w-full"
            /* #351 — disabled until a starting point is chosen, since nothing is
               pre-selected any more. The label names the choice, so the button
               confirms what is about to happen rather than just saying "Create". */
            disabled={
              busy || !choice || registry.isLoading || (registry.isError && choice.startsWith('pack:'))
            }
          >
            {busy
              ? 'Setting things up…'
              : !choice
                ? 'Choose a starting point above'
                : choice === 'blank'
                  ? 'Create empty workspace'
                  : choice === 'marketplace'
                    ? 'Create workspace, then browse'
                    : confirmLabel(selectedSlug ?? '', packBySlug.get(selectedSlug ?? '')?.name)}
          </Button>
        </div>

        {/* #333: this used to be the FIRST thing on the page, above the name
            field — opening a first-run screen with a limitation. It only renders
            for someone who already has a workspace, so it answers a question
            that arises AFTER the action, and now sits after it. */}
        {/* #351 — the Enterprise upsell used to sit here, and the Claude/ChatGPT
            note below it. Both are accurate and both are POST-setup information,
            shown to someone who has not yet seen a single feature. Selling before
            delivering; removed from the first screen. */}

      </form>
    </AuthCard>
  );
}
