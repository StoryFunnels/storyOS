'use client';

import { AgentActions } from '@/components/governance/agent-actions';
import { DefaultAgentModel } from '@/components/governance/default-agent-model';
import { AdvancedSection, SettingsBox, SettingsPageHeader, SettingsRow } from '@/components/settings/settings-chrome';
import { Switch } from '@/components/ui/switch';
import { useSkillSharing } from '@/lib/skill-sharing';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useWorkspace } from '@/lib/queries';
import { useDateFormat } from '@/lib/preferences';
import { useDatabase, useMembers } from '@/components/table-view/use-table-data';
import {
  ENFORCED_RULES,
  NOT_COVERED,
  describeAgent,
  describeGate,
  gatesInForce,
  orderGates,
  summariseApprovals,
  ungovernedWorkspace,
  type AgentRecord,
  type ApprovalDto,
  type GatePolicyDto,
} from '@/lib/governance';

const SCOPE_WORDS = { read: 'Read only', write: 'Read and change', admin: 'Admin' } as const;
const WHERE_WORDS = { workspace: 'Whole workspace', space: 'One space', database: 'One database' } as const;

/**
 * One boxed section with the shared Settings box header (ticket #1284), like every other Settings page. The lead sits under the header;
 * `flush` is for a list whose rows draw their own dividers edge to edge, otherwise the content is padded as a body.
 */
function Section({ title, aside, lead, flush, children }: { title: string; aside?: React.ReactNode; lead?: string; flush?: boolean; children: React.ReactNode }) {
  return (
    <SettingsBox title={title} aside={aside} className="mb-6">
      {lead && <p className={`px-3.5 pt-2.5 text-label text-muted ${flush ? 'pb-2.5 border-b border-border-default' : ''}`}>{lead}</p>}
      <div className={flush ? '' : 'px-3.5 py-3'}>{children}</div>
    </SettingsBox>
  );
}

/** A note that should not be skimmed past. Uses a marker, not coloured text: the page's words stay at ink contrast. */
function Note({ tone, children }: { tone: 'plain' | 'warn'; children: React.ReactNode }) {
  return (
    <p className="flex gap-2 text-body text-ink-secondary">
      <span
        aria-hidden
        className={tone === 'warn' ? 'mt-1.5 h-2 w-2 shrink-0 rounded-full bg-warning' : 'mt-1.5 h-2 w-2 shrink-0 rounded-full bg-border-strong'}
      />
      <span>{children}</span>
    </p>
  );
}

/**
 * #546 — the governance screen: who your agents are, what each can reach, which gates are in force,
 * and what people recently approved or refused. A READ surface: there is no control here that
 * widens a scope or decides an approval; those live where they always did.
 *
 * It states only what the server enforces (see lib/governance.ts), and it says what it cannot show.
 */
