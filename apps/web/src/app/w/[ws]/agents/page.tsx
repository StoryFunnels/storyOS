'use client';

import { Plus } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { HireDialog } from '@/components/runners/hire-dialog';
import { StatusMark } from '@/components/runners/status-mark';
import { AgentAvatar } from '@/components/tyron/agent-avatar';
import { Button } from '@/components/ui/button';
import { useMembers } from '@/components/table-view/use-table-data';
import { agentCountLine, lastRunLabel, lastRunState, lastRunTitle, lastRunsByAgent, managerLabel, needsDirectory, runsOnCell } from '@/lib/runners/agent-list';
import { summaryFor } from '@/lib/runners/agents';
import { useAgents, useLastRuns, useMembersDirectory, useRunners, useWakeSummary } from '@/lib/runners/queries';
import { canHireAgents, canSeeRunnerDetails } from '@/lib/runners/access';
import { useWorkspace } from '@/lib/queries';
import { describeRunner } from '@/lib/runners/status';

/**
 * Tickets #1139 and #1196 — AI › Agents: the workspace's agents as a list (Agent with its job, Runs on, Status, Last run, Manager),
 * Hire an agent at the top, a row opens the agent's page. The Agents DATABASE (the table of agent definitions, ticket #1058) is
 * still one link away: the design draws no table here and its silence is not a removal, so it stays reachable.
 *
 * At phone width a row keeps the agent and where it runs; status, last run and manager are one tap away on its page.
 */
const COLS = 'grid items-center gap-2.5 px-3 grid-cols-[minmax(0,1fr)_auto] min-[701px]:grid-cols-[minmax(140px,1.6fr)_minmax(90px,1fr)_150px_84px_104px]';

export default function AgentsIndexPage() {
  const { ws } = useParams<{ ws: string }>();
  const { agents, dbId, loading, error } = useAgents(ws);
  const summary = useWakeSummary(ws);
  const runners = useRunners(ws);
  const members = useMembers(ws, true);
  const lastRunPage = useLastRuns(ws);
  const lastRuns = lastRunsByAgent(agents.map((a) => a.id), lastRunPage.data?.wakes, lastRunPage.data?.hasMore ?? false);
  const directory = useMembersDirectory(ws, needsDirectory(agents, members.data));
  const [hireOpen, setHireOpen] = useState(false);
  const workspace = useWorkspace(ws).data;
  const role = workspace?.role;
  const showMachine = canSeeRunnerDetails(role);
  const now = new Date();

  return (
    <div className="mx-auto flex max-w-[700px] flex-col gap-[18px] p-4 sm:px-7 sm:py-8" data-testid="agents-index">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="text-[22px] font-bold tracking-[-0.02em] text-ink">Agents</h1>
          <p className="mt-0.5 text-body leading-normal text-muted">
            The AI teammates working in {workspace?.name ?? 'this workspace'}. Each one has a job, a manager, and asks before anything you say it must.
          </p>
        </div>
        {dbId && canHireAgents(role) && (
          <Button type="button" size="sm" onClick={() => setHireOpen(true)}>
            <Plus className="h-[13px] w-[13px]" aria-hidden />
            Hire an agent
          </Button>
        )}
      </div>
      {loading ? (
        <p role="status" className="text-body text-muted">
          Loading…
        </p>
      ) : error ? (
        <p role="alert" className="text-body text-error">
          Could not load your agents. Try again in a moment.
        </p>
      ) : agents.length === 0 ? (
        <p className="text-body text-muted">No agent is hired yet. Hire one above, or install a Business Pack that includes agents.</p>
      ) : (
        <div className="overflow-hidden rounded-[var(--radius-card)] border border-border-default bg-card" data-testid="agents-list">
          <div className={`${COLS} py-2.5 text-label font-semibold text-muted max-[700px]:hidden`} role="presentation">
            <span>Agent</span>
            <span>Runs on</span>
            <span className="max-[700px]:hidden">Status</span>
            <span className="max-[700px]:hidden">Last run</span>
            <span className="max-[700px]:hidden">Manager</span>
          </div>
          {agents.map((a) => {
            const row = summaryFor(summary.data, a.id);
            const runner = row?.runner ? runners.data?.find((r) => r.id === row.runner!.id) : undefined;
            const status = runner ? describeRunner(runner, now) : null;
            const placed = runsOnCell(a, row?.runner, showMachine);
            const last = lastRuns[a.id] ?? ({ kind: 'unknown' } as const);
            return (
              <Link key={a.id} href={`/w/${ws}/agents/${a.id}`} className={`${COLS} border-t border-border-default py-2.5 text-body text-ink hover:bg-hover max-[700px]:[&:nth-child(2)]:border-t-0`} data-testid="agent-row">
                <span className="flex min-w-0 items-center gap-2">
                  <AgentAvatar name={a.name} />
                  <span className="min-w-0 leading-[1.35]">
                    <b className="block truncate font-semibold">{a.name}</b>
                    <small className="line-clamp-2 text-label text-muted">{a.job || 'No job written yet'}</small>
                  </span>
                </span>
                <span className={`truncate ${a.usesRunner && !row?.runner ? 'text-muted' : ''}`}>{placed}</span>
                <span className="max-[700px]:hidden">
                  {status ? <StatusMark tone={status.tone}>{status.label}</StatusMark> : a.usesRunner && !row?.runner ? <StatusMark tone="off">Waiting for a Runner</StatusMark> : null}
                </span>
                <span className="min-w-0 leading-[1.3] text-muted max-[700px]:hidden" title={lastRunTitle(last)} data-testid="last-run">
                  {lastRunLabel(last, now)}
                  {lastRunState(last) && <small className="block truncate text-label">{lastRunState(last)}</small>}
                </span>
                <span className="truncate max-[700px]:hidden">{managerLabel(a, members.data, directory.data)}</span>
              </Link>
            );
          })}
        </div>
      )}
      {agents.length > 0 && <p className="m-0 text-label text-muted">{agentCountLine(agents.length)}</p>}
      {dbId && (
        <p className="m-0 text-label text-muted">
          <Link className="font-semibold text-primary-text hover:underline" href={`/w/${ws}/d/${dbId}`}>
            Open the Agents database
          </Link>{' '}
          to see every agent’s definition as a table.
        </p>
      )}
      {dbId && canHireAgents(role) && <HireDialog ws={ws} agentsDbId={dbId} open={hireOpen} onOpenChange={setHireOpen} />}
    </div>
  );
}
