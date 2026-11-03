import { ForbiddenException, Injectable, Logger, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { Inject } from '@nestjs/common';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { DB } from '../db/db.module';
import type { Db } from '../db/client';
import { databases, records, spaces } from '../db/schema';
import { AccessService } from '../access/access.service';
import { RecordsService } from '../records/records.service';
import { resolveAgentIdentity } from '../agents/agent-identity';
import type { Membership } from '../workspaces/workspace-access.guard';
import { AgentWakesService } from './agent-wakes.service';

/** At most this many wakes are queued by ONE click. The rest are reported as `remaining`, never dropped (ticket #1152). */
export const CATCH_UP_MAX_PER_CLICK = 25;
/** The same ceiling the live trigger subscriber reads bindings with (trigger.subscriber.ts MAX_BINDINGS). */
const MAX_BINDINGS = 200;

interface DbPlan {
  databaseId: string;
  /** One filter per armed binding of this agent on this database; a record matching any of them is waiting. */
  filters: unknown[];
}

/**
 * ticket #1152 / ADR-0021 Q15 — the one-click catch-up for records that were ALREADY in an agent's trigger state before a wake
 * could be made for them (the trigger or the agent did not exist yet, so no event ever fired). Wakes come from events; this makes
 * the missing ones through the SAME single entry (`AgentWakesService.enqueue`), so the access rule ("no wake for a record or an agent
 * the person cannot see, nor the agent's owner") and the one-open-wake-per-record coalescing apply unchanged.
 *
 * WAITING, per binding kind (the Agent Triggers database, read like trigger.subscriber.ts reads it):
 *  - state binding (database, state_field, state_option): records of that database whose state field CURRENTLY equals the option;
 *  - relation binding (database, relation_field): records of that database CURRENTLY linked to this agent through that field;
 *  - a disabled binding, and a `human_gate` binding (which never starts a run by itself), contribute nothing.
 *
 * ALREADY HANDLED = the agent has a wake for the record in status queued or claimed (it is coming) or done (it ran). A failed,
 * canceled or expired wake is NOT handled: the record was never served, so it is offered again. Known limit: done wakes are pruned
 * after WAKE_HISTORY_TTL_MS, so a record completed longer ago than that and still in the state is offered again.
 *
 * COUNTING IS NOT FETCHING (CLAUDE.md, #404): the number is one SQL `count(*)` over the filter and visibility `aggregate` uses
 * (`RecordsService.aggregateWhere`), evaluated AS THE AGENT'S OWNER, because the agent reads as its owner: a record its owner cannot
 * see is neither counted nor woken. Only the owner or an admin is told the number.
 */
@Injectable()
export class AgentCatchUpService {
  private readonly logger = new Logger(AgentCatchUpService.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly access: AccessService,
    private readonly records: RecordsService,
    private readonly wakes: AgentWakesService,
  ) {}

  /**
   * Hook for the agent's budget and limits (tickets #1137/#1138, not built yet): how many wakes this agent may still be given right
   * now. `null` = no limit, which is every agent today. When those tickets land, return the remaining allowance here and the click
   * queues at most that many, with the rest reported as `remaining` exactly like the per-click cap.
   */
  protected catchUpAllowance(_workspaceId: string, _agentId: string): number | null {
    return null;
  }

  /** The agent's armed bindings, as one record filter per binding, grouped by database. */
  private async plans(workspaceId: string, agentId: string): Promise<DbPlan[]> {
    const triggersDb = await this.db.query.databases.findFirst({
      where: and(eq(databases.workspaceId, workspaceId), eq(databases.isSystem, true), eq(databases.systemKey, 'agent_triggers'), isNull(databases.deletedAt)),
      columns: { id: true },
    });
    if (!triggersDb) return [];
    const bindings = await this.records.list(triggersDb.id, { limit: MAX_BINDINGS });
    const byDb = new Map<string, unknown[]>();
    const defsByDb = new Map<string, Awaited<ReturnType<RecordsService['fieldDefs']>>>();
    for (const b of bindings.data) {
      if (b.values['enabled'] !== true || b.values['human_gate'] === true) continue;
      const ref = (b.values['agent'] as Array<{ id: string }> | undefined)?.[0];
      const databaseId = b.values['database'];
      if (ref?.id !== agentId || typeof databaseId !== 'string') continue;
      let defs = defsByDb.get(databaseId);
      if (!defs) {
        defs = await this.records.fieldDefs(databaseId).catch(() => []);
        defsByDb.set(databaseId, defs);
      }
      const stateFieldId = b.values['state_field'];
      const stateOptionId = b.values['state_option'];
      const relationFieldId = b.values['relation_field'];
      let filter: unknown = null;
      if (typeof stateFieldId === 'string' && typeof stateOptionId === 'string') {
        // Schema drifts: a deleted or retyped field disarms the binding (as in the live subscriber) instead of throwing.
        const def = defs.find((d) => d.id === stateFieldId);
        if (def && def.type === 'select') filter = { field: def.api_name, op: 'eq', value: stateOptionId };
      } else if (typeof relationFieldId === 'string' && relationFieldId !== '') {
        const def = defs.find((d) => d.id === relationFieldId);
        if (def && def.type === 'relation') filter = { field: def.api_name, op: 'has', value: [agentId] };
      }
      if (filter) byDb.set(databaseId, [...(byDb.get(databaseId) ?? []), filter]);
    }
    return [...byDb.entries()].map(([databaseId, filters]) => ({ databaseId, filters }));
  }

  /** The WHERE for one database: waiting records the OWNER can see, in a shared (non-personal) space, narrowed by `handled`. */
  private async where(plan: DbPlan, owner: Membership, agentId: string, mode: 'eligible' | 'open'): Promise<SQL | null> {
    const db = await this.db
      .select({ id: databases.id, spaceId: databases.spaceId, personal: spaces.personal })
      .from(databases)
      .innerJoin(spaces, eq(spaces.id, databases.spaceId))
      .where(and(eq(databases.id, plan.databaseId), isNull(databases.deletedAt)))
      .limit(1);
    const home = db[0];
    // Personal content never wakes anything (enqueue says so too); a database the owner cannot reach has nothing the agent may read.
    if (!home || home.personal) return null;
    if ((await this.access.effectiveForDatabase(owner, { id: home.id, spaceId: home.spaceId })) === null) return null;
    const filter = plan.filters.length === 1 ? plan.filters[0] : { or: plan.filters };
    const base = await this.records.aggregateWhere(plan.databaseId, { filter }, owner.userId, owner);
    const open = sql`EXISTS (SELECT 1 FROM agent_wakes w WHERE w.agent_id = ${agentId} AND w.record_id = ${records.id} AND w.status IN ('queued', 'claimed'))`;
    const handled = sql`EXISTS (SELECT 1 FROM agent_wakes w WHERE w.agent_id = ${agentId} AND w.record_id = ${records.id} AND w.status IN ('queued', 'claimed', 'done'))`;
    return and(base, mode === 'open' ? open : sql`NOT ${handled}`) as SQL;
  }

  private async countWhere(where: SQL): Promise<number> {
    const [row] = await this.db.select({ value: sql<number>`count(*)::int` }).from(records).where(where);
    return row?.value ?? 0;
  }

  private async countFor(plans: DbPlan[], owner: Membership, agentId: string, mode: 'eligible' | 'open'): Promise<number> {
    let total = 0;
    for (const plan of plans) {
      const where = await this.where(plan, owner, agentId, mode);
      if (where) total += await this.countWhere(where);
    }
    return total;
  }

  /**
   * The number the agent page shows: how many records are waiting in the agent's trigger state(s) with nothing queued or run for
   * them. `null` = not for this caller (anyone but the agent's owner or an admin) or not applicable (the agent cannot take wakes).
   * Zero is a real answer and means "show nothing".
   */
  async countForSummary(caller: Membership, agentId: string): Promise<number | null> {
    if (caller.role === 'guest') return null;
    const facts = await this.wakes.catchUpFacts(caller.workspaceId, agentId);
    if (!facts?.owner || !facts.enabled || !facts.ownAi) return null;
    if (facts.owner.userId !== caller.userId && caller.role !== 'admin') return null;
    return this.countFor(await this.plans(caller.workspaceId, agentId), facts.owner as Membership, agentId, 'eligible');
  }

  /** The records one click will wake: oldest first (stable between clicks), at most `limit`. */
  private async pick(plans: DbPlan[], owner: Membership, agentId: string, limit: number): Promise<string[]> {
    const ids: string[] = [];
    for (const plan of plans) {
      if (ids.length >= limit) break;
      const where = await this.where(plan, owner, agentId, 'eligible');
      if (!where) continue;
      const rows = await this.db.select({ id: records.id }).from(records).where(where).orderBy(asc(records.createdAt), asc(records.id)).limit(limit - ids.length);
      ids.push(...rows.map((r) => r.id));
    }
    return ids;
  }

  /**
   * POST /agents/{agent}/catch-up. The caller must be the agent's owner or an admin (anyone else, and an unknown agent, hear the same
   * 404). Idempotent: a second click finds every record already queued and adds nothing.
   */
  async run(caller: Membership, agentId: string): Promise<{ queued: number; already_waiting: number; remaining: number; skipped: number }> {
    if (caller.role === 'guest') throw new ForbiddenException('A guest cannot start an agent on waiting records.');
    const identity = /^[0-9a-f-]{36}$/i.test(agentId) ? await resolveAgentIdentity(this.db, caller.workspaceId, agentId) : null;
    if (!identity || (identity.ownerId !== caller.userId && caller.role !== 'admin')) throw new NotFoundException('Agent not found');
    const facts = await this.wakes.catchUpFacts(caller.workspaceId, agentId);
    if (!facts) throw new NotFoundException('Agent not found');
    if (!facts.enabled) throw new UnprocessableEntityException('This agent is switched off. Turn it on first.');
    if (!facts.ownAi) throw new UnprocessableEntityException('Only an agent whose AI mode is "Your own AI" has a queue to catch up.');
    if (!facts.owner) throw new UnprocessableEntityException("This agent's owner is no longer in the workspace, so nothing can be woken for it.");
    const owner = facts.owner as Membership;

    const plans = await this.plans(caller.workspaceId, agentId);
    const alreadyWaiting = await this.countFor(plans, owner, agentId, 'open');
    const allowance = this.catchUpAllowance(caller.workspaceId, agentId);
    const cap = allowance === null ? CATCH_UP_MAX_PER_CLICK : Math.max(0, Math.min(CATCH_UP_MAX_PER_CLICK, allowance));
    const ids = await this.pick(plans, owner, agentId, cap);

    let queued = 0;
    let coalesced = 0;
    let skipped = 0;
    for (const recordId of ids) {
      try {
        const res = await this.wakes.enqueue({
          workspaceId: caller.workspaceId,
          agentId,
          reason: 'catch_up',
          recordId,
          requestedBy: caller.userId,
          materialize: true,
        });
        if (res.outcome === 'created') queued++;
        else if (res.outcome === 'skipped') skipped++;
        else coalesced++;
      } catch (error) {
        skipped++;
        this.logger.warn(`catch-up for agent ${agentId}, record ${recordId}: not queued, ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    // What is still to do after this click. A record the enqueue refused stays "waiting" for the count, but another click cannot
    // change that, so it is reported as `skipped` and kept out of `remaining` (otherwise "N more remain" would never reach zero).
    const left = await this.countFor(plans, owner, agentId, 'eligible');
    return { queued, already_waiting: alreadyWaiting + coalesced, remaining: Math.max(0, left - skipped), skipped };
  }
}
