'use client';

import { Plus } from 'lucide-react';
import { useParams, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { PairingCard } from '@/components/runners/pairing-card';
import { RunnerRow } from '@/components/runners/runner-row';
import { useFinishPairing } from '@/components/runners/use-finish-pairing';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { apiErrorMessage } from '@/lib/api';
import { useRunnerMutations, useRunners, useWakeSummary } from '@/lib/runners/queries';
import { canUseRunners, GUEST_RUNNERS_MESSAGE } from '@/lib/runners/access';
import { canEditSharing } from '@/lib/runners/sharing';
import { confirmRemoveRunner, COPY, SUPPORTED_TOOLS } from '@/lib/runners/words';
import { useWorkspace } from '@/lib/queries';
import { SettingsPageHeader, SettingsRefusal } from '@/components/settings/settings-chrome';

/**
 * Ticket #1139 AC4 — Settings › Runners: the person's OWN Runners (members and admins alike, never anyone else's: a Runner is
 * one person's computer and subscription, ADR-0021 §3), the pairing flow, and Remove with its confirm. Everything is the real
 * API. A guest never holds a Runner and is told so in the page rather than shown a screen whose every call is refused.
 */
export default function RunnersPage() {
  const { ws } = useParams<{ ws: string }>();
  const workspace = useWorkspace(ws);
  const allowed = canUseRunners(workspace.data?.role);
  const runners = useRunners(ws, allowed);
  const summary = useWakeSummary(ws, allowed);
  const m = useRunnerMutations(ws);
  const confirm = useConfirm();
  const finish = useFinishPairing(ws);
  // `?add=1` is how the agent page, the hire card and the first-time moment send someone straight into pairing.
  const [pairing, setPairing] = useState(useSearchParams().get('add') === '1');

  if (workspace.isPending) return <p className="p-6 text-body text-muted">Loading…</p>;
  if (!allowed) {
    return (
      <SettingsRefusal title="Runners" testId="runners-guest">
        {GUEST_RUNNERS_MESSAGE}
      </SettingsRefusal>
    );
  }

  // A pending Runner lives at most ten minutes and is the open pairing card's business, not a row (ADR-0021 §11).
  const mine = (runners.data ?? []).filter((r) => r.status === 'active');
  const now = new Date();
  const waitingAgents = summary.data?.agents.filter((a) => !a.can_run && a.runner === null) ?? [];

  async function remove(id: string, name: string, agentNames: string[]) {
    const ok = await confirm(confirmRemoveRunner(name, agentNames));
    if (!ok) return;
    m.remove.mutate(id, {
      onSuccess: () => toast.success('Runner removed'),
      onError: (e) => toast.error(apiErrorMessage(e, 'Could not remove that Runner. Try again.')),
    });
  }

  return (
    // The root sets NO centring, width or padding: the shared Settings layout owns the column (settings/layout.tsx, ticket #1186).
    <div className="flex flex-col gap-[18px]">
      <SettingsPageHeader
        title="Runners"
        lead={COPY.runnersLead}
        action={
          mine.length > 0 && !pairing ? (
            <Button type="button" variant="secondary" size="sm" onClick={() => setPairing(true)}>
              <Plus className="h-[13px] w-[13px]" aria-hidden />
              Add a Runner
            </Button>
          ) : undefined
        }
      />

      {pairing ? (
        <PairingCard
          ws={ws}
          onCancel={() => setPairing(false)}
          onDone={(done) => {
            setPairing(false);
            void finish(done);
          }}
        />
      ) : runners.isPending ? (
        <p role="status" className="text-body text-muted">
          Loading…
        </p>
      ) : runners.isError ? (
        <p role="alert" className="text-body text-error">
          Could not load your Runners. Try again in a moment.
        </p>
      ) : mine.length === 0 ? (
        <section className="flex flex-col gap-2.5 rounded-[var(--radius-card)] border border-border-strong bg-card p-4" data-testid="no-runner">
          <h2 className="m-0 text-prose font-semibold text-ink">No Runner yet</h2>
          <p className="m-0 text-body leading-[1.5] text-ink-secondary">
            {waitingAgents.length === 1
              ? `${waitingAgents[0]!.name} is hired and waiting. `
              : waitingAgents.length > 1
                ? `${waitingAgents.length} agents are hired and waiting. `
                : ''}
            Add a Runner on the computer where {SUPPORTED_TOOLS} is signed in. No password, nothing to paste: you type a short code once.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" onClick={() => setPairing(true)}>
              Add a Runner
            </Button>
          </div>
        </section>
      ) : (
        mine.map((r) => (
          <RunnerRow
            key={r.id}
            runner={r}
            now={now}
            canEditSharing={canEditSharing({ role: workspace.data?.role })}
            onSaveSharing={async (patch) => {
              try {
                await m.setSharing.mutateAsync({ id: r.id, patch });
              } catch (e) {
                throw new Error(apiErrorMessage(e, 'Could not save that. Your earlier setting is kept.'), { cause: e });
              }
            }}
            removing={m.remove.isPending && m.remove.variables === r.id}
            onRemove={() => void remove(r.id, r.name, r.agents.map((a) => a.name))}
          />
        ))
      )}
    </div>
  );
}
