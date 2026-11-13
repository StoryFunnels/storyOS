'use client';

import { entityGateView } from '@/components/quill/entity-gate';
import { useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { ReactNode } from 'react';
import { toast } from 'sonner';
import { AgentAvatar } from '@/components/tyron/agent-avatar';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { useMembers } from '@/components/table-view/use-table-data';
import { apiErrorMessage } from '@/lib/api';
import { asksBeforeLine, asksBeforePhrases, summaryFor } from '@/lib/runners/agents';
import { queuedRunsLine, recordsWaitingCount, runnerLineState } from '@/lib/runners/runner-state';
import type { AgentView } from '@/lib/runners/agents';
import { useAgents, useAgentWakes, useMyUserId, useRunnerMutations, useRunners, useSaveAgentSettings, useWakeSummary } from '@/lib/runners/queries';
import { canSeeRunnerDetails, canLetAgentThink, canRunAgentNow } from '@/lib/runners/access';
import { confirmLetItThink, runWithoutAiToast } from '@/lib/runners/let-it-think-copy';
import { letItThinkToast, NON_AI, offersLetItThink, offersRunNow, offersRunWithoutAi, openManualWake, OWN_AI, runNowToast, soleOnlineRunner } from '@/lib/runners/let-it-think';
import { useAgentsDatabaseAccess, useRunNow, useSetAiMode } from '@/lib/runners/use-let-it-think';
import { useDatabases, useWorkspace } from '@/lib/queries';
import type { DatabaseSummary } from '@/lib/queries';
import { AGENT_SYSTEM_LABELS, agentSystemDatabases } from '@/lib/system-databases';
import { canChangeRunsOn, ownerRunners } from '@/lib/runners/runs-on';
import { canEditAgentSettings } from '@/lib/runners/agent-settings';
import { clockTime, limitBrand, shortDate, toolName } from '@/lib/runners/words';
import { catchUpCount, offersCatchUp } from '@/lib/runners/catch-up';
import { CATCH_UP_FAILED, startedToast } from '@/lib/runners/catch-up-copy';
import { useCatchUp, useCatchUpScope } from '@/lib/runners/use-catch-up';
import { useAgentScope, useAgentWakeLines } from '@/lib/runners/use-agent-facts';
import { canReadWakeFacts } from '@/lib/runners/wake-facts';
import { isAgentWorkable } from '@/lib/runners/works-in';
import { NonAiLine, RunNowButton } from './let-it-think';
import { FirstRunCard } from './first-run-card';
import { AgentAdvanced } from './agent-advanced';
import { CatchUpBox } from './catch-up-box';
import { RunList } from './run-list';
import { RunnerUnknownLine } from './runner-unknown-line';
import { WakesWhenValue, WorksInValue } from './agent-wake-facts';
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
  const qc = useQueryClient();
  const me = useMyUserId();
  const { agents, dbId, myAccess, settingsFieldsReady, loading, error } = useAgents(ws);
  const agent = agents.find((a) => a.id === agentId);
  const usesRunner = Boolean(agent?.usesRunner);
  const runners = useRunners(ws);
  const summary = useWakeSummary(ws);
  const wakes = useAgentWakes(ws, agent?.id);
  const members = useMembers(ws, true);
  const m = useRunnerMutations(ws);
  const saveSettings = useSaveAgentSettings(ws, dbId);
  const databases = useDatabases(ws);
  const workspaceInfo = useWorkspace(ws).data;
  const role = workspaceInfo?.role;
  const masked = !canSeeRunnerDetails(role);
  const agentsAccess = useAgentsDatabaseAccess(ws);
  const aiMode = useSetAiMode(ws, dbId);
  const runNow = useRunNow(ws);
  const confirm = useConfirm();
  // Ticket #1152: the count is the server's (`catch_up` in the summary, null for anyone but the owner or an admin); the words
  // (noun, state) are read only once there is a box to word, and fall back to "record" if they cannot be.
  const catchUpRow = summaryFor(summary.data, agentId);
  const catchUp = catchUpCount(catchUpRow);
  const catchUpWords = useCatchUpScope(ws, agentId, catchUp !== null);
  const catchUpMutation = useCatchUp(ws);
  const [catchUpError, setCatchUpError] = useState<string | null>(null);
  // Ticket #1289: what wakes it and where it works. Both reads are admin-only on the server, so nobody else is asked and nobody
  // else sees the rows (hidden, never "nothing configured").
  const readsFacts = canReadWakeFacts(role);
  const wakeLines = useAgentWakeLines(ws, agentId, readsFacts);
  const scope = useAgentScope(ws, agentId, readsFacts);

  if (loading) return <p className="p-6 text-body text-muted">Loading…</p>;
  // #1291 — an agent that is not in the list this person may read is the 404 page (the same one every other missing thing gets);
  // a list that failed to load says nothing about the agent, so that is a Retry.
  if (error) return entityGateView({ kind: 'failed', error: null }, () => void qc.invalidateQueries());
  if (!agent) return entityGateView({ kind: 'gone' });

  const isOwner = canChangeRunsOn(agent.ownerId, me);
  const ownerName = isOwner ? 'you' : (members.data?.find((x) => x.user.id === agent.ownerId)?.user.name ?? 'its owner');
  const row = summaryFor(summary.data, agent.id);
  // Ticket #1223: "No Runner yet" is only said once the summary has loaded and named none; loading and failed say something else.
  const runnerState = runnerLineState(summary, agent.id);
  const assigned = runnerState.kind === 'assigned' ? runnerState.runner : null;
  const mine = ownerRunners(runners.data ?? [], agent.ownerId, me);
  const assignedRunner = mine.find((r) => r.id === assigned?.id);
  const workspaceModel = workspaceInfo?.settings?.default_agent_model ?? null;
  const goAdd = () => router.push(`/w/${ws}/settings/runners?add=1`);

  // Ticket #1210: the manager (or an admin) may move a Non-AI agent to Your own AI from here, preselecting the manager's only online Runner.
  const ownAiOptionId = agentsAccess.optionId(OWN_AI);
  const mayLetItThink = offersLetItThink(agent) && canLetAgentThink({ role, isOwner, myAccess: agentsAccess.myAccess }) && Boolean(dbId) && Boolean(ownAiOptionId);
  async function letItThink() {
    if (!ownAiOptionId) return;
    // Cost and privacy in plain words, and that no run starts by itself: one Cancel away from a slip.
    if (!(await confirm(confirmLetItThink(agent!.name)))) return;
    const preselect = soleOnlineRunner(mine);
    aiMode.letItThink.mutate(
      { agentId: agent!.id, ownAiOptionId, preselect: preselect ? { id: preselect.id, name: preselect.name } : null },
      {
        onSuccess: (result) => (result.assignError ? toast.warning : toast.success)(letItThinkToast(agent!.name, result, isOwner)),
        onError: (e) => toast.error(apiErrorMessage(e, 'Could not switch this agent to your AI. Try again.')),
      },
    );
  }
  // Ticket #1210: the way back lives in Advanced, for the same people, and only for an agent that thinks with their own AI.
  const nonAiOptionId = agentsAccess.optionId(NON_AI);
  const mayRunWithoutAi = offersRunWithoutAi(agent) && canLetAgentThink({ role, isOwner, myAccess: agentsAccess.myAccess }) && Boolean(dbId) && Boolean(nonAiOptionId);
  function runWithoutAi() {
    if (!nonAiOptionId) return;
    aiMode.switchBack.mutate(
      { agentId: agent!.id, nonAiOptionId },
      {
        onSuccess: () => toast.success(runWithoutAiToast(agent!.name)),
        onError: (e) => toast.error(apiErrorMessage(e, 'Could not switch this agent. Try again.')),
      },
    );
  }
  // Ticket #1210: "Run now" is a manual wake, for an agent a Runner serves, for an admin (the start endpoint is admin-only).
  const mayRunNow = offersRunNow(agent, assigned, canRunAgentNow(role));
  function runAgentNow() {
    runNow.mutate(agent!.id, {
      onSuccess: () => toast.success(runNowToast(agent!.name, Boolean(row?.can_run), assigned?.name ?? null)),
      onError: (e) => toast.error(apiErrorMessage(e, 'Could not start this agent. Try again.')),
    });
  }

  function pick(runnerId: string) {
    m.assign.mutate(
      { agentId: agent!.id, runnerId },
      { onError: (e) => toast.error(apiErrorMessage(e, 'Could not change where this agent runs. Try again.')) },
    );
  }

  return (
    <div className="mx-auto flex max-w-[700px] flex-col gap-[18px] p-4 sm:p-8" data-testid="agent-page">
      {/* Ticket #1289 item 2: the way back. Hiring belongs to the list, not to one agent's page. */}
      <Link href={`/w/${ws}/agents`} className="-mb-1 w-fit text-label font-semibold text-primary-text hover:underline" data-testid="agent-back">
        ← Agents
      </Link>
      <div className="flex items-start gap-3">
        <AgentAvatar name={agent.name} size="lg" shape="circle" />
        <div className="min-w-0 flex-1">
          <h1 className="m-0 text-[20px] font-bold leading-[24px] tracking-[-0.02em] text-ink">{agent.name}</h1>
          <p className="mt-0.5 text-body leading-normal text-muted">{agent.hiredAt ? `Hired ${shortDate(agent.hiredAt)} · ` : ''}Reports to {ownerName}</p>
        </div>
      </div>

      {usesRunner ? (
        <>
          {/* A non-owner sees where it runs, read-only: listing or assigning someone else's Runner is not possible. */}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            {runnerState.kind === 'loading' || runnerState.kind === 'failed' ? (
              <RunnerUnknownLine failed={runnerState.kind === 'failed'} onRetry={() => void summary.refetch()} retrying={summary.isFetching} />
            ) : (
              <RunsOnLine assigned={assigned} runners={mine} canChange={isOwner} masked={masked} onPick={pick} onAdd={goAdd} now={new Date()} pending={m.assign.isPending} />
            )}
            {mayRunNow && <RunNowButton onRun={runAgentNow} pending={runNow.isPending} alreadyQueued={openManualWake(wakes.data?.data ?? [])} />}
          </div>
          {/* Ticket #1152: records already in its trigger state before it could run never wake it; one click starts them. */}
          {catchUp !== null && offersCatchUp({ usesRunner, hasRunner: Boolean(assigned), mayLearnMachine: !masked, count: catchUp }) && (
            <CatchUpBox
              agentName={agent.name}
              count={catchUp}
              words={catchUpWords}
              job={agent.job}
              asksPhrases={asksBeforePhrases(agent.asksBefore)}
              runs={{
                machine: assigned?.name ?? null,
                tool: assignedRunner ? toolName(assignedRunner.chosen_tool, assignedRunner.tools) : null,
                brand: assignedRunner?.chosen_tool ? limitBrand(assignedRunner.chosen_tool, assignedRunner.tools) : null,
                runner: assignedRunner ?? null,
                clock: (iso) => clockTime(iso),
              }}
              pending={catchUpMutation.isPending}
              error={catchUpError}
              onOpen={() => setCatchUpError(null)}
              onStart={async () => {
                setCatchUpError(null);
                try {
                  const result = await catchUpMutation.mutateAsync(agent.id);
                  toast.success(startedToast(agent.name, result, catchUpWords));
                  return true;
                } catch (e) {
                  setCatchUpError(apiErrorMessage(e, CATCH_UP_FAILED));
                  return false;
                }
              }}
            />
          )}
          {runnerState.kind === 'none' &&
            (isOwner ? (
              <FirstRunCard
                agentName={agent.name}
                recordsWaiting={recordsWaitingCount(row)}
                noun={catchUpWords.noun}
                onAdd={goAdd}
              />
            ) : (
              <p className="m-0 text-body text-muted" data-testid="owner-must-add">
                {agent.name} hasn’t started work yet. {ownerName === 'its owner' ? 'Its owner' : ownerName} needs to add a Runner for it.
                {row && row.waiting > 0 ? ` ${queuedRunsLine(row.waiting)}.` : ''}
              </p>
            ))}
        </>
      ) : (
        !agent.enabled ? (
          <p className="m-0 text-body text-muted" data-testid="no-runner-needed">
            Switched off. StoryOS will not run it.
          </p>
        ) : agent.aiMode === 'StoryOS AI' ? (
          <p className="m-0 text-body text-muted" data-testid="no-runner-needed">
            It thinks with StoryOS AI, so it needs no Runner.
          </p>
        ) : (
          <NonAiLine onAct={mayLetItThink ? letItThink : undefined} pending={aiMode.letItThink.isPending} />
        )
      )}

      <Facts
        agent={agent}
        wakes={readsFacts ? <WakesWhenValue state={wakeLines} ws={ws} linkDatabaseId={firstDatabaseId(wakeLines, scope, databases.data ?? [])} /> : null}
        works={readsFacts ? <WorksInValue state={scope} ws={ws} databases={databases.data} /> : null}
      />
      {/* Ticket #1180 — only an agent a Runner serves has tools and a model to choose; a guest is never shown it (same gate as the machine name). */}
      {usesRunner && !masked && (
        <AgentAdvanced
          savedTools={agent.tools}
          savedModel={agent.model}
          workspaceDefaultModel={workspaceModel}
          canEdit={canEditAgentSettings(myAccess)}
          ownerName={isOwner || ownerName === 'its owner' ? null : ownerName}
          brand={assignedRunner?.chosen_tool ? limitBrand(assignedRunner.chosen_tool, assignedRunner.tools) : 'AI'}
          chosenTool={assignedRunner?.chosen_tool}
          saving={saveSettings.isPending}
          onSave={(values) => saveSettings.mutateAsync({ agentId: agent.id, values, ensureFields: !settingsFieldsReady })}
          runWithoutAi={mayRunWithoutAi ? { onSwitch: runWithoutAi, pending: aiMode.switchBack.isPending } : undefined}
        />
      )}
      <RunList masked={masked} ws={ws} wakes={wakes.data?.data ?? []} more={Boolean(wakes.data?.next_cursor)} loading={wakes.isPending} error={wakes.isError} />
      <SystemTables ws={ws} databases={databases.data ?? []} />
    </div>
  );
}

