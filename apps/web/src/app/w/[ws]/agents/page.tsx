'use client';

import { Plus } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { HireDialog } from '@/components/runners/hire-dialog';
import { StatusMark } from '@/components/runners/status-mark';
import { AgentAvatar } from '@/components/tyron/agent-avatar';
import { Button } from '@/components/ui/button';
import { summaryFor } from '@/lib/runners/agents';
import { useAgents, useRunners, useWakeSummary } from '@/lib/runners/queries';
import { describeRunner } from '@/lib/runners/status';

/**
 * Ticket #1139 — AI › Agents: the hired agents, each with where it runs. One agent is one click from its page. The Agents
 * DATABASE (the table of agent definitions, ticket #1058) is still one link away: the design draws no table here and its silence
 * is not a removal, so it stays reachable.
 */
export default function AgentsIndexPage() {
  const { ws } = useParams<{ ws: string }>();
  const { agents, dbId, loading, error } = useAgents(ws);
  const summary = useWakeSummary(ws);
  const runners = useRunners(ws);
  const [hireOpen, setHireOpen] = useState(false);
  const now = new Date();

  return (
    <div className="mx-auto flex max-w-[700px] flex-col gap-[18px] p-4 sm:p-8" data-testid="agents-index">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="text-[22px] font-bold tracking-[-0.02em] text-ink">Agents</h1>
          <p className="mt-0.5 text-body leading-normal text-muted">The agents you have hired, and where each one runs.</p>
        </div>
        {dbId && (
          <Button type="button" variant="secondary" size="sm" onClick={() => setHireOpen(true)}>
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
        <ul className="m-0 list-none rounded-[var(--radius-card)] border border-border-default bg-card p-0">
          {agents.map((a) => {
            const row = summaryFor(summary.data, a.id);
            const runner = row?.runner ? runners.data?.find((r) => r.id === row.runner!.id) : undefined;
            const status = runner ? describeRunner(runner, now) : null;
            return (
              <li key={a.id} className="flex min-h-[54px] flex-wrap items-center gap-x-3 gap-y-1 border-t border-border-default px-3.5 py-2 first:border-t-0">
                <AgentAvatar name={a.name} />
                <Link href={`/w/${ws}/agents/${a.id}`} className="flex min-w-[160px] flex-1 flex-col leading-[1.35]">
                  <b className="text-body font-medium text-ink hover:underline">{a.name}</b>
                  <span className="text-label text-muted">
                    {!a.usesRunner
                      ? !a.enabled
                        ? 'Switched off'
                        : a.aiMode === 'StoryOS AI'
                          ? 'Thinks with StoryOS AI'
                          : 'Runs without an AI'
                      : row?.runner
                        ? `Runs on ${row.runner.name}`
                        : 'No Runner yet'}
                  </span>
                </Link>
                {status && <StatusMark tone={status.tone}>{status.label}</StatusMark>}
                {a.usesRunner && !row?.runner && <StatusMark tone="off">Waiting for a Runner</StatusMark>}
              </li>
            );
          })}
        </ul>
      )}
      {dbId && (
        <p className="m-0 text-label text-muted">
          <Link className="font-semibold text-primary-text hover:underline" href={`/w/${ws}/d/${dbId}`}>
            Open the Agents database
          </Link>{' '}
          to see every agent’s definition as a table.
        </p>
      )}
      {dbId && <HireDialog ws={ws} agentsDbId={dbId} open={hireOpen} onOpenChange={setHireOpen} />}
    </div>
  );
}
