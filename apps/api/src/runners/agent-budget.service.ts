import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { DB } from '../db/db.module';
import type { Db } from '../db/client';
import { agentBudgetNotices, databases, fields, memberships, records } from '../db/schema';
import { NotificationsService } from '../notifications/notifications.service';
import { BUDGET_FIELD_NAMES, BUDGET_RUN_FIELD, BUDGET_TOKEN_FIELD, budgetPeriod, evaluateBudget, noticeFor, parseBudgetLimit } from './agent-budget';
import type { BudgetLimits, BudgetStatus, BudgetUsage } from './agent-budget';

export interface AgentBudget {
  agent_id: string;
  limits: BudgetLimits;
  status: BudgetStatus;
}

const EMPTY_USAGE: BudgetUsage = { runs: 0, tokens: 0, runsWithTokens: 0, finishedRuns: 0, finishedWithoutTokens: 0, aiFieldTokens: 0, aiFieldCallsWithTokens: 0, aiFieldCallsWithoutTokens: 0 };

/**
 * ticket #1138 — an agent's budget and what it has used this month.
 *
 * WHERE THE NUMBERS COME FROM. The limits are two number fields on the agent's own record (`monthly_token_budget`,
 * `monthly_run_cap`), so a manager edits them where they edit everything else about the agent. Usage is NEVER stored: it is
 * counted from the Runs records the Runner already writes (ticket #1133), by SQL, for the UTC calendar month. Counting is not
 * fetching (CLAUDE.md, #404): one grouped query answers for any number of agents, so nothing here can return the size of one page.
 *
 * WHAT COUNTS. A run is counted when a Runner STARTED it (its `Runner` field is set), by the month its Run record was created
 * (the month it was queued). A Run that is resumed after a subscription limit, or woken once more for the must-comment backstop, is
 * still ONE run. Tokens are the sum of in + out over the runs whose tool REPORTED them; the others are counted as `unmeasured_runs`
 * and never as 0 (agent-budget.ts says how that reads).
 *
 * WHAT A PAUSE IS. Derived, never stored (agent-budget.ts): usage >= limit this month. `blocked()` is what the claim asks.
 */
@Injectable()
export class AgentBudgetService {
  private readonly logger = new Logger(AgentBudgetService.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly notifications: NotificationsService,
  ) {}

  /** The Agents database and the ids of its two budget fields. Null when the workspace has no Agents database or the fields are not there yet. */
  private async agentsDb(workspaceId: string) {
    const db = await this.db.query.databases.findFirst({
      where: and(eq(databases.workspaceId, workspaceId), eq(databases.isSystem, true), eq(databases.systemKey, 'agents'), isNull(databases.deletedAt)),
      columns: { id: true },
    });
    if (!db) return null;
    const rows = await this.db.query.fields.findMany({
      where: and(eq(fields.databaseId, db.id), inArray(fields.apiName, [...BUDGET_FIELD_NAMES])),
      columns: { id: true, apiName: true },
    });
    const by = new Map(rows.map((r) => [r.apiName, r.id]));
    return { id: db.id, tokenFieldId: by.get(BUDGET_TOKEN_FIELD) ?? null, runFieldId: by.get(BUDGET_RUN_FIELD) ?? null };
  }

  /** Each agent's limits, read off its record. A stored value that is not a positive whole number is no limit (never a zero that freezes it). */
  async limitsFor(workspaceId: string, agentIds: string[]): Promise<Map<string, BudgetLimits>> {
    const out = new Map<string, BudgetLimits>();
    if (agentIds.length === 0) return out;
    const info = await this.agentsDb(workspaceId);
    if (!info) return out;
    const rows = await this.db
      .select({ id: records.id, values: records.values })
      .from(records)
      .where(and(eq(records.databaseId, info.id), inArray(records.id, agentIds), isNull(records.deletedAt)));
    for (const r of rows) {
      const v = r.values as Record<string, unknown>;
      out.set(r.id, { tokens: info.tokenFieldId ? parseBudgetLimit(v[info.tokenFieldId]) : null, runs: info.runFieldId ? parseBudgetLimit(v[info.runFieldId]) : null });
    }
    return out;
  }

