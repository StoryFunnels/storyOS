'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { AgentAvatar } from '@/components/tyron/agent-avatar';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { useDatabase } from '@/components/table-view/use-table-data';
import { api, apiErrorMessage } from '@/lib/api';
import { useDatabases, useSpaces, useWorkspace } from '@/lib/queries';
import { ASKS, executeHire, hireOutcomeMessage, hireProblem, initialHireDraft } from '@/lib/runners/hire';
import type { AskKey, HireContext, HireDraft, HireField, HireIO, WorkTarget } from '@/lib/runners/hire';
import { canDeclareWriteGates } from '@/lib/runners/access';
import { runnerKeys, useDatabaseFields, useMyUserId, useRunnerMutations, useRunners } from '@/lib/runners/queries';
import { hireState, ownerRunners } from '@/lib/runners/runs-on';
import { browserTimeZone, rebaseRules } from '@/lib/runners/wake-rules';
import type { WakeRule } from '@/lib/runners/wake-rules';
import { RunsOnLine } from './runs-on-line';
import { WakeRulesEditor } from './wake-rules-editor';
import { WorksInPicker } from './works-in-picker';

function unwrap(result: { data?: unknown; error?: unknown }): unknown {
  if (result.error) throw result.error;
  return result.data;
}

/**
 * Tickets #1139 AC3 and #1196 — the hire card. EVERYTHING is on this one screen (no "Change details"): the name, its job, when it
 * wakes, where it works, what it asks before, and where it runs. It shows the same "Runs on" line as the agent page and, with no
 * Runner, says so in a sentence and carries on: hiring is NEVER blocked by the lack of a Runner (the agent waits). What the card
 * offers is what the API accepts today (`hire-capabilities.ts`), and what Hire does is `executeHire` (`lib/runners/hire.ts`):
 * if a step after the agent exists fails, the toast names exactly which settings did not apply.
 */
export function HireDialog({ ws, agentsDbId, open, onOpenChange }: { ws: string; agentsDbId: string; open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="Hire an agent" className="max-h-[calc(100dvh-32px)] max-w-[520px] overflow-y-auto p-[18px] pb-3.5">
        {/* Mounted only while open, so every opening starts from the defaults. */}
        {open && <HireCard ws={ws} agentsDbId={agentsDbId} onClose={() => onOpenChange(false)} />}
      </DialogContent>
    </Dialog>
  );
}

