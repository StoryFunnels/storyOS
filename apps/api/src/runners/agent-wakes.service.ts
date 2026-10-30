import type { TokenScope } from '@storyos/schemas';
import { RunCredentialsService } from '../tokens/run-credentials.service';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, asc, desc, eq, inArray, isNull, lt, lte, sql } from 'drizzle-orm';
import { DB } from '../db/db.module';
import type { Db } from '../db/client';
import { agentWakes, databases, fields, memberships, records, runnerAgents, runners, selectOptions, spaces } from '../db/schema';
import { codedException } from '../common/coded-exception';
import { AccessService } from '../access/access.service';
import { NotificationsService } from '../notifications/notifications.service';
import type { Membership } from '../workspaces/workspace-access.guard';
import { runnerConnection, offlineSince } from './runner-present';
import type { RunnerRow } from './runner-present';
import {
  WAKE_CLAIM_MAX,
  WAKE_HISTORY_TTL_MS,
  WAKE_LEASE_SECONDS,
  WAKE_LONG_POLL_MAX_SECONDS,
  WAKE_LONG_POLL_TICK_MS,
  WAKE_MAX_ATTEMPTS,
  WAKE_MAX_DEPTH,
  WAKE_QUEUE_TTL_MS,
  WAKE_RUN_CEILING_MS,
} from './wake.constants';
import type { WakeReason, WakeStatus } from './wake.constants';
import { deriveRunState } from './run-state';
import type { RunState } from './run-state';
import type { WakeCompleteInput } from './runner.dto';

export type WakeRow = typeof agentWakes.$inferSelect;

/** One entry of `reasons`: a distinct reason merged into a wake, how many times it arrived, and what it carried (never record text). */
export interface WakeReasonEntry {
  reason: string;
  count: number;
  last_at: string;
  detail?: Record<string, unknown>;
}

export interface EnqueueInput {
  workspaceId: string;
  agentId: string;
  reason: WakeReason;
  recordId?: string | null;
  /** The person whose action caused the wake (the access check's subject). null = nobody (a system cause); then only the owner is checked. */
  requestedBy: string | null;
  depth?: number;
  /** Idempotency for a REPLAY of the same event (a comment id, an approval id). */
  sourceKey?: string | null;
  /** What the cause carries that is not record text (a `run_agent` prompt override). Last writer wins. */
  context?: Record<string, unknown> | null;
  /** What goes on this reason's entry in `reasons` (an approval's verdict). */
  detail?: Record<string, unknown>;
  /** Create the Run for a NEW wake through the registered hook. `dispatchRun` passes false: it makes its own Run (and has already stamped the class). */
  materialize?: boolean;
}

export type SkipCode =
  | 'loop_guard'
  | 'agent_not_found'
  | 'agent_disabled'
  | 'not_own_ai'
  | 'owner_inactive'
  | 'requester_not_member'
  | 'agent_not_visible'
  | 'record_not_found'
  | 'personal_content'
  | 'record_not_visible'
  | 'owner_cannot_read';

export type EnqueueResult =
  | { outcome: 'created'; wake: WakeRow }
  | { outcome: 'coalesced'; wake: WakeRow }
  | { outcome: 'duplicate'; wake: WakeRow }
  | { outcome: 'skipped'; code: SkipCode; message: string };

/** The Run record side of a wake, registered by AgentsService (the `jobs.registerExecutor` pattern): this module cannot import it. */
export interface WakeRunHooks {
  /** Create the Queued Run for a new wake (mention, approval): the same Run `dispatchRun` makes for its own wakes. Returns the Run's id. */
  createRun(wake: WakeRow): Promise<string>;
  /** Move the Run along. `note` is appended to its step log. Best-effort: a Run that cannot be updated never undoes a wake transition. */
  setRunStatus(wake: WakeRow, status: 'Queued' | 'Running' | 'Succeeded' | 'Failed' | 'Canceled', note?: string): Promise<void>;
}

const SKIP_MESSAGES: Record<SkipCode, string> = {
  loop_guard: 'This agent was woken by another agent too many times in a row, so it was not woken again.',
  agent_not_found: 'Agent not found.',
  agent_disabled: 'This agent is disabled — enable it first.',
  not_own_ai: 'Only an agent whose AI mode is "Your own AI" is woken through the queue.',
  owner_inactive: "This agent's owner is no longer an active member of this workspace.",
  requester_not_member: 'Not a member of this workspace.',
  agent_not_visible: 'Agent not found.',
  record_not_found: 'Record not found in this workspace.',
  personal_content: 'Personal content never wakes an agent.',
  record_not_visible: 'Record not found in this workspace.',
  owner_cannot_read: "This agent's owner cannot read that record, so the agent cannot act on it.",
};

function skip(code: SkipCode): EnqueueResult {
  return { outcome: 'skipped', code, message: SKIP_MESSAGES[code] };
}

/** What the claim hands the Runner for one wake: ids, a reason and counts. NEVER record text (ADR-0021 §7). */
export interface ClaimedWake {
  id: string;
  nonce: string;
  lease_expires_at: Date;
  lease_seconds: number;
  heartbeat_seconds: number;
  reason: string;
  reasons: WakeReasonEntry[];
  depth: number;
  run_id: string | null;
  agent: { id: string; name: string; goal: string | null; instructions: string | null; skills: string | null; target_databases: string | null };
  record: { id: string; database_id: string; number: number | null } | null;
  context: unknown;
  /**
   * ticket #1132 / ADR-0021 §4 — the per-run credential, minted by the server at claim and shown ONCE here (only its hash is stored).
   * It acts as the agent (never above `write`), expires with the lease and is revoked at completion, lease loss, cancel and Runner removal.
   * The Runner never chooses it, never keeps it past the run and never sends it to a `/runner/v1/*` route (those refuse it).
   */
  credential: { token: string; scope: TokenScope; expires_at: Date };
}