  /**
   * One month's usage for these agents, from the Runs records. An agent with no Run this month is absent from the map (callers use
   * EMPTY via `?? `): its usage is a true zero, because the count of Run records is a count, not an unreported measurement.
   */
  async usageFor(workspaceId: string, agentIds: string[], now: Date): Promise<Map<string, BudgetUsage>> {
    const out = await this.runUsageFor(workspaceId, agentIds, now);
    // AI-field calls the agent caused (ticket #1138, Otto 2026-11-03): from the `outward.ai_field` log rows, which carry the agent id
    // from the run credential's origin (never a header a caller could set) and, once the call ended, its recorded `usage`.
    // `usage` an object = the vendor reported it; `usage` JSON null = it finished without the vendor saying; no key = the call
    // failed or is still running, which is neither. Counted by SQL for the same UTC month, never by fetching rows.
    if (agentIds.length === 0) return out;
    const { startsAt, resetsAt } = budgetPeriod(now);
    const res = (await this.db.execute(sql`
      SELECT e.agent_id::text AS agent_id,
        coalesce(sum((e.payload -> 'usage' ->> 'tokens_in')::numeric + (e.payload -> 'usage' ->> 'tokens_out')::numeric) FILTER (WHERE jsonb_typeof(e.payload -> 'usage') = 'object'), 0)::float8 AS tokens,
        count(*) FILTER (WHERE jsonb_typeof(e.payload -> 'usage') = 'object')::int AS with_tokens,
        count(*) FILTER (WHERE jsonb_typeof(e.payload -> 'usage') = 'null')::int AS without_tokens
      FROM activity_events e
      WHERE e.workspace_id = ${workspaceId}::uuid AND e.type = 'outward.ai_field' AND e.source = 'agent'
        AND e.created_at >= ${startsAt.toISOString()}::timestamptz AND e.created_at < ${resetsAt.toISOString()}::timestamptz
        AND e.agent_id IN (${sql.join(
          agentIds.map((id) => sql`${id}::uuid`),
          sql`, `,
        )})
      GROUP BY e.agent_id`)) as unknown as { rows?: Array<{ agent_id: string; tokens: number; with_tokens: number; without_tokens: number }> };
    for (const row of res.rows ?? []) {
      out.set(row.agent_id, { ...(out.get(row.agent_id) ?? EMPTY_USAGE), aiFieldTokens: Number(row.tokens), aiFieldCallsWithTokens: row.with_tokens, aiFieldCallsWithoutTokens: row.without_tokens });
    }
    return out;
  }

  /** The Runs-records half of `usageFor`. */
  private async runUsageFor(workspaceId: string, agentIds: string[], now: Date): Promise<Map<string, BudgetUsage>> {
    const out = new Map<string, BudgetUsage>();
    if (agentIds.length === 0) return out;
    const runsDb = await this.db.query.databases.findFirst({
      where: and(eq(databases.workspaceId, workspaceId), eq(databases.isSystem, true), eq(databases.systemKey, 'agent_runs'), isNull(databases.deletedAt)),
      columns: { id: true },
    });
    if (!runsDb) return out;
    const f = await this.db.query.fields.findMany({
      where: and(eq(fields.databaseId, runsDb.id), inArray(fields.apiName, ['agent', 'runner', 'exit', 'tokens_in', 'tokens_out'])),
      columns: { id: true, apiName: true, config: true },
    });
    const by = new Map(f.map((x) => [x.apiName, x]));
    const agentField = by.get('agent');
    const relationId = (agentField?.config as { relation_id?: string } | undefined)?.relation_id;
    const runner = by.get('runner');
    const tin = by.get('tokens_in');
    const tout = by.get('tokens_out');
    const exit = by.get('exit');
    // The Runner-run fields appear with the first Runner run (ticket #1133). Without them nothing has been counted, and that is true.
    if (!relationId || !runner || !tin || !tout || !exit) return out;
    const { startsAt, resetsAt } = budgetPeriod(now);
    const num = (id: string) => sql`(CASE WHEN jsonb_typeof(r.values -> ${id}::text) = 'number' THEN (r.values ->> ${id}::text)::numeric END)`;
    const res = (await this.db.execute(sql`
      SELECT l.to_record_id::text AS agent_id,
        count(*) FILTER (WHERE coalesce(r.values ->> ${runner.id}::text, '') <> '')::int AS runs,
        coalesce(sum(coalesce(${num(tin.id)}, 0) + coalesce(${num(tout.id)}, 0)) FILTER (WHERE ${num(tin.id)} IS NOT NULL OR ${num(tout.id)} IS NOT NULL), 0)::float8 AS tokens,
        count(*) FILTER (WHERE ${num(tin.id)} IS NOT NULL OR ${num(tout.id)} IS NOT NULL)::int AS runs_with_tokens,
        count(*) FILTER (WHERE coalesce(r.values ->> ${exit.id}::text, '') <> '')::int AS finished_runs,
        count(*) FILTER (WHERE coalesce(r.values ->> ${exit.id}::text, '') <> '' AND ${num(tin.id)} IS NULL AND ${num(tout.id)} IS NULL)::int AS finished_without_tokens
      FROM records r
      JOIN record_links l ON l.from_record_id = r.id AND l.relation_id = ${relationId}::uuid
      WHERE r.database_id = ${runsDb.id}::uuid AND r.deleted_at IS NULL
        AND r.created_at >= ${startsAt.toISOString()}::timestamptz AND r.created_at < ${resetsAt.toISOString()}::timestamptz
        AND l.to_record_id IN (${sql.join(
          agentIds.map((id) => sql`${id}::uuid`),
          sql`, `,
        )})
      GROUP BY l.to_record_id`)) as unknown as { rows?: Array<{ agent_id: string; runs: number; tokens: number; runs_with_tokens: number; finished_runs: number; finished_without_tokens: number }> };
    for (const row of res.rows ?? []) {
      out.set(row.agent_id, {
        runs: row.runs,
        tokens: Number(row.tokens),
        runsWithTokens: row.runs_with_tokens,
        finishedRuns: row.finished_runs,
        finishedWithoutTokens: row.finished_without_tokens,
        aiFieldTokens: 0,
        aiFieldCallsWithTokens: 0,
        aiFieldCallsWithoutTokens: 0,
      });
    }
    return out;
  }