function HireCard({ ws, agentsDbId, onClose }: { ws: string; agentsDbId: string; onClose: () => void }) {
  const router = useRouter();
  const qc = useQueryClient();
  const me = useMyUserId();
  const role = useWorkspace(ws).data?.role;
  const db = useDatabase(ws, agentsDbId);
  const runners = useRunners(ws);
  const m = useRunnerMutations(ws);
  const spaces = useSpaces(ws);
  const databases = useDatabases(ws);
  const timeZone = useMemo(() => browserTimeZone(), []);

  const [initial] = useState(() => initialHireDraft());
  const [name, setName] = useState(initial.name);
  const [job, setJob] = useState(initial.job);
  const [wakes, setWakes] = useState<WakeRule[]>(initial.wakes);
  const [works, setWorks] = useState<WorkTarget[]>(initial.works);
  const [asks, setAsks] = useState<Record<AskKey, boolean>>(initial.asks);
  const [picked, setPicked] = useState<string | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  // The person hiring becomes the agent's owner, so the menu is exactly their own Runners.
  const mine = ownerRunners(runners.data ?? [], me, me);
  const chosenId = picked === undefined ? (mine[0]?.id ?? null) : picked;
  const chosen = mine.find((r) => r.id === chosenId) ?? null;
  const state = hireState(chosen);

  const workDbs = works.filter((w): w is Extract<WorkTarget, { kind: 'db' }> => w.kind === 'db');
  const fieldsByDb = useDatabaseFields(ws, workDbs.map((w) => w.id));

  const draft: HireDraft = { name, job, wakes, works, asks, runnerId: chosen?.id ?? null };
  const ctx: HireContext = {
    fields: (db.data?.fields ?? []) as unknown as HireField[],
    agentsDatabaseId: agentsDbId,
    role,
    timeZone,
    databaseName: (id) => databases.data?.find((d) => d.id === id)?.name ?? 'record',
    fieldName: (dbId, fieldId) => fieldsByDb[dbId]?.find((f) => f.id === fieldId)?.displayName ?? 'field',
  };
  const problem = hireProblem(draft, ctx);
  const mayGate = canDeclareWriteGates(role);

  function setWorksAndRules(next: WorkTarget[]) {
    setWorks(next);
    setWakes((rules) => rebaseRules(rules, next.filter((w) => w.kind === 'db').map((w) => w.id)));
  }

  const io: HireIO = {
    createAgent: async (values) =>
      unwrap(await api.POST('/api/v1/workspaces/{ws}/databases/{db}/records', { params: { path: { ws, db: agentsDbId } }, body: { values } } as never)) as { id: string },
    createGate: async (body) => unwrap(await api.POST('/api/v1/workspaces/{ws}/agent-write-gates', { params: { path: { ws } }, body } as never)),
    createAutomation: async (databaseId, body) =>
      unwrap(await api.POST('/api/v1/workspaces/{ws}/databases/{db}/automations', { params: { path: { ws, db: databaseId } }, body } as never)),
    createBinding: async (body) => unwrap(await api.POST('/api/v1/workspaces/{ws}/agents/triggers', { params: { path: { ws } }, body } as never)),
    assignRunner: async (agentId, runnerId) => m.assign.mutateAsync({ agentId, runnerId }),
    describe: (e) => apiErrorMessage(e, 'it was refused'),
  };

  async function hire() {
    setBusy(true);
    try {
      const outcome = await executeHire(draft, ctx, io);
      await qc.invalidateQueries({ queryKey: runnerKeys.agents(ws) });
      await qc.invalidateQueries({ queryKey: runnerKeys.summary(ws) });
      const message = hireOutcomeMessage(name, outcome);
      if (outcome.failed.length === 0) toast.success(message);
      else toast.warning(message, { duration: 20_000 });
      onClose();
      router.push(`/w/${ws}/agents/${outcome.agentId}`);
    } catch (e) {
      // Only the record itself throws: nothing was created.
      toast.error(apiErrorMessage(e, 'Could not hire it. Nothing was created. Try again.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-2.5" data-testid="hire-card">
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
        <label htmlFor="hire-job" className="text-label text-muted">
          Its job
        </label>
        <Textarea id="hire-job" rows={2} className="min-h-[52px]" value={job} onChange={(e) => setJob(e.target.value)} placeholder="Follow up on deals that went quiet and draft the next email for me" />
      </div>
      <div>
        <div className="mb-1 text-label text-muted">Wakes when</div>
        <WakeRulesEditor
          rules={wakes}
          onChange={setWakes}
          works={workDbs}
          fieldsByDb={fieldsByDb}
          agentsDbId={agentsDbId}
          role={role}
          timeZone={timeZone}
        />
      </div>
      <div>
        <div className="mb-1 text-label text-muted">Works in</div>
        <WorksInPicker works={works} onChange={setWorksAndRules} spaces={spaces.data ?? []} databases={databases.data ?? []} />
      </div>
      <div>
        <div className="mb-1 text-label text-muted">Asks before</div>
        <div className="flex flex-col gap-1" data-testid="asks-before">
          {ASKS.filter((a) => !a.gate || mayGate).map((a) => (
            <label key={a.key} className="flex items-center gap-2 text-body text-ink">
              <input type="checkbox" checked={asks[a.key]} onChange={(e) => setAsks((s) => ({ ...s, [a.key]: e.target.checked }))} />
              {a.label}
            </label>
          ))}
        </div>
        {!mayGate && role !== undefined && <p className="mb-0 mt-1 text-label text-muted">Holding changes to records for approval is set by a workspace admin.</p>}
      </div>
      <p className="m-0 text-label text-muted">Reports to you. You can change all of this later on its page.</p>
      <div>
        <RunsOnLine
          assigned={chosen ? { id: chosen.id, name: chosen.name } : null}
          runners={mine}
          canChange
          now={new Date()}
          onPick={(id) => setPicked(id)}
          onAdd={() => {
            onClose();
            router.push(`/w/${ws}/settings/runners?add=1`);
          }}
        />
        {state.note && <p className="mb-0 mt-1.5 text-label text-muted">{state.note}</p>}
      </div>
      {problem && (
        <p role="status" className="m-0 text-label text-warning-text" data-testid="hire-problem">
          {problem}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="secondary" onClick={onClose}>
          Cancel
        </Button>
        <Button type="button" disabled={busy || problem !== null} onClick={() => void hire()}>
          Hire
        </Button>
      </div>
    </div>
  );
}