export default function AgentRulesPage() {
  const { ws } = useParams<{ ws: string }>();
  const skills = useSkillSharing(ws);
  const workspace = useWorkspace(ws);
  const isAdmin = (workspace.data as { role?: string } | undefined)?.role === 'admin';
  const { dateTime } = useDateFormat();
  const members = useMembers(ws, isAdmin);
  const nameOf = (id: string | null | undefined) =>
    id ? ((members.data ?? []).find((m) => m.user.id === id)?.user.name ?? 'A member who has left') : '—';

  const pack = useQuery({
    queryKey: ['agents-pack', ws],
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/workspaces/{ws}/agents', { params: { path: { ws } } } as never);
      if (error) throw error;
      return data as unknown as { exists: boolean; id?: string };
    },
    enabled: isAdmin,
  });
  const agentsDbId = pack.data?.exists ? pack.data.id : undefined;
  const agentsDb = useDatabase(ws, agentsDbId ?? '');
  const agentRows = useQuery({
    queryKey: ['governance-agents', ws, agentsDbId],
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/workspaces/{ws}/databases/{db}/records', {
        params: { path: { ws, db: agentsDbId! }, query: { limit: 100 } },
      } as never);
      if (error) throw error;
      return (data as unknown as { data: AgentRecord[]; has_more?: boolean });
    },
    enabled: isAdmin && Boolean(agentsDbId),
  });
  const gates = useQuery({
    queryKey: ['governance-gates', ws],
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/workspaces/{ws}/action-gates', { params: { path: { ws } } } as never);
      if (error) throw error;
      return (data as unknown as { data: GatePolicyDto[] }).data;
    },
    enabled: isAdmin,
  });
  const approvals = useQuery({
    queryKey: ['governance-approvals', ws],
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/workspaces/{ws}/approvals', { params: { path: { ws } } } as never);
      if (error) throw error;
      const body = data as unknown as ApprovalDto[] | { data: ApprovalDto[] };
      return Array.isArray(body) ? body : body.data;
    },
    enabled: isAdmin,
  });

  if (workspace.isLoading) return <p className="p-8 text-body text-muted">Loading…</p>;
  if (!isAdmin) {
    return (
      <div className="mx-auto max-w-3xl p-4 sm:p-8">
        <h1 className="mb-1 text-lg font-semibold text-ink">Agent rules</h1>
        <p className="text-body text-muted">Only workspace admins can see this page.</p>
      </div>
    );
  }

  const loading = pack.isLoading || gates.isLoading || approvals.isLoading || (Boolean(agentsDbId) && (agentRows.isLoading || agentsDb.isLoading));
  const failed = pack.isError || gates.isError || approvals.isError || agentRows.isError;

  const fields = agentsDb.data?.fields ?? [];
  const agents = (agentRows.data?.data ?? []).map((a) => describeAgent(a, fields));
  const gateRows = orderGates((gates.data ?? []).map(describeGate));
  const inForce = gatesInForce(gateRows);
  const summary = summariseApprovals(approvals.data ?? []);
  const recent = (approvals.data ?? []).filter((a) => a.status !== 'pending').slice(0, 15);
  const pending = (approvals.data ?? []).filter((a) => a.status === 'pending');

  // The disclosure stays closed, so its one-line summary carries the two facts a person must not have to open it to learn.
  const advancedSummary = loading
    ? 'agents, gates, approvals and what always holds'
    : failed
      ? 'some of this could not be loaded'
      : ungovernedWorkspace(agents, inForce)
        ? 'no approval gate is in force'
        : 'agents, gates, approvals and what always holds';

  return (
    <div className="mx-auto max-w-3xl p-4 sm:p-8">
      <SettingsPageHeader title="Agent rules" lead="What AI may do in this workspace without asking a person" />
      <DefaultAgentModel ws={ws} />
      <SettingsBox className="mb-6">
        <SettingsRow
          title="Let AI share skills with the whole workspace"
          description="A skill an AI writes is shared straight away and always marked as AI-written. Off: AI-written skills stay private to the person whose AI wrote them. Only a person can change this. Skills already shared stay shared."
          inlineControls
        >
          <Switch
            checked={skills.on}
            onCheckedChange={skills.set}
            disabled={skills.loading || skills.saving}
            aria-label="Let AI share skills with the whole workspace"
          />
        </SettingsRow>
      </SettingsBox>
      <Section
        flush
        title="Recent agent actions"
        aside={
          <Link
            href={`/w/${ws}/settings/audit-log`}
            className="text-label font-medium text-ink-secondary underline-offset-2 hover:text-ink hover:underline"
          >
            Full audit log →
          </Link>
        }
        lead="What agents and API tokens changed lately, newest first, each with the credential that did it and the member it ran as. Select one for the full chain."
      >
        <AgentActions ws={ws} />
      </Section>

      <AdvancedSection title="How agent rules are enforced" summary={advancedSummary}>
        <div className="p-4 [&>section:last-child]:mb-0 [&>div:last-child]:mb-0">
          <p className="mb-6 text-body text-muted">
            Here: which agents exist here, what each one can reach, what is held for a person to approve, and what people recently
            decided. Apart from the default model and the skill-sharing switch above, nothing on this page changes a scope or decides an approval.
          </p>

          {loading ? (
            <p className="text-body text-muted">Loading…</p>
          ) : failed ? (
            <p className="text-body text-ink">
              Some of this could not be loaded. Nothing below should be read as complete until it loads.
            </p>
          ) : (
            <>
              {ungovernedWorkspace(agents, inForce) && (
                <div className="mb-8 rounded-[var(--radius-card)] border border-border-default p-3">
                  <Note tone="warn">
                    Agents here can change records. No agent policy asks a person first, and no workspace delete
                    gate is in force.
                  </Note>
                </div>
              )}

              <Section flush title="Agents" lead="What each agent declares it may do. When StoryOS runs an agent, the run is held to this.">
                {!agentsDbId || agents.length === 0 ? (
                  <p className="px-3.5 py-3 text-body text-muted">
                    No agents are set up in this workspace. This page lists agents defined here; it does not list API
                    tokens or connected AI clients, which can still act as the person who created them.
                  </p>
                ) : (
                  <div>
                    {agents.map((a) => (
                      <div key={a.id} className="flex flex-col gap-1.5 border-b border-border-default px-3.5 py-2.5 last:border-b-0">
                        <div className="flex items-center gap-2">
                          <span className="text-body font-medium text-ink">{a.name}</span>
                          <span className="rounded bg-hover px-1.5 py-0.5 text-meta text-ink-secondary">
                            {SCOPE_WORDS[a.scopeCeiling]}
                          </span>
                        </div>
                        {a.notes.map((n) => (
                          <Note key={n.text} tone={n.tone}>
                            {n.text}
                          </Note>
                        ))}
                      </div>
                    ))}
                  </div>
                )}
              </Section>

              <Section flush title="Gates in force" lead="Rules for the whole workspace, a space or one database that hold an action until a named person approves it.">
                {gateRows.length === 0 ? (
                  <p className="px-3.5 py-3 text-body text-muted">
                    No gate is declared, so deleting records is not held for approval by a workspace rule.
                  </p>
                ) : (
                  <div>
                    {gateRows.map((g) => (
                      <div key={g.id} className="flex flex-col gap-1 border-b border-border-default px-3.5 py-2.5 last:border-b-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-body font-medium text-ink">{g.what}</span>
                          <span className="rounded bg-hover px-1.5 py-0.5 text-meta text-ink-secondary">{WHERE_WORDS[g.where]}</span>
                          <span className="text-label text-ink-secondary">
                            {g.state === 'in_force' ? 'In force' : g.state === 'off' ? 'Switched off' : 'Does nothing'}
                          </span>
                        </div>
                        <span className="text-body text-ink-secondary">Approver: {nameOf(g.approverId)}</span>
                        {g.reason && <Note tone="warn">{g.reason}</Note>}
                      </div>
                    ))}
                  </div>
                )}
              </Section>

              <Section
                flush
                title="Approvals"
                lead={`${pending.length} waiting. Of the latest ${summary.shown}: ${summary.approved} approved, ${summary.rejected} rejected, ${summary.expired} expired.`}
              >
                {recent.length === 0 ? (
                  <p className="px-3.5 py-3 text-body text-muted">Nobody has decided an approval yet.</p>
                ) : (
                  <div>
                    {recent.map((a) => (
                      <div key={a.id} className="flex flex-col gap-0.5 border-b border-border-default px-3.5 py-2.5 last:border-b-0">
                        <span className="text-body text-ink">{a.preview_text ?? 'An action'}</span>
                        <span className="text-label text-ink-secondary">
                          {a.status === 'approved' ? 'Approved' : a.status === 'rejected' ? 'Rejected' : 'Expired, nobody decided'}
                          {a.decided_by ? ` by ${nameOf(a.decided_by)}` : ''}
                          {a.decided_at ? ` · ${dateTime(a.decided_at)}` : ''}
                        </span>
                        {a.reason && <span className="text-label text-ink-secondary">Reason: {a.reason}</span>}
                      </div>
                    ))}
                  </div>
                )}
              </Section>


              <Section title="Always enforced" lead="These hold in every workspace.">
                <ul className="flex flex-col gap-2">
                  {ENFORCED_RULES.map((r) => (
                    <li key={r.title}>
                      <p className="text-body font-medium text-ink">{r.title}</p>
                      <p className="text-body text-ink-secondary">{r.detail}</p>
                    </li>
                  ))}
                </ul>
              </Section>

              <Section title="What this page cannot show">
                <ul className="flex flex-col gap-1.5">
                  {NOT_COVERED.map((t) => (
                    <li key={t}>
                      <Note tone="plain">{t}</Note>
                    </li>
                  ))}
                </ul>
              </Section>
            </>
          )}
        </div>
      </AdvancedSection>
    </div>
  );
}
