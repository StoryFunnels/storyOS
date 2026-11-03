'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { AgentAvatar } from '@/components/tyron/agent-avatar';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { useDatabase } from '@/components/table-view/use-table-data';
import { api, apiErrorMessage } from '@/lib/api';
import { buildHireValues, canSubmitHire } from '@/lib/runners/hire';
import type { HireField } from '@/lib/runners/hire';
import { runnerKeys, useMyUserId, useRunnerMutations, useRunners } from '@/lib/runners/queries';
import { hireState, ownerRunners } from '@/lib/runners/runs-on';
import { RunsOnLine } from './runs-on-line';

/**
 * Ticket #1139 AC3 — the hire card. It shows the same "Runs on" line as the agent page, and with no Runner says so in a sentence
 * and carries on: hiring is NEVER blocked by the lack of a Runner (the agent waits). The only thing that disables Hire is an
 * empty name. An "API key" choice is not offered: it is not in v1.
 */
export function HireDialog({ ws, agentsDbId, open, onOpenChange }: { ws: string; agentsDbId: string; open: boolean; onOpenChange: (open: boolean) => void }) {
  const router = useRouter();
  const qc = useQueryClient();
  const me = useMyUserId();
  const db = useDatabase(ws, agentsDbId);
  const runners = useRunners(ws);
  const m = useRunnerMutations(ws);
  const [name, setName] = useState('');
  const [goal, setGoal] = useState('');
  const [picked, setPicked] = useState<string | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  // The person hiring becomes the agent's owner, so the menu is exactly their own Runners.
  const mine = ownerRunners(runners.data ?? [], me, me);
  // Default to their first Runner; an explicit pick (even of "none yet" is not possible) overrides it.
  const chosenId = picked === undefined ? (mine[0]?.id ?? null) : picked;
  const chosen = mine.find((r) => r.id === chosenId) ?? null;
  const state = hireState(chosen);

  async function hire() {
    const values = buildHireValues({ name, goal }, (db.data?.fields ?? []) as unknown as HireField[]);
    if (!values) {
      toast.error('The Agents database is still loading. Try again in a moment.');
      return;
    }
    setBusy(true);
    try {
      const { data, error } = await api.POST('/api/v1/workspaces/{ws}/databases/{db}/records', { params: { path: { ws, db: agentsDbId } }, body: { values } } as never);
      if (error) throw error;
      const agent = data as unknown as { id: string };
      let note = '';
      if (chosen) {
        try {
          await m.assign.mutateAsync({ agentId: agent.id, runnerId: chosen.id });
        } catch {
          note = ' It is hired but not on a Runner yet: use Change on its page.';
        }
      }
      await qc.invalidateQueries({ queryKey: runnerKeys.agents(ws) });
      toast.success(`${name.trim()} is hired.${note}`);
      onOpenChange(false);
      router.push(`/w/${ws}/agents/${agent.id}`);
    } catch (e) {
      toast.error(apiErrorMessage(e, 'Could not hire it. Try again.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="Hire an agent" className="max-w-[520px]">
        <div className="flex flex-col gap-3" data-testid="hire-card">
          <div className="flex items-center gap-3">
            <AgentAvatar name={name.trim() || 'New agent'} size="lg" />
            <div className="min-w-0 flex-1">
              <label htmlFor="hire-name" className="text-label text-muted">
                Name
              </label>
              <Input id="hire-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Sales assistant" autoFocus />
            </div>
          </div>
          <div>
            <label htmlFor="hire-goal" className="text-label text-muted">
              What do you need help with?
            </label>
            <Textarea
              id="hire-goal"
              rows={3}
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
              placeholder="Follow up on deals that went quiet and draft the next email for me"
            />
          </div>
          <div>
            <RunsOnLine
              assigned={chosen ? { id: chosen.id, name: chosen.name } : null}
              runners={mine}
              canChange
              now={new Date()}
              onPick={(id) => setPicked(id)}
              onAdd={() => {
                onOpenChange(false);
                router.push(`/w/${ws}/settings/runners?add=1`);
              }}
            />
            {state.note && <p className="mb-0 mt-1.5 text-label text-muted">{state.note}</p>}
          </div>
          <div className="mt-1 flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="button" disabled={!canSubmitHire(name, busy)} onClick={() => void hire()}>
              Hire
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
