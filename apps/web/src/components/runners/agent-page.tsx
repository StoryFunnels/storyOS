'use client';

import { Plus } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { AgentAvatar } from '@/components/tyron/agent-avatar';
import { Button } from '@/components/ui/button';
import { useMembers } from '@/components/table-view/use-table-data';
import { apiErrorMessage } from '@/lib/api';
import { asksBeforeLine, summaryFor, waitingLine } from '@/lib/runners/agents';
import type { AgentView } from '@/lib/runners/agents';
import { useAgents, useAgentWakes, useMyUserId, useRunnerMutations, useRunners, useWakeSummary } from '@/lib/runners/queries';
import { canChangeRunsOn, ownerRunners } from '@/lib/runners/runs-on';
import { shortDate } from '@/lib/runners/words';
import { HireDialog } from './hire-dialog';
import { FirstRunCard } from './first-run-card';
import { RunList } from './run-list';
import { RunsOnLine } from './runs-on-line';

/**
 * Ticket #1139 AC1, AC3, AC5 — one agent's page: who it is, where it runs ("Runs on <machine> · <tool> [Change]"), the first-time
 * moment when nothing serves it yet, and its runs with their states.
 *
 * Everything on it is read from the real API: the agent is its record in the Agents database, "Runs on" is `agent-wakes/summary`
 * (the assignment, visible to anyone who can read the agent), the Runner list behind Change is the viewer's own Runners and only
 * offered to the agent's OWNER (ADR-0021 Q2), and the rows are the wake queue with the server-derived `run_state`.
 */
export function AgentPage({ ws, agentId }: { ws: string; agentId: string }) {
  const router = useRouter();
  const me = useMyUserId();
  const { agents, dbId, loading, error } = useAgents(ws);
  const agent = agents.find((a) => a.id === agentId);
  const usesRunner = Boolean(agent?.usesRunner);
  const runners = useRunners(ws);
  const summary = useWakeSummary(ws);
  const wakes = useAgentWakes(ws, agent?.id);
  const members = useMembers(ws, true);
  const m = useRunnerMutations(ws);
  const [hireOpen, setHireOpen] = useState(false);

  if (loading) return <p className="p-6 text-body text-muted">Loading…</p>;
  if (error || !agent) {
    return (
      <div className="p-6" data-testid="agent-missing">
        <h1 className="text-title font-semibold text-ink">Agent not found</h1>
        <p className="mt-2 text-body text-muted">
          It may have been removed, or you may not have access to it.{' '}
          <Link className="font-medium text-primary-text underline" href={`/w/${ws}/agents`}>
            See all agents
          </Link>
        </p>
      </div>
    );
  }

  const isOwner = canChangeRunsOn(agent.ownerId, me);
  const ownerName = isOwner ? 'you' : (members.data?.find((x) => x.user.id === agent.ownerId)?.user.name ?? 'its owner');
  const row = summaryFor(summary.data, agent.id);
  const assigned = row?.runner ?? null;
  const mine = ownerRunners(runners.data ?? [], agent.ownerId, me);
  const goAdd = () => router.push(`/w/${ws}/settings/runners?add=1`);

  function pick(runnerId: string) {
    m.assign.mutate(
      { agentId: agent!.id, runnerId },
      { onError: (e) => toast.error(apiErrorMessage(e, 'Could not change where this agent runs. Try again.')) },
    );
  }

  return (
    <div className="mx-auto flex max-w-[700px] flex-col gap-[18px] p-4 sm:p-8" data-testid="agent-page">
      <div className="flex items-start gap-3">
        <AgentAvatar name={agent.name} size="lg" />
        <div className="min-w-0 flex-1">
          <h1 className="m-0 text-[20px] font-bold leading-[24px] tracking-[-0.02em] text-ink">{agent.name}</h1>
          <p className="mt-0.5 text-body leading-normal text-muted">{agent.hiredAt ? `Hired ${shortDate(agent.hiredAt)} · ` : ''}Reports to {ownerName}</p>
        </div>
        {dbId && (
          <Button type="button" variant="secondary" size="sm" onClick={() => setHireOpen(true)}>
            <Plus className="h-[13px] w-[13px]" aria-hidden />
            Hire an agent
          </Button>
        )}
      </div>

      {usesRunner ? (
        <>
          {/* A non-owner sees where it runs, read-only: listing or assigning someone else's Runner is not possible. */}
          <RunsOnLine assigned={assigned} runners={mine} canChange={isOwner} onPick={pick} onAdd={goAdd} now={new Date()} pending={m.assign.isPending} />
          {!assigned &&
            (isOwner ? (
              <FirstRunCard
                agentName={agent.name}
                waiting={summary.data ? (row?.waiting ?? 0) : null}
                names={(wakes.data?.data ?? []).filter((w) => w.status === 'queued').flatMap((w) => (w.record?.title ? [w.record.title] : []))}
                onAdd={goAdd}
              />
            ) : (
              <p className="m-0 text-body text-muted" data-testid="owner-must-add">
                {agent.name} hasn’t started work yet. {ownerName === 'its owner' ? 'Its owner' : ownerName} needs to add a Runner for it.
                {row && row.waiting > 0 ? ` ${waitingLine(row.waiting)}.` : ''}
              </p>
            ))}
        </>
      ) : (
        <p className="m-0 text-body text-muted" data-testid="no-runner-needed">
          {!agent.enabled
            ? 'Switched off. StoryOS will not run it.'
            : agent.aiMode === 'StoryOS AI'
              ? 'It thinks with StoryOS AI, so it needs no Runner.'
              : 'It runs its steps without an AI, so it needs no Runner.'}
        </p>
      )}

      <Facts agent={agent} />
      <RunList ws={ws} wakes={wakes.data?.data ?? []} more={Boolean(wakes.data?.next_cursor)} loading={wakes.isPending} error={wakes.isError} />
      {dbId && <HireDialog ws={ws} agentsDbId={dbId} open={hireOpen} onOpenChange={setHireOpen} />}
    </div>
  );
}

function Facts({ agent }: { agent: AgentView }) {
  const rows: Array<[string, string]> = [];
  if (agent.job) rows.push(['Its job', agent.job]);
  if (agent.asksBefore.length) rows.push(['Asks before', asksBeforeLine(agent.asksBefore)]);
  if (rows.length === 0) return null;
  return (
    <dl className="m-0 grid grid-cols-1 gap-x-3.5 gap-y-1.5 rounded-[var(--radius-card)] border border-border-default bg-card px-3.5 py-3 text-body sm:grid-cols-[140px_1fr]" data-testid="agent-facts">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="mt-1.5 text-muted sm:mt-0">{k}</dt>
          <dd className="m-0 text-ink">{v}</dd>
        </div>
      ))}
    </dl>
  );
}