/** Ticket #1289 item 8: "Agent runs" and "Triggers" left the sidebar; the raw tables stay one link from here. Absent until the database exists (or for anyone who cannot open it). */
function SystemTables({ ws, databases }: { ws: string; databases: readonly DatabaseSummary[] }) {
  const sys = agentSystemDatabases(databases);
  const links = (['runs', 'agent triggers'] as const).flatMap((k) => (sys[k] ? [{ label: AGENT_SYSTEM_LABELS[k], id: sys[k]!.id }] : []));
  if (links.length === 0) return null;
  return (
    <p className="m-0 text-label text-muted" data-testid="agent-system-tables">
      The same records as tables:{' '}
      {links.map((l, i) => (
        <span key={l.id}>
          {i > 0 && ' · '}
          <Link className="font-semibold text-primary-text hover:underline" href={`/w/${ws}/d/${l.id}`}>
            {l.label}
          </Link>
        </span>
      ))}
      .
    </p>
  );
}

/** Where the "Automations" link goes: the database of its first trigger, else the first database it works in. Automations has no page of its own, it lives in a database's menu. */
function firstDatabaseId(wakes: ReturnType<typeof useAgentWakeLines>, scope: ReturnType<typeof useAgentScope>, listed: readonly DatabaseSummary[]): string | null {
  if (wakes.status === 'ready') {
    const hit = wakes.value.find((l) => l.databaseId);
    if (hit?.databaseId) return hit.databaseId;
  }
  if (scope.status !== 'ready') return null;
  // The same filter as the Works in row: never link Automations to a system database the row does not list (ticket #1296 is the real fix).
  const sys = new Set(listed.filter((l) => !isAgentWorkable(l)).map((l) => l.id));
  return scope.value.databases?.find((d) => !sys.has(d.id))?.id ?? null;
}

function Facts({ agent, wakes, works }: { agent: AgentView; wakes: ReactNode; works: ReactNode }) {
  const rows: Array<[string, ReactNode]> = [];
  if (agent.job) rows.push(['Its job', agent.job]);
  if (wakes) rows.push(['Wakes when', wakes]);
  if (works) rows.push(['Works in', works]);
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
