'use client';

import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { summaryFor } from '@/lib/runners/agents';
import { useAgents, useMyUserId, useRunnerMutations, useWakeSummary } from '@/lib/runners/queries';
import { readyToast } from '@/lib/runners/words';

/**
 * Ticket #1139 AC2 — what happens when Done succeeds.
 *
 * Done turns the Runner on; it does not, by itself, send any agent to it (`runner_agents` is a separate, explicit assignment,
 * ADR-0021 §3). The design shows the agent page saying "Runs on <this machine>" straight after Done, and the sentence beside the
 * button promises "let this computer run your agents", so the agents that are the PERSON'S OWN (an agent runs as its owner, Q2),
 * use "Your own AI" and have no Runner yet are sent to it. An agent that already has a Runner is never moved, and an agent the
 * person does not own is never touched (the API would refuse it anyway). A failed assignment is not an error the person
 * must act on: the Runner is on, and the agent page's Change menu does the same thing by hand.
 */
export function useFinishPairing(ws: string) {
  const router = useRouter();
  const me = useMyUserId();
  const { agents } = useAgents(ws);
  const summary = useWakeSummary(ws);
  const m = useRunnerMutations(ws);

  return async function finish(done: { runnerId: string; runnerName: string }) {
    const needing = agents.filter((a) => a.usesRunner && a.ownerId === me && !summaryFor(summary.data, a.id)?.runner);
    const results = await Promise.allSettled(needing.map((a) => m.assign.mutateAsync({ agentId: a.id, runnerId: done.runnerId })));
    const assigned = needing.filter((_, i) => results[i]!.status === 'fulfilled');
    toast.success(readyToast(done.runnerName, assigned.map((a) => a.name)));
    router.push(assigned[0] ? `/w/${ws}/agents/${assigned[0].id}` : `/w/${ws}/agents`);
  };
}
