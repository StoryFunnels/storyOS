'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Circle, X } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { useDatabases, useSpaces, useWorkspace } from '@/lib/queries';
import { useEditPreferenceList, usePreferences } from '@/lib/preferences';
import {
  buildActivationSteps,
  completedCount,
  isWorkspaceDismissed,
  shouldShowChecklist,
  type OnboardingState,
} from '@/lib/activation';
import { TemplateGalleryDialog } from '@/components/template-gallery';
import { Button } from '@/components/ui/button';
import { takePendingShare } from '@/lib/pending-share';
import { useSession } from '@/lib/auth-client';
import { greeting, homeSubLine } from '@/lib/greeting';
import { ShareWorkspaceCard } from '@/components/onboarding/share-workspace-card';
import { BLOCK_CARD, BLOCK_TITLE, WorkspaceHomeBlocks } from '@/components/workspace-home-blocks';

export default function WorkspaceHome() {
  const { ws } = useParams<{ ws: string }>();
  const qc = useQueryClient();
  const workspace = useWorkspace(ws);
  const spaces = useSpaces(ws);
  const databases = useDatabases(ws);

  const settings = (workspace.data as unknown as { settings?: { sample_record_ids?: string[] } })
    ?.settings;
  const sampleCount = settings?.sample_record_ids?.length ?? 0;

  const removeSamples = useMutation({
    mutationFn: async () => {
      const { error } = await api.DELETE('/api/v1/workspaces/{ws}/templates/sample-data', {
        params: { path: { ws } },
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success('Sample data removed');
      void qc.invalidateQueries();
    },
  });

  // MN-213: each step derives from REAL workspace state, computed server-side —
  // never a stored flag that drifts and tells an activated user they did nothing.
  const onboarding = useQuery({
    queryKey: ['onboarding', ws],
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/workspaces/{ws}/onboarding' as never, {
        params: { path: { ws } },
      } as never);
      if (error) throw error;
      return data as unknown as OnboardingState;
    },
    retry: false,
    refetchOnWindowFocus: true,
  });

  /*
   * #217 — the wizard's last step, offered exactly once: right after landing
   * in a workspace just built by the describe-your-work step. `false` on
   * both the server and the first client render (same hydration dance as
   * `useTyronPanel`/`useRememberedThread`), then flips true post-mount if
   * `/new-workspace` left the flag — never on a later visit to this page,
   * whether the prompt was used or skipped.
   */
  const [showShare, setShowShare] = useState(false);
  useEffect(() => {
    if (takePendingShare(ws)) setShowShare(true);
  }, [ws]);

  /* Ticket #1274 — the greeting depends on the BROWSER's clock, which the server cannot know. So it is computed only
     after mount (and once the session has said whether there is a name), and until then the h1 holds its height with
     a non-breaking space: no hydration mismatch, no flash of the wrong part of day, no layout shift. */
  const session = useSession();
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => setNow(new Date()), []);
  const greetingText = now && !session.isPending ? greeting(now, session.data?.user?.name) : null;

  const [galleryOpen, setGalleryOpen] = useState(false);
  const [gallerySlug, setGallerySlug] = useState<string | undefined>(undefined);
  const canInstall = workspace.data?.role !== 'guest';

  // Dismissal is stored per-workspace-per-user in the server preferences blob
  // (#155) — not localStorage — so hiding the checklist on one device keeps it
  // hidden everywhere. It still self-hides once every step is done (MN-213).
  const preferences = usePreferences();
  const editList = useEditPreferenceList();
  const dismissed =
    !preferences.data || isWorkspaceDismissed(preferences.data.activation?.dismissedWorkspaces, ws);

  // #1007 — dismiss names THIS workspace only; the server adds it atomically, so a dismissal in another tab is not lost.
  const dismiss = () => editList.mutate({ list: 'dismissed_workspaces', add: [ws] });

  const firstDb = databases.data?.[0];
  const gs = onboarding.data;
  const steps = gs ? buildActivationSteps(gs, { ws, firstDbId: firstDb?.id }) : [];
  const showChecklist = shouldShowChecklist(steps, dismissed);

  return (
    /* #663 — LEFT-ALIGNED, and no longer capped at 672px. `mx-auto max-w-2xl`
       was the single class that made this page two narrow columns floating in
       the middle of a wide viewport while the sidebar's content sat hard left.
       max-w-6xl still stops prose from running to absurd measures on an
       ultrawide, but the content now starts where the eye already is. */
    <div className="max-w-6xl p-4 sm:p-10">
      {sampleCount > 0 && (
        <div className="mb-6 flex items-center justify-between rounded-[var(--radius-card)] border border-border-default bg-hover px-4 py-3">
          <span className="text-body text-ink">
            This workspace contains {sampleCount} sample records to explore.
          </span>
          <Button size="sm" variant="secondary" onClick={() => removeSamples.mutate()}>
            Remove sample data
          </Button>
        </div>
      )}

      <h1 className="text-[22px] font-bold leading-[normal] tracking-[-0.44px] text-ink">
        {greetingText ?? '\u00a0'}
      </h1>
      {/* The date is the browser's today, so — like the greeting — it exists only after mount (`now`); until then the
          line shows the workspace name alone, then gains the date. */}
      <p className="mb-8 mt-1 text-body text-muted">
        {now
          ? homeSubLine(now, workspace.data?.name ?? 'StoryOS', preferences.data?.regional)
          : (workspace.data?.name ?? 'StoryOS')}
      </p>

      {showShare && <ShareWorkspaceCard ws={ws} onDone={() => setShowShare(false)} />}

      {showChecklist && (
        <div className={BLOCK_CARD}>
          <div className="mb-3 flex items-center justify-between">
            <h2 className={BLOCK_TITLE}>
              Getting started · {completedCount(steps)}/{steps.length}
            </h2>
            <button
              type="button"
              className="rounded p-0.5 text-faint hover:bg-hover hover:text-ink disabled:opacity-50"
              title="Dismiss"
              disabled={editList.isPending}
              onClick={dismiss}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
          <div className="flex flex-col gap-2.5">
            {steps.map((step) => (
              <div key={step.key} className="flex items-center gap-2.5">
                {step.done ? (
                  <CheckCircle2 className="h-4 w-4 text-success" />
                ) : (
                  <Circle className="h-4 w-4 text-faint" />
                )}
                {step.href && !step.done ? (
                  <Link href={step.href} className="text-body text-ink underline-offset-2 hover:underline">
                    {step.label}
                  </Link>
                ) : (
                  <span className="text-body text-ink-secondary">{step.label}</span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Ticket #1274 — the work blocks are no longer behind an "established workspace" gate (that rule hid pending approvals
          from every workspace still on its checklist). Review always shows; Automation runs once an agent exists. The
          checklist above sits over them and never replaces them. "Start something new" is the last row of Where to go. */}
      <WorkspaceHomeBlocks
        ws={ws}
        databases={databases.data ?? []}
        spaces={spaces.data ?? []}
        onStartNew={
          canInstall
            ? () => {
                setGallerySlug(undefined);
                setGalleryOpen(true);
              }
            : undefined
        }
      />
      {canInstall && galleryOpen && (
        <TemplateGalleryDialog
          key={gallerySlug ?? 'all'}
          ws={ws}
          spaces={spaces.data ?? []}
          open={galleryOpen}
          onOpenChange={setGalleryOpen}
          initialSlug={gallerySlug}
        />
      )}

      {(spaces.data?.length ?? 0) > 0 && (databases.data?.length ?? 0) === 0 && (
        <p className="mt-6 text-body text-muted">
          Create your first database from the sidebar — hover a space and hit “+”.
        </p>
      )}
    </div>
  );
}