  /** Budget status for these agents. `onlyBudgeted` skips an agent with no limit set (the claim does not need to price those). */
  async statuses(workspaceId: string, agentIds: string[], now: Date, opts: { onlyBudgeted?: boolean } = {}): Promise<Map<string, AgentBudget>> {
    const limits = await this.limitsFor(workspaceId, agentIds);
    const wanted = [...limits.entries()].filter(([, l]) => !opts.onlyBudgeted || l.tokens !== null || l.runs !== null).map(([id]) => id);
    const usage = await this.usageFor(workspaceId, wanted, now);
    const period = budgetPeriod(now);
    const out = new Map<string, AgentBudget>();
    for (const id of wanted) {
      const l = limits.get(id)!;
      out.set(id, { agent_id: id, limits: l, status: evaluateBudget(l, usage.get(id) ?? EMPTY_USAGE, period) });
    }
    return out;
  }

  async statusFor(workspaceId: string, agentId: string, now = new Date()): Promise<AgentBudget | null> {
    return (await this.statuses(workspaceId, [agentId], now)).get(agentId) ?? null;
  }

  /**
   * The claim's question: which of these agents may NOT be given a wake now, and how many runs each other budgeted agent may still
   * start this month (a claim of several wakes must not walk past a run cap in one step). Agents with no budget are not in either map.
   */
  async claimGate(workspaceId: string, agentIds: string[], now: Date): Promise<{ blocked: Set<string>; runsLeft: Map<string, number> }> {
    const blocked = new Set<string>();
    const runsLeft = new Map<string, number>();
    for (const [id, b] of await this.statuses(workspaceId, agentIds, now, { onlyBudgeted: true })) {
      if (b.status.state === 'paused') blocked.add(id);
      else if (b.limits.runs !== null) runsLeft.set(id, Math.max(0, b.limits.runs - b.status.runs.used));
    }
    return { blocked, runsLeft };
  }

  /**
   * How many more wakes a one-click catch-up may queue for this agent (the hook ticket #1152 left for this ticket). `null` = no cap;
   * 0 = the agent is paused by its budget. Only the RUN cap converts to a number of wakes; a token budget cannot (a wake's cost is
   * unknown until it ends), so it only stops the catch-up once it has paused the agent.
   */
  async catchUpAllowance(workspaceId: string, agentId: string, now = new Date()): Promise<number | null> {
    const b = await this.statusFor(workspaceId, agentId, now);
    if (!b) return null;
    if (b.status.state === 'paused') return 0;
    return b.limits.runs === null ? null : Math.max(0, b.limits.runs - b.status.runs.used);
  }