/** Plain text of a rich_text value (BlockNote block array) without importing the schemas package's markdown converter into this module. */
function plainText(value: unknown): string | null {
  const out: string[] = [];
  const walk = (node: unknown): void => {
    if (node == null) return;
    if (typeof node === 'string') return void out.push(node);
    if (Array.isArray(node)) return node.forEach(walk);
    if (typeof node === 'object') {
      const o = node as Record<string, unknown>;
      if (typeof o.text === 'string') out.push(o.text);
      if (o.content) walk(o.content);
      if (o.children) walk(o.children);
      if (Array.isArray(o.content) || Array.isArray(o.children)) out.push('\n');
    }
  };
  walk(value);
  const text = out.join('').replace(/\n{3,}/g, '\n\n').trim();
  return text || null;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Returns a Runner's claimed wakes to the queue. Called INSIDE `RunnersService.revoke`'s transaction (ADR-0021 §3: removing a
 * Runner returns its claimed wakes), so a Runner is never revoked while its wakes still say they are being worked on. The attempt
 * counter is NOT bumped: losing a wake because a person removed the machine is not the wake's failure.
 */
export async function returnClaimedWakesTx(tx: Pick<Db, 'update'>, runnerId: string): Promise<WakeRow[]> {
  const rows = await tx
    .update(agentWakes)
    .set({ status: 'queued', runnerId: null, claimNonce: null, leaseExpiresAt: null, claimedAt: null, updatedAt: new Date() })
    .where(and(eq(agentWakes.runnerId, runnerId), eq(agentWakes.status, 'claimed')))
    .returning();
  return rows;
}

@Injectable()
export class AgentWakesService {
  private readonly logger = new Logger(AgentWakesService.name);
  private hooks: WakeRunHooks | null = null;

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly access: AccessService,
    private readonly notifications: NotificationsService,
    private readonly runCredentials: RunCredentialsService,
  ) {}

  registerRunHooks(hooks: WakeRunHooks): void {
    this.hooks = hooks;
  }

  // ---------------------------------------------------------------- the agent, read straight off its record

  /** The Agents database and the three field ids this module reads off an agent record. Null when the workspace has no Agents database. */
  private async agentsDbInfo(workspaceId: string) {
    const db = await this.db.query.databases.findFirst({
      where: and(eq(databases.workspaceId, workspaceId), eq(databases.isSystem, true), eq(databases.systemKey, 'agents'), isNull(databases.deletedAt)),
      columns: { id: true, spaceId: true },
    });
    if (!db) return null;
    const fieldRows = await this.db.query.fields.findMany({
      where: and(eq(fields.databaseId, db.id), inArray(fields.apiName, ['enabled', 'ai_mode', 'goal', 'instructions', 'skills', 'target_databases'])),
      columns: { id: true, apiName: true },
    });
    const byName = new Map(fieldRows.map((f) => [f.apiName, f.id]));
    const aiModeFieldId = byName.get('ai_mode');
    const ownAiOption = aiModeFieldId
      ? await this.db.query.selectOptions.findFirst({ where: and(eq(selectOptions.fieldId, aiModeFieldId), eq(selectOptions.label, 'Your own AI')), columns: { id: true } })
      : null;
    return { id: db.id, spaceId: db.spaceId, fieldIds: byName, ownAiOptionId: ownAiOption?.id ?? null };
  }

  private agentFacts(info: NonNullable<Awaited<ReturnType<AgentWakesService['agentsDbInfo']>>>, values: Record<string, unknown>) {
    const enabledId = info.fieldIds.get('enabled');
    const aiModeId = info.fieldIds.get('ai_mode');
    return {
      enabled: enabledId ? values[enabledId] === true : false,
      ownAi: Boolean(aiModeId && info.ownAiOptionId && values[aiModeId] === info.ownAiOptionId),
    };
  }

  private async activeMembership(workspaceId: string, userId: string) {
    return this.db.query.memberships.findFirst({
      where: and(eq(memberships.workspaceId, workspaceId), eq(memberships.userId, userId), eq(memberships.status, 'active')),
    });
  }

  // ---------------------------------------------------------------- enqueue (the ONE entry every wake source calls)

  /**
   * Creates a wake, or merges the event into the open wake for the same agent and record (ADR-0021 §1).
   *
   * Every source goes through here so the access rule cannot be forgotten at one of them: a wake is created ONLY if the person
   * whose action caused it can read the record AND the agent, and the agent's OWNER (whom it acts as) can read the record too.
   * Nothing is created otherwise, and the caller is told only a code (the 404-style answer for a record or agent it cannot see).
   * Personal content never wakes anything: this is the emit-time suppression CLAUDE.md requires, not a read-time filter.
   */
  async enqueue(input: EnqueueInput, now = new Date()): Promise<EnqueueResult> {
    const depth = input.depth ?? 0;
    if (depth > WAKE_MAX_DEPTH) return skip('loop_guard');

    const info = await this.agentsDbInfo(input.workspaceId);
    const agent = info
      ? await this.db.query.records.findFirst({
          where: and(eq(records.id, input.agentId), eq(records.databaseId, info.id), isNull(records.deletedAt)),
          columns: { id: true, title: true, values: true, createdBy: true },
        })
      : null;
    if (!info || !agent) return skip('agent_not_found');
    const facts = this.agentFacts(info, agent.values as Record<string, unknown>);
    if (!facts.enabled) return skip('agent_disabled');
    if (!facts.ownAi) return skip('not_own_ai');

    const owner = agent.createdBy ? await this.activeMembership(input.workspaceId, agent.createdBy) : null;
    if (!owner) return skip('owner_inactive');

    const requester = input.requestedBy ? await this.activeMembership(input.workspaceId, input.requestedBy) : null;
    if (input.requestedBy && !requester) return skip('requester_not_member');

    const asRecord = (r: { id: string; databaseId: string; spaceId: string }) => r;
    // The author must be able to see the AGENT. A guest holding a grant on the record but none on the Agents database cannot.
    if (requester && (await this.access.effectiveForRecord(requester, asRecord({ id: agent.id, databaseId: info.id, spaceId: info.spaceId }))) === null) {
      return skip('agent_not_visible');
    }

    let databaseId: string | null = null;
    if (input.recordId) {
      const [rec] = await this.db
        .select({ id: records.id, databaseId: records.databaseId, spaceId: databases.spaceId, personal: spaces.personal })
        .from(records)
        .innerJoin(databases, eq(databases.id, records.databaseId))
        .innerJoin(spaces, eq(spaces.id, databases.spaceId))
        .where(and(eq(records.id, input.recordId), eq(databases.workspaceId, input.workspaceId), isNull(records.deletedAt), isNull(databases.deletedAt)))
        .limit(1);
      if (!rec) return skip('record_not_found');
      if (rec.personal) return skip('personal_content');
      if (requester && (await this.access.effectiveForRecord(requester, rec)) === null) return skip('record_not_visible');
      if ((await this.access.effectiveForRecord(owner, rec)) === null) return skip('owner_cannot_read');
      databaseId = rec.databaseId;
    }

    const recordId = input.recordId ?? null;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (input.sourceKey) {
        const dup = await this.db.query.agentWakes.findFirst({ where: eq(agentWakes.sourceKey, input.sourceKey) });
        if (dup) return { outcome: 'duplicate', wake: dup };
      }
      const first: WakeReasonEntry[] = [{ reason: input.reason, count: 1, last_at: now.toISOString(), ...(input.detail ? { detail: input.detail } : {}) }];
      const inserted = await this.db
        .insert(agentWakes)
        .values({
          workspaceId: input.workspaceId,
          agentId: input.agentId,
          recordId,
          databaseId,
          reason: input.reason,
          requestedBy: input.requestedBy,
          sourceKey: input.sourceKey ?? null,
          depth,
          reasons: first,
          context: input.context ?? null,
          expiresAt: new Date(now.getTime() + WAKE_QUEUE_TTL_MS),
        })
        .onConflictDoNothing()
        .returning();
      if (inserted[0]) {
        const wake = inserted[0];
        if (input.materialize && this.hooks) {
          try {
            const runId = await this.hooks.createRun(wake);
            await this.attachRun(wake.id, runId);
            wake.runId = runId;
          } catch (error) {
            // A wake with no Run is a queue entry nothing can show: take it back rather than leave it.
            await this.db.update(agentWakes).set({ status: 'canceled', finishedAt: new Date() }).where(eq(agentWakes.id, wake.id));
            throw error;
          }
        }
        return { outcome: 'created', wake };
      }
      const merged = await this.mergeIntoOpen(input, recordId, depth, now);
      if (merged) return { outcome: 'coalesced', wake: merged };
      // The open wake finished between the conflict and the merge: the next insert succeeds.
    }
    return skip('loop_guard');
  }

  /** Folds a repeat into the open wake for the same agent and record, under a row lock so two repeats never lose each other's count. */
  private async mergeIntoOpen(input: EnqueueInput, recordId: string | null, depth: number, now: Date): Promise<WakeRow | null> {
    return this.db.transaction(async (tx) => {
      const [open] = await tx
        .select()
        .from(agentWakes)
        .where(
          and(
            eq(agentWakes.agentId, input.agentId),
            recordId ? eq(agentWakes.recordId, recordId) : isNull(agentWakes.recordId),
            inArray(agentWakes.status, ['queued', 'claimed']),
          ),
        )
        .for('update');
      if (!open) return null;
      const reasons = [...((open.reasons as WakeReasonEntry[]) ?? [])];
      const mine = reasons.find((r) => r.reason === input.reason);
      if (mine) {
        mine.count += 1;
        mine.last_at = now.toISOString();
        if (input.detail) mine.detail = input.detail;
      } else {
        reasons.push({ reason: input.reason, count: 1, last_at: now.toISOString(), ...(input.detail ? { detail: input.detail } : {}) });
      }
      const claimed = open.status === 'claimed';
      const [updated] = await tx
        .update(agentWakes)
        .set({
          reasons,
          coalescedCount: sql`${agentWakes.coalescedCount} + 1`,
          context: input.context ? { ...((open.context as Record<string, unknown> | null) ?? {}), ...input.context } : open.context,
          // A repeat that lands while the wake is being worked on is never lost and never runs concurrently: one fresh wake follows.
          ...(claimed ? { rewake: true, rewakeRequestedBy: input.requestedBy, rewakeDepth: depth, rewakeReason: input.reason } : {}),
          updatedAt: now,
        })
        .where(eq(agentWakes.id, open.id))
        .returning();
      return updated ?? null;
    });
  }

  /** After a Runner's removal committed: the Runs of the wakes it held read Queued again, and their credentials (#1132) are revoked. */
  async afterReturned(rows: WakeRow[]): Promise<void> {
    for (const wake of rows) {
      await this.revokeRunCredential(wake);
      await this.hooks?.setRunStatus(wake, 'Queued', 'The Runner was removed; this was returned to the queue.').catch(() => undefined);
    }
  }

  async attachRun(wakeId: string, runId: string): Promise<void> {
    await this.db.update(agentWakes).set({ runId, updatedAt: new Date() }).where(eq(agentWakes.id, wakeId));
  }

  /** `dispatchRun` could not finish the Run it started for a wake: the wake must not stay queued for a Run that failed. */
  async failUnstarted(wakeId: string): Promise<void> {
    await this.db
      .update(agentWakes)
      .set({ status: 'failed', finishedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(agentWakes.id, wakeId), eq(agentWakes.status, 'queued')));
  }

  async get(wakeId: string): Promise<WakeRow | null> {
    return (await this.db.query.agentWakes.findFirst({ where: eq(agentWakes.id, wakeId) })) ?? null;
  }

  /** An admin cancelled a Queued/Running Run (the kill-switch): its open wake goes with it, so a Runner can never claim a cancelled Run. */
  async cancelForRun(workspaceId: string, runId: string): Promise<number> {
    const rows = await this.db
      .update(agentWakes)
      .set({ status: 'canceled', finishedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(agentWakes.workspaceId, workspaceId), eq(agentWakes.runId, runId), inArray(agentWakes.status, ['queued', 'claimed'])))
      .returning();
    for (const wake of rows) await this.revokeRunCredential(wake);
    return rows.length;
  }

  /**
   * ticket #1132 (the per-run credential): minted at claim, revoked the moment the lease ends, the wake completes or is cancelled, or
   * its Runner is removed (that one in `RunnersService.revoke`'s transaction); a disabled agent's is refused by the guard live
   * (ADR-0021 §2: "the fence is the credential, not the nonce"). Awaited at every call site, so the revocation has happened before the
   * response that caused it.
   */
  protected async revokeRunCredential(wake: Pick<WakeRow, 'id' | 'runId'>): Promise<void> {
    await this.runCredentials.revokeForWake(wake.id);
  }

  // ---------------------------------------------------------------- claim (the Runner)

  /**
   * One atomic claim, held open up to `waitSeconds` (the long poll). Two concurrent claims never receive the same wake: it is ONE
   * `UPDATE ... WHERE id IN (SELECT ... FOR UPDATE SKIP LOCKED) RETURNING`, the shape automations/job-runner.service.ts uses, over
   * this table. A claim only ever returns wakes for agents assigned to THIS Runner; for anyone else's it answers the same empty.
   */
  async claim(runner: RunnerRow, opts: { max?: number; waitSeconds?: number; wakeId?: string }): Promise<ClaimedWake[]> {
    const max = Math.max(1, Math.min(opts.max ?? 1, WAKE_CLAIM_MAX));
    const wait = Math.max(0, Math.min(opts.waitSeconds ?? WAKE_LONG_POLL_MAX_SECONDS, WAKE_LONG_POLL_MAX_SECONDS));
    if (runner.status !== 'active') {
      throw codedException(409, 'runner_not_active', 'This Runner is not turned on yet. Press Done in StoryOS to let it run your agents.');
    }
    const deadline = Date.now() + wait * 1000;
    for (;;) {
      const claimed = await this.claimOnce(runner, max, opts.wakeId, new Date());
      if (claimed.length > 0) return claimed;
      if (opts.wakeId) {
        // A specific wake asked for and not given: say WHY, but only for a wake of this Runner's own agents.
        const row = await this.ownWake(runner, opts.wakeId);
        if (row?.status === 'claimed') {
          throw codedException(409, 'wake_already_claimed', 'That wake is already claimed (by this Runner or another claim). Nothing to do.', { wake_id: row.id });
        }
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) return [];
      await sleep(Math.min(WAKE_LONG_POLL_TICK_MS, remaining));
    }
  }

  private async ownWake(runner: RunnerRow, wakeId: string): Promise<WakeRow | null> {
    if (!/^[0-9a-f-]{36}$/i.test(wakeId)) return null;
    const [row] = await this.db
      .select({ w: agentWakes })
      .from(agentWakes)
      .innerJoin(runnerAgents, and(eq(runnerAgents.agentId, agentWakes.agentId), eq(runnerAgents.runnerId, runner.id)))
      .where(and(eq(agentWakes.id, wakeId), eq(agentWakes.workspaceId, runner.workspaceId)))
      .limit(1);
    return row?.w ?? null;
  }

  private async claimOnce(runner: RunnerRow, max: number, wakeId: string | undefined, now: Date): Promise<ClaimedWake[]> {
    // A paused Runner (its tool hit a subscription limit) and one whose chosen tool is gone claim nothing: the wakes wait.
    if (runner.pausedUntil && runner.pausedUntil.getTime() > now.getTime()) return [];
    if (runner.chosenTool && !runner.tools.some((t) => t.id === runner.chosenTool && t.installed)) return [];
    const info = await this.agentsDbInfo(runner.workspaceId);
    const enabledId = info?.fieldIds.get('enabled');
    if (!info || !enabledId) return [];
    if (wakeId && !/^[0-9a-f-]{36}$/i.test(wakeId)) return [];
    const lease = new Date(now.getTime() + WAKE_LEASE_SECONDS * 1000);
    const only = wakeId ? sql`AND w.id = ${wakeId}::uuid` : sql``;
    const res = (await this.db.execute(sql`
      UPDATE agent_wakes SET status = 'claimed', runner_id = ${runner.id}::uuid, claim_nonce = gen_random_uuid()::text,
        lease_expires_at = ${lease.toISOString()}::timestamptz, claimed_at = ${now.toISOString()}::timestamptz, updated_at = ${now.toISOString()}::timestamptz
      WHERE status = 'queued' AND id IN (
        SELECT w.id FROM agent_wakes w
          JOIN runner_agents ra ON ra.agent_id = w.agent_id AND ra.runner_id = ${runner.id}::uuid
          JOIN records a ON a.id = w.agent_id AND a.deleted_at IS NULL AND (a.values ->> ${enabledId}) = 'true'
          JOIN memberships m ON m.workspace_id = w.workspace_id AND m.user_id = a.created_by AND m.status = 'active' AND m.role <> 'guest'
        WHERE w.workspace_id = ${runner.workspaceId}::uuid AND w.status = 'queued' AND w.not_before <= ${now.toISOString()}::timestamptz ${only}
        ORDER BY w.created_at, w.id
        LIMIT ${max}
        FOR UPDATE OF w SKIP LOCKED
      ) RETURNING id`)) as unknown as { rows?: Array<{ id: string }> };
    const ids = (res.rows ?? []).map((r) => r.id);
    if (ids.length === 0) return [];
    const rows = await this.db.select().from(agentWakes).where(inArray(agentWakes.id, ids)).orderBy(asc(agentWakes.createdAt));
    const out: ClaimedWake[] = [];
    for (const wake of rows) {
      // ticket #1132: the server mints this run's credential at the moment of the claim, bound to (agent, run, Runner, depth) and to
      // the lease. When none may exist (the agent or its owner went away between the eligibility check and here) the wake goes
      // back to the queue instead of being handed over without the only thing a session can act with.
      const credential = await this.runCredentials.mint({
        workspaceId: wake.workspaceId,
        agentId: wake.agentId,
        wakeId: wake.id,
        runId: wake.runId,
        runnerId: runner.id,
        depth: wake.depth,
        expiresAt: wake.leaseExpiresAt!,
      });
      if (!credential) {
        await this.db
          .update(agentWakes)
          .set({ status: 'queued', runnerId: null, claimNonce: null, leaseExpiresAt: null, claimedAt: null, updatedAt: new Date() })
          .where(and(eq(agentWakes.id, wake.id), eq(agentWakes.status, 'claimed'), eq(agentWakes.runnerId, runner.id)));
        continue;
      }
      await this.hooks?.setRunStatus(wake, 'Running').catch((e) => this.logger.warn(`could not mark Run running for wake ${wake.id}: ${String(e)}`));
      out.push(await this.present(wake, info, { token: credential.token, scope: credential.scope, expires_at: credential.expires_at }));
    }
    return out;
  }

  private async present(
    wake: WakeRow,
    info: NonNullable<Awaited<ReturnType<AgentWakesService['agentsDbInfo']>>>,
    credential: ClaimedWake['credential'],
  ): Promise<ClaimedWake> {
    const agent = await this.db.query.records.findFirst({ where: eq(records.id, wake.agentId), columns: { title: true, values: true } });
    const values = (agent?.values ?? {}) as Record<string, unknown>;
    const text = (apiName: string) => {
      const id = info.fieldIds.get(apiName);
      return id ? values[id] : undefined;
    };
    const rec = wake.recordId ? await this.db.query.records.findFirst({ where: eq(records.id, wake.recordId), columns: { id: true, databaseId: true, number: true } }) : null;
    return {
      id: wake.id,
      nonce: wake.claimNonce!,
      lease_expires_at: wake.leaseExpiresAt!,
      lease_seconds: WAKE_LEASE_SECONDS,
      heartbeat_seconds: 30,
      reason: wake.reason,
      reasons: wake.reasons as WakeReasonEntry[],
      depth: wake.depth,
      run_id: wake.runId,
      agent: {
        id: wake.agentId,
        name: agent?.title ?? '',
        goal: plainText(text('goal')),
        instructions: plainText(text('instructions')),
        skills: typeof text('skills') === 'string' ? (text('skills') as string) : null,
        target_databases: typeof text('target_databases') === 'string' ? (text('target_databases') as string) : null,
      },
      record: rec ? { id: rec.id, database_id: rec.databaseId, number: rec.number } : null,
      context: wake.context,
      credential,
    };
  }

  // ---------------------------------------------------------------- lease heartbeat and completion (the Runner)

  /**
   * Renews a lease and doubles as the Runner's liveness signal. A stale nonce, a wake that is no longer claimed (the lease lapsed,
   * an admin cancelled the Run, the Runner was removed) or one that is not this Runner's is `409 lease_lost`: the Runner must kill
   * the session and discard its result. The 30-minute ceiling is measured from the claim, so a session that heartbeats forever ends.
   */
  async heartbeat(runner: RunnerRow, wakeId: string, nonce: string, now = new Date()) {
    await this.markSeen(runner.id, now);
    const wake = await this.ownClaim(runner, wakeId, nonce);
    if (!wake) throw this.leaseLost(wakeId);
    if (wake.claimedAt && now.getTime() - wake.claimedAt.getTime() >= WAKE_RUN_CEILING_MS) {
      throw codedException(409, 'run_ceiling', 'This run reached the 30-minute ceiling and its lease will not be renewed. Stop the session.', { wake_id: wake.id });
    }
    const lease = new Date(now.getTime() + WAKE_LEASE_SECONDS * 1000);
    const [row] = await this.db
      .update(agentWakes)
      .set({ leaseExpiresAt: lease, updatedAt: now })
      .where(and(eq(agentWakes.id, wake.id), eq(agentWakes.runnerId, runner.id), eq(agentWakes.claimNonce, nonce), eq(agentWakes.status, 'claimed')))
      .returning();
    if (!row) throw this.leaseLost(wakeId);
    await this.runCredentials.extendForWake(row.id, lease); // the credential's expiry slides with the lease (ADR-0021 §4)
    return { wake_id: row.id, lease_expires_at: lease, lease_seconds: WAKE_LEASE_SECONDS };
  }

  private leaseLost(wakeId: string) {
    return codedException(409, 'lease_lost', 'This Runner no longer holds that wake (the lease lapsed, the run was cancelled or the wake was taken back). Stop the session and discard its result.', {
      wake_id: wakeId,
    });
  }

  private async ownClaim(runner: RunnerRow, wakeId: string, nonce: string): Promise<WakeRow | null> {
    if (!/^[0-9a-f-]{36}$/i.test(wakeId)) return null;
    const row = await this.db.query.agentWakes.findFirst({ where: and(eq(agentWakes.id, wakeId), eq(agentWakes.runnerId, runner.id), eq(agentWakes.claimNonce, nonce), eq(agentWakes.status, 'claimed')) });
    return row ?? null;
  }

  /** A claim or heartbeat is hearing from the Runner: the liveness write, throttled the way `RunnersService.heartbeat` is. */
  private async markSeen(runnerId: string, now: Date): Promise<void> {
    await this.db
      .update(runners)
      .set({ lastSeenAt: now, offlineNotifiedAt: null })
      .where(and(eq(runners.id, runnerId), eq(runners.status, 'active'), sql`(${runners.lastSeenAt} IS NULL OR ${runners.lastSeenAt} < ${new Date(now.getTime() - 30_000).toISOString()}::timestamptz OR ${runners.offlineNotifiedAt} IS NOT NULL)`));
  }

  /** Liveness for a claim poll (called by the controller for every claim, including one that returns nothing). */
  async touch(runner: RunnerRow, now = new Date()): Promise<void> {
    await this.markSeen(runner.id, now);
  }

  /**
   * Completion. Idempotent on (id, nonce): a retry after a dropped response gets the same answer. It writes the Run, revokes the
   * credential, ends the wake and, if a repeat arrived mid-run, enqueues the one fresh wake that carries it.
   */
  async complete(runner: RunnerRow, wakeId: string, input: WakeCompleteInput, now = new Date()) {
    if (!/^[0-9a-f-]{36}$/i.test(wakeId)) throw this.leaseLost(wakeId);
    const existing = await this.db.query.agentWakes.findFirst({ where: and(eq(agentWakes.id, wakeId), eq(agentWakes.runnerId, runner.id), eq(agentWakes.claimNonce, input.nonce)) });
    if (existing && existing.status !== 'claimed') return { wake_id: existing.id, status: existing.status as WakeStatus, requeued: false, repeated: true };
    if (!existing) throw this.leaseLost(wakeId);

    const limit = input.exit === 'limit_reached';
    const until = limit ? (input.limit_reached_until ? new Date(input.limit_reached_until) : new Date(now.getTime() + 3_600_000)) : null;
    const terminal: WakeStatus = input.exit === 'ok' ? 'done' : input.exit === 'aborted' ? 'canceled' : 'failed';
    const summary = (input.summary ?? '').slice(0, 2_000);
    const note =
      input.exit === 'ok'
        ? `Runner finished.${summary ? ` ${summary}` : ''}`
        : limit
          ? `The tool reached its limit${until ? `; this will be retried after ${until.toISOString()}` : ''}.`
          : `Runner ended with "${input.exit}".${input.error ? ` ${input.error.slice(0, 500)}` : ''}${summary ? ` ${summary}` : ''}`;

    const flipped = await this.db.transaction(async (tx) => {
      const [row] = await tx
        .update(agentWakes)
        .set(
          limit
            ? { status: 'queued', runnerId: null, claimNonce: null, leaseExpiresAt: null, claimedAt: null, notBefore: until!, updatedAt: now }
            : { status: terminal, finishedAt: now, leaseExpiresAt: null, updatedAt: now },
        )
        .where(and(eq(agentWakes.id, wakeId), eq(agentWakes.runnerId, runner.id), eq(agentWakes.claimNonce, input.nonce), eq(agentWakes.status, 'claimed')))
        .returning();
      if (row && limit) {
        // The ONE source of "waiting for limit" (ADR-0021 §11): the Runner is paused until then, so no claim is handed out meanwhile.
        await tx.update(runners).set({ pausedUntil: until, pauseReason: 'limit_reached' }).where(eq(runners.id, runner.id));
      }
      return row ?? null;
    });
    if (!flipped) {
      const again = await this.db.query.agentWakes.findFirst({ where: and(eq(agentWakes.id, wakeId), eq(agentWakes.runnerId, runner.id), eq(agentWakes.claimNonce, input.nonce)) });
      if (again && again.status !== 'claimed') return { wake_id: again.id, status: again.status as WakeStatus, requeued: false, repeated: true };
      throw this.leaseLost(wakeId);
    }

    await this.revokeRunCredential(flipped);
    if (limit) {
      await this.hooks?.setRunStatus(flipped, 'Queued', note).catch((e) => this.logger.warn(`Run update failed for wake ${wakeId}: ${String(e)}`));
      return { wake_id: flipped.id, status: 'queued' as WakeStatus, requeued: true, repeated: false, not_before: until };
    }
    await this.hooks
      ?.setRunStatus(flipped, terminal === 'done' ? 'Succeeded' : terminal === 'canceled' ? 'Canceled' : 'Failed', note)
      .catch((e) => this.logger.warn(`Run update failed for wake ${wakeId}: ${String(e)}`));
    await this.afterTerminal(flipped);
    return { wake_id: flipped.id, status: terminal, requeued: false, repeated: false };
  }

  /** A repeat arrived while the wake ran: enqueue the ONE fresh wake that carries it (the full access check runs again). */
  private async afterTerminal(wake: WakeRow): Promise<void> {
    if (!wake.rewake) return;
    try {
      await this.enqueue({
        workspaceId: wake.workspaceId,
        agentId: wake.agentId,
        reason: (wake.rewakeReason as WakeReason | null) ?? 'retry',
        recordId: wake.recordId,
        requestedBy: wake.rewakeRequestedBy,
        depth: wake.rewakeDepth ?? wake.depth,
        materialize: true,
      });
    } catch (error) {
      this.logger.warn(`rewake after wake ${wake.id} failed: ${String(error)}`);
    }
  }

  // ---------------------------------------------------------------- the sweeper's work

  /**
   * Returns every expired lease to the queue (attempts + 1) and fails a wake that has lost its lease WAKE_MAX_ATTEMPTS times: its
   * Run says the Runner stopped answering and the agent's owner is told once. The UPDATE is the de-duplication: whoever's statement
   * returns the row does the follow-up, so two sweeps or two replicas cannot both.
   */
  async reapExpiredLeases(now = new Date()): Promise<{ returned: number; failed: number }> {
    const rows = await this.db
      .update(agentWakes)
      .set({
        attempts: sql`${agentWakes.attempts} + 1`,
        status: sql`CASE WHEN ${agentWakes.attempts} + 1 >= ${WAKE_MAX_ATTEMPTS} THEN 'failed' ELSE 'queued' END`,
        finishedAt: sql`CASE WHEN ${agentWakes.attempts} + 1 >= ${WAKE_MAX_ATTEMPTS} THEN ${now.toISOString()}::timestamptz ELSE NULL END`,
        runnerId: null,
        claimNonce: null,
        leaseExpiresAt: null,
        claimedAt: null,
        updatedAt: now,
      })
      .where(and(eq(agentWakes.status, 'claimed'), lt(agentWakes.leaseExpiresAt, now)))
      .returning();
    let failed = 0;
    for (const wake of rows) {
      // The credential dies with the lease (ADR-0021 §2): a stale Runner's next tool call must be a 401.
      await this.revokeRunCredential(wake);
      if (wake.status === 'failed') {
        failed++;
        await this.hooks
          ?.setRunStatus(wake, 'Failed', `The Runner stopped answering: ${WAKE_MAX_ATTEMPTS} attempts lost their lease.`)
          .catch((e) => this.logger.warn(`Run update failed for wake ${wake.id}: ${String(e)}`));
        await this.notifyFailed(wake);
        await this.afterTerminal(wake);
      } else {
        await this.hooks?.setRunStatus(wake, 'Queued', 'The Runner stopped answering; this was returned to the queue.').catch(() => undefined);
      }
    }
    return { returned: rows.length - failed, failed };
  }

  private async notifyFailed(wake: WakeRow): Promise<void> {
    try {
      const owner = (await this.db.query.records.findFirst({ where: eq(records.id, wake.agentId), columns: { createdBy: true, title: true } })) ?? null;
      if (!owner?.createdBy) return;
      await this.notifications.notify({
        workspaceId: wake.workspaceId,
        databaseId: wake.databaseId ?? undefined,
        recordId: wake.recordId ?? undefined,
        actorId: owner.createdBy,
        type: 'agent_wake_failed',
        recipients: [owner.createdBy],
        allowSelf: true,
        snippet: `${owner.title} could not finish a job: its Runner stopped answering ${WAKE_MAX_ATTEMPTS} times.`,
      });
    } catch (error) {
      this.logger.warn(`failure notification for wake ${wake.id} failed: ${String(error)}`);
    }
  }

  /** A wake nobody could serve for 7 days is cancelled with a reason on its Run, so a forgotten agent does not hoard a queue. */
  async expireQueued(now = new Date()): Promise<number> {
    const rows = await this.db
      .update(agentWakes)
      .set({ status: 'canceled', finishedAt: now, updatedAt: now })
      .where(and(eq(agentWakes.status, 'queued'), lt(agentWakes.expiresAt, now)))
      .returning();
    for (const wake of rows) {
      await this.hooks?.setRunStatus(wake, 'Canceled', 'Nothing picked this up within 7 days (no Runner was available for this agent), so it was cancelled.').catch(() => undefined);
    }
    return rows.length;
  }

  async pruneHistory(now = new Date()): Promise<void> {
    await this.db.delete(agentWakes).where(and(inArray(agentWakes.status, ['done', 'failed', 'canceled']), lte(agentWakes.finishedAt, new Date(now.getTime() - WAKE_HISTORY_TTL_MS))));
  }

  // ---------------------------------------------------------------- the app-facing read (ADR-0021 §11 g, h)

  /**
   * Which wakes this viewer may see: the agent must be in a database they can read AND the record (if any) must be readable.
   * Anything else is omitted AND not counted, so a count never reveals what a 404 would hide (ADR-0018 (b)).
   */
  private async visibleFilter(membership: Membership, rows: WakeRow[]): Promise<WakeRow[]> {
    if (rows.length === 0) return rows;
    const info = await this.agentsDbInfo(membership.workspaceId);
    if (!info) return [];
    if ((await this.access.effectiveForDatabase(membership, { id: info.id, spaceId: info.spaceId })) === null) return [];
    const recordIds = [...new Set(rows.map((r) => r.recordId).filter((id): id is string => Boolean(id)))];
    const readable = new Set<string>();
    if (recordIds.length > 0) {
      const recs = await this.db
        .select({ id: records.id, databaseId: records.databaseId, spaceId: databases.spaceId, personal: spaces.personal, ownerUserId: spaces.ownerUserId })
        .from(records)
        .innerJoin(databases, eq(databases.id, records.databaseId))
        .innerJoin(spaces, eq(spaces.id, databases.spaceId))
        .where(and(inArray(records.id, recordIds), eq(databases.workspaceId, membership.workspaceId), isNull(records.deletedAt)));
      const roles = await this.access.effectiveForRecords(membership, recs.filter((r) => !r.personal || r.ownerUserId === membership.userId));
      for (const r of recs) if (roles.get(r.id)) readable.add(r.id);
    }
    return rows.filter((r) => !r.recordId || readable.has(r.recordId));
  }

  private async runStatuses(workspaceId: string, runIds: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (runIds.length === 0) return out;
    const rows = await this.db.select({ id: records.id, values: records.values, databaseId: records.databaseId }).from(records).where(inArray(records.id, runIds));
    const dbIds = [...new Set(rows.map((r) => r.databaseId))];
    for (const dbId of dbIds) {
      const status = await this.db.query.fields.findFirst({ where: and(eq(fields.databaseId, dbId), eq(fields.apiName, 'status')), columns: { id: true } });
      if (!status) continue;
      const options = await this.db.query.selectOptions.findMany({ where: eq(selectOptions.fieldId, status.id), columns: { id: true, label: true } });
      const labels = new Map(options.map((o) => [o.id, o.label]));
      for (const r of rows.filter((x) => x.databaseId === dbId)) {
        const label = labels.get(((r.values as Record<string, unknown>)[status.id] as string) ?? '');
        if (label) out.set(r.id, label);
      }
    }
    return out;
  }

  /** Every enabled Your-own-AI agent's Runner, and the Runner each wake's agent is assigned to. */
  private async assignments(workspaceId: string) {
    const rows = await this.db
      .select({ agentId: runnerAgents.agentId, runner: runners })
      .from(runnerAgents)
      .innerJoin(runners, eq(runners.id, runnerAgents.runnerId))
      .where(eq(runnerAgents.workspaceId, workspaceId));
    return new Map(rows.map((r) => [r.agentId, r.runner]));
  }

  async list(membership: Membership, q: { agent?: string; record?: string; cursor?: string; limit?: number }, now = new Date()) {
    const limit = Math.max(1, Math.min(q.limit ?? 50, 200));
    let after: { t: Date; id: string } | null = null;
    if (q.cursor) {
      try {
        const parsed = JSON.parse(Buffer.from(q.cursor, 'base64url').toString('utf8')) as { t: string; id: string };
        after = { t: new Date(parsed.t), id: parsed.id };
        if (Number.isNaN(after.t.getTime()) || !/^[0-9a-f-]{36}$/i.test(after.id)) after = null;
      } catch {
        after = null;
      }
    }
    const uuid = /^[0-9a-f-]{36}$/i;
    const conds = [eq(agentWakes.workspaceId, membership.workspaceId)];
    if (q.agent) conds.push(uuid.test(q.agent) ? eq(agentWakes.agentId, q.agent) : sql`false`);
    if (q.record) conds.push(uuid.test(q.record) ? eq(agentWakes.recordId, q.record) : sql`false`);
    const visible: WakeRow[] = [];
    let exhausted = false;
    for (let batch = 0; batch < 6 && visible.length < limit + 1 && !exhausted; batch++) {
      const page = await this.db
        .select()
        .from(agentWakes)
        .where(and(...conds, after ? sql`(${agentWakes.createdAt}, ${agentWakes.id}) < (${after.t.toISOString()}::timestamptz, ${after.id}::uuid)` : sql`true`))
        .orderBy(desc(agentWakes.createdAt), desc(agentWakes.id))
        .limit(limit * 2);
      if (page.length < limit * 2) exhausted = true;
      visible.push(...(await this.visibleFilter(membership, page)));
      const last = page[page.length - 1];
      if (last) after = { t: last.createdAt, id: last.id };
    }
    const shown = visible.slice(0, limit);
    const hasMore = visible.length > limit || !exhausted;
    const last = shown[shown.length - 1];
    const next = hasMore && last ? Buffer.from(JSON.stringify({ t: last.createdAt.toISOString(), id: last.id })).toString('base64url') : null;
    return { data: await this.presentRows(membership.workspaceId, shown, now), next_cursor: next };
  }

  private async presentRows(workspaceId: string, rows: WakeRow[], now: Date) {
    const statuses = await this.runStatuses(workspaceId, rows.map((r) => r.runId).filter((id): id is string => Boolean(id)));
    const assigned = await this.assignments(workspaceId);
    const agentIds = [...new Set(rows.map((r) => r.agentId))];
    const agents = agentIds.length ? await this.db.select({ id: records.id, title: records.title }).from(records).where(inArray(records.id, agentIds)) : [];
    const agentName = new Map(agents.map((a) => [a.id, a.title]));
    const recIds = [...new Set(rows.map((r) => r.recordId).filter((id): id is string => Boolean(id)))];
    const recs = recIds.length ? await this.db.select({ id: records.id, title: records.title, number: records.number }).from(records).where(inArray(records.id, recIds)) : [];
    const recById = new Map(recs.map((r) => [r.id, r]));
    const claimedRunners = new Map<string, RunnerRow>();
    const claimedIds = [...new Set(rows.filter((r) => r.runnerId).map((r) => r.runnerId!))];
    if (claimedIds.length) for (const r of await this.db.select().from(runners).where(inArray(runners.id, claimedIds))) claimedRunners.set(r.id, r);
    const busy = await this.db.select({ agentId: agentWakes.agentId, runnerId: agentWakes.runnerId }).from(agentWakes).where(and(eq(agentWakes.workspaceId, workspaceId), eq(agentWakes.status, 'claimed')));
    const busyAgents = new Set(busy.map((b) => b.agentId));
    const busyRunners = new Set(busy.map((b) => b.runnerId).filter((id): id is string => Boolean(id)));
    return rows.map((w) => {
      const runner = (w.runnerId ? claimedRunners.get(w.runnerId) : null) ?? assigned.get(w.agentId) ?? null;
      const state = deriveRunState({
        wakeStatus: w.status as WakeStatus,
        claimedAt: w.claimedAt,
        runStatus: w.runId ? (statuses.get(w.runId) ?? null) : null,
        runner,
        agentBusy: busyAgents.has(w.agentId) || (runner ? busyRunners.has(runner.id) : false),
        now,
      });
      const rec = w.recordId ? recById.get(w.recordId) : undefined;
      return {
        id: w.id,
        agent: { id: w.agentId, name: agentName.get(w.agentId) ?? null },
        record: w.recordId ? { id: w.recordId, database_id: w.databaseId, title: rec?.title ?? null, number: rec?.number ?? null } : null,
        reason: w.reason,
        reasons: w.reasons as WakeReasonEntry[],
        coalesced_count: w.coalescedCount,
        status: w.status,
        run_id: w.runId,
        run_state: state,
        created_at: w.createdAt,
        finished_at: w.finishedAt,
        expires_at: w.expiresAt,
      };
    });
  }

  /** The waiting counts the web and MCP show ("N waiting", the sidebar number). Hidden wakes are not counted. */
  async summary(membership: Membership) {
    const info = await this.agentsDbInfo(membership.workspaceId);
    const empty = { agents: [] as Array<{ agent_id: string; name: string; runner: { id: string; name: string } | null; can_run: boolean; waiting: number }>, waiting_total: 0, agents_that_cannot_run: 0 };
    if (!info || (await this.access.effectiveForDatabase(membership, { id: info.id, spaceId: info.spaceId })) === null) return empty;
    const queued = await this.visibleFilter(
      membership,
      await this.db.select().from(agentWakes).where(and(eq(agentWakes.workspaceId, membership.workspaceId), eq(agentWakes.status, 'queued'))),
    );
    const waiting = new Map<string, number>();
    for (const w of queued) waiting.set(w.agentId, (waiting.get(w.agentId) ?? 0) + 1);
    const agentRows = await this.db.select({ id: records.id, title: records.title, values: records.values }).from(records).where(and(eq(records.databaseId, info.id), isNull(records.deletedAt)));
    const assigned = await this.assignments(membership.workspaceId);
    const out = [];
    let cannot = 0;
    for (const a of agentRows) {
      const facts = this.agentFacts(info, a.values as Record<string, unknown>);
      const w = waiting.get(a.id) ?? 0;
      if (!(facts.enabled && facts.ownAi) && w === 0) continue;
      const runner = assigned.get(a.id) ?? null;
      const canRun = facts.enabled && facts.ownAi && runner?.status === 'active';
      if (facts.enabled && facts.ownAi && !canRun) cannot++;
      out.push({ agent_id: a.id, name: a.title, runner: runner ? { id: runner.id, name: runner.name } : null, can_run: canRun, waiting: w });
    }
    return { agents: out, waiting_total: queued.length, agents_that_cannot_run: cannot };
  }

  /** Test/diagnostic: the run_state a Runner's connection implies, without a wake. */
  describeConnection(runner: RunnerRow, now = new Date()) {
    return { connection: runnerConnection(runner, now), offline_since: offlineSince(runner, now) };
  }
}

export type { RunState };