  /**
   * Called after a run's usage changes (a Runner started it, or a completion wrote its tokens). Sends the 80% and 100% notices to the
   * agent's manager (its owner), each AT MOST ONCE per (agent, month, metric, level, limit value): the insert into
   * `agent_budget_notices` is the claim on sending it, so two processes cannot both send. If sending fails the row is removed so the
   * next change retries it, instead of a lost notice being recorded as a sent one. Never throws: a notice must not fail a completion.
   */
  async afterUsageChange(workspaceId: string, agentId: string, now = new Date()): Promise<void> {
    try {
      const b = await this.statusFor(workspaceId, agentId, now);
      if (!b || b.status.state === 'none') return;
      const notices = noticeFor(b.status);
      if (notices.length === 0) return;
      const agent = await this.db.query.records.findFirst({ where: eq(records.id, agentId), columns: { title: true, createdBy: true, databaseId: true } });
      // Who is told: the agent's manager (its creator) while they are an active member; if they left (or the creator is unknown), the
      // workspace's active admins. If NOBODY can be told, nothing is recorded as sent, so a later change can still send it: a notice
      // row means "someone was told", never "we tried".
      const recipients = await this.recipientsFor(workspaceId, agent?.createdBy ?? null);
      if (!agent || recipients.length === 0) {
        this.logger.warn(`budget notice for agent ${agentId}: nobody in workspace ${workspaceId} can be told (no active manager or admin); not recorded as sent`);
        return;
      }
      for (const n of notices) {
        const [row] = await this.db
          .insert(agentBudgetNotices)
          .values({ workspaceId, agentId, period: b.status.period.key, metric: n.metric, level: n.level, limitValue: n.limit })
          .onConflictDoNothing()
          .returning({ id: agentBudgetNotices.id });
        if (!row || n.silent) continue;
        try {
          await this.notifications.notify({
            workspaceId,
            databaseId: agent.databaseId,
            recordId: agentId,
            actorId: recipients[0]!,
            type: n.level === 'warning' ? 'agent_budget_warning' : 'agent_budget_paused',
            recipients,
            allowSelf: true,
            snippet: this.sentence(agent.title, n, b),
          });
        } catch (error) {
          await this.db.delete(agentBudgetNotices).where(eq(agentBudgetNotices.id, row.id));
          throw error;
        }
      }
    } catch (error) {
      this.logger.warn(`budget notice for agent ${agentId} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** The agent's creator if they are still an active member, else the workspace's active admins (capped by notify at 20). */
  private async recipientsFor(workspaceId: string, createdBy: string | null): Promise<string[]> {
    if (createdBy) {
      const m = await this.db.query.memberships.findFirst({ where: and(eq(memberships.workspaceId, workspaceId), eq(memberships.userId, createdBy), eq(memberships.status, 'active')), columns: { userId: true } });
      if (m) return [m.userId];
    }
    const admins = await this.db.select({ userId: memberships.userId }).from(memberships).where(and(eq(memberships.workspaceId, workspaceId), eq(memberships.role, 'admin'), eq(memberships.status, 'active')));
    return admins.map((a) => a.userId);
  }

  private sentence(name: string, n: { metric: 'tokens' | 'runs'; level: 'warning' | 'paused'; limit: number }, b: AgentBudget): string {
    const unit = n.metric === 'tokens' ? 'tokens' : 'runs';
    const m = b.status[n.metric];
    const used = m.used === null ? 'an unknown number of' : m.used.toLocaleString('en-US');
    const partial = n.metric === 'tokens' && b.status.tokens.measurement === 'partial' ? ` (at least; ${b.status.tokens.unmeasured_runs} finished run(s) and ${b.status.tokens.ai_field.unmeasured_calls} AI-field call(s) did not report tokens)` : '';
    const resets = b.status.period.resets_at.slice(0, 10);
    if (n.level === 'warning') {
      return `${name} has used ${used} of its ${n.limit.toLocaleString('en-US')} ${unit} this month${partial}: over 80%. At 100% it pauses until you raise its budget or the month resets (${resets}).`;
    }
    return `${name} is paused: it has used ${used} of its ${n.limit.toLocaleString('en-US')} ${unit} this month${partial}. It starts again when you raise its budget or on ${resets} (UTC). Work waits in its queue meanwhile.`;
  }
}
