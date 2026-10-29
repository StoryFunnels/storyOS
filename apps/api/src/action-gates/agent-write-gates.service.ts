import { Inject, Injectable, Logger, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { DB } from '../db/db.module';
import type { Db } from '../db/client';
import { agentWriteGates, approvals, databases, fields, type ChangeSource } from '../db/schema';
import { NotificationsService } from '../notifications/notifications.service';
import { resolveAgentIdentity } from '../agents/agent-identity';

type GateRow = typeof agentWriteGates.$inferSelect;

export const AGENT_WRITE_OPERATIONS = ['create', 'update'] as const;
export type AgentWriteOperation = (typeof AGENT_WRITE_OPERATIONS)[number];

/**
 * #1104 — the held write, as frozen on the `approvals` row. `inputs` is exactly what the agent asked to write (one entry
 * for an update or a single create, N for a batch create, which is held as ONE unit); `record_id` is set for an update.
 * Approval re-applies THESE values and nothing else, so what the approver read is what is written.
 */
export interface AgentWriteGateSnapshot {
  type: 'agent_write_gate';
  operation: AgentWriteOperation;
  database_id: string;
  record_id: string | null;
  inputs: Array<Record<string, unknown>>;
  agent_id: string;
  agent_name: string;
}

export interface CheckAgentWriteInput {
  workspaceId: string;
  databaseId: string;
  operation: AgentWriteOperation;
  /** Only `agent` is ever held, and only with an agent id: a person, an MCP client and an automation are not this gate's. */
  source: ChangeSource;
  agentId: string | undefined;
  agentName: string | undefined;
  requesterActorId: string | null;
  recordId: string | null;
  inputs: Array<Record<string, unknown>>;
}

export type CheckAgentWriteResult = { held: false } | { held: true; approvalId: string; message: string };

/**
 * Same module shape as ActionGatesService (#542): ZERO dependency on AutomationsModule, because RecordsService calls it and
 * ApprovalsService (which APPLIES an approved gate) already depends on RecordsService. It inserts the `approvals` row
 * directly, in the shape ApprovalsService.createRow uses, rather than owning a second approval mechanism.
 */
@Injectable()
export class AgentWriteGatesService {
  private readonly logger = new Logger(AgentWriteGatesService.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * The enabled gates that would hold this write. `touched` is the field api_names the write supplies, or `'all'` for a
   * write whose fields are not known up front (a duplicate, a version restore): it matches a field-narrowed gate too,
   * because refusing too much is the safe direction for a write nobody can inspect.
   */
  async matching(
    workspaceId: string,
    agentId: string,
    databaseId: string,
    operation: AgentWriteOperation,
    touched: string[] | 'all',
  ): Promise<GateRow[]> {
    const rows = await this.db.query.agentWriteGates.findMany({
      where: and(
        eq(agentWriteGates.workspaceId, workspaceId),
        eq(agentWriteGates.agentId, agentId),
        eq(agentWriteGates.enabled, true),
      ),
    });
    return rows.filter((g) => {
      if (!g.operations.includes(operation)) return false;
      if (g.databaseId !== null && g.databaseId !== databaseId) return false;
      if (g.fields === null) return true;
      if (touched === 'all') return true;
      return touched.some((f) => g.fields!.includes(f));
    });
  }

  /** Holds the write when a gate matches: stages an approval and notifies. Never writes the record itself. */
  async check(input: CheckAgentWriteInput): Promise<CheckAgentWriteResult> {
    if (input.source !== 'agent' || !input.agentId) return { held: false };
    const touched = [...new Set(input.inputs.flatMap((i) => Object.keys(i)))];
    const matched = await this.matching(input.workspaceId, input.agentId, input.databaseId, input.operation, touched);
    if (matched.length === 0) return { held: false };

    // The approver is the agent's owner, resolved NOW (never trusted from a token), exactly the "ask the owner" rule an
    // agent run's own gate applies. Any workspace admin may also decide (ApprovalsController). An agent with no resolvable
    // owner cannot reach this point: its token is refused at the auth guard.
    const identity = await resolveAgentIdentity(this.db, input.workspaceId, input.agentId);
    const approverId = identity?.ownerId ?? input.requesterActorId;
    if (!approverId) {
      // Fail closed: a held write with nobody able to clear it must not silently become a performed one.
      throw new UnprocessableEntityException('This agent\'s writes need approval but no approver could be resolved');
    }
    const agentName = identity?.agentName ?? input.agentName ?? 'An agent';
    const requester = input.requesterActorId ?? approverId;

    const database = await this.db.query.databases.findFirst({
      where: eq(databases.id, input.databaseId),
      columns: { name: true },
    });
    const dbLabel = database?.name ?? input.databaseId;
    const fieldsLabel = [...new Set(input.inputs.flatMap((i) => Object.keys(i)))].join(', ');
    const previewText =
      input.operation === 'create'
        ? `${agentName} wants to create ${input.inputs.length === 1 ? 'a record' : `${input.inputs.length} records`} in ${dbLabel}` +
          (fieldsLabel ? ` (${fieldsLabel})` : '')
        : `${agentName} wants to update a record in ${dbLabel} (${fieldsLabel})`;

    const snapshot = {
      action: {
        type: 'agent_write_gate' as const,
        operation: input.operation,
        database_id: input.databaseId,
        record_id: input.recordId,
        inputs: input.inputs,
        agent_id: input.agentId,
        agent_name: agentName,
      } satisfies AgentWriteGateSnapshot,
      ctx: { workspaceId: input.workspaceId, databaseId: input.databaseId, recordId: input.recordId, actorId: requester },
    };
    const [created] = await this.db
      .insert(approvals)
      .values({
        workspaceId: input.workspaceId,
        ruleId: null,
        runId: null,
        recordId: input.recordId,
        actionIndex: 0,
        actionSnapshot: snapshot,
        previewText,
        approverId,
      })
      .returning();

    await this.notifications
      .notify({
        workspaceId: input.workspaceId,
        databaseId: input.databaseId,
        recordId: input.recordId ?? undefined,
        actorId: requester,
        type: 'action_approval_requested',
        recipients: [approverId],
        snippet: previewText.slice(0, 140),
        refId: created!.id,
        allowSelf: true,
      })
      .catch((error: unknown) => this.logger.warn(`agent-write-gate notify failed: ${String(error)}`));

    return {
      held: true,
      approvalId: created!.id,
      message: 'This write is held for approval by a gate on this agent. It has not happened yet; a person must approve it.',
    };
  }

  /**
   * #1111 — is `userId` the OWNER of `agentId` right now? Owner is `resolveAgentIdentity`'s live ownerId (the agent record's
   * creator, who must still be an active member). A malformed id, an unknown agent and somebody else's agent all answer the
   * same `false`, so the caller can give one 404 and leak nothing about which it was (ADR-0018 b).
   */
  async isOwner(workspaceId: string, agentId: string, userId: string): Promise<boolean> {
    if (!z.uuid().safeParse(agentId).success) return false;
    const identity = await resolveAgentIdentity(this.db, workspaceId, agentId);
    return identity?.ownerId === userId;
  }

  async list(workspaceId: string, agentId?: string): Promise<GateRow[]> {
    return this.db.query.agentWriteGates.findMany({
      where: and(eq(agentWriteGates.workspaceId, workspaceId), agentId ? eq(agentWriteGates.agentId, agentId) : undefined),
      orderBy: (t, { asc }) => [asc(t.createdAt)],
    });
  }

  /**
   * Declares a gate. Validated at the door so a gate can never be a decorative one: the agent must be a live record in
   * THIS workspace's Agents database, the database (if named) must be this workspace's, and a field list needs a database
   * (api names are per database) whose fields really exist.
   */
  async create(input: {
    workspaceId: string;
    agentId: string;
    operations: AgentWriteOperation[];
    databaseId: string | null;
    fields: string[] | null;
    createdBy: string;
  }): Promise<GateRow> {
    const identity = await resolveAgentIdentity(this.db, input.workspaceId, input.agentId);
    if (!identity) throw new NotFoundException('Agent not found');
    const operations = [...new Set(input.operations)];
    if (operations.length === 0) throw new UnprocessableEntityException('A gate needs at least one operation (create, update)');
    let fieldList = input.fields && input.fields.length > 0 ? [...new Set(input.fields)] : null;
    if (input.databaseId) {
      const database = await this.db.query.databases.findFirst({
        where: and(eq(databases.id, input.databaseId), eq(databases.workspaceId, input.workspaceId), isNull(databases.deletedAt)),
        columns: { id: true },
      });
      if (!database) throw new NotFoundException('Database not found');
    }
    if (fieldList) {
      if (!input.databaseId) throw new UnprocessableEntityException('Naming fields needs a database: field names belong to one database');
      const defs = await this.db.query.fields.findMany({
        where: and(eq(fields.databaseId, input.databaseId), isNull(fields.deletedAt)),
        columns: { apiName: true },
      });
      const known = new Set(defs.map((d) => d.apiName));
      const unknown = fieldList.filter((f) => !known.has(f));
      if (unknown.length > 0) throw new UnprocessableEntityException(`Unknown field(s) on that database: ${unknown.join(', ')}`);
    }
    fieldList = fieldList && fieldList.length > 0 ? fieldList : null;
    const [created] = await this.db
      .insert(agentWriteGates)
      .values({
        workspaceId: input.workspaceId,
        agentId: input.agentId,
        operations,
        databaseId: input.databaseId,
        fields: fieldList,
        createdBy: input.createdBy,
      })
      .returning();
    return created!;
  }

  async update(workspaceId: string, id: string, patch: { enabled?: boolean }): Promise<GateRow> {
    const existing = await this.db.query.agentWriteGates.findFirst({
      where: and(eq(agentWriteGates.id, id), eq(agentWriteGates.workspaceId, workspaceId)),
    });
    if (!existing) throw new NotFoundException('Gate not found');
    const [updated] = await this.db
      .update(agentWriteGates)
      .set({ ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}) })
      .where(eq(agentWriteGates.id, id))
      .returning();
    return updated!;
  }

  async remove(workspaceId: string, id: string): Promise<void> {
    const existing = await this.db.query.agentWriteGates.findFirst({
      where: and(eq(agentWriteGates.id, id), eq(agentWriteGates.workspaceId, workspaceId)),
    });
    if (!existing) throw new NotFoundException('Gate not found');
    await this.db.delete(agentWriteGates).where(eq(agentWriteGates.id, id));
  }

  /** Replace-all for a pack install/update: this agent's gates become exactly `gates` (an explicit empty list clears). */
  async replaceForAgent(
    workspaceId: string,
    agentId: string,
    gates: Array<{ operations: AgentWriteOperation[]; databaseId: string | null; fields: string[] | null }>,
    createdBy: string,
  ): Promise<void> {
    await this.db.delete(agentWriteGates).where(and(eq(agentWriteGates.workspaceId, workspaceId), eq(agentWriteGates.agentId, agentId)));
    for (const g of gates) {
      await this.create({ workspaceId, agentId, operations: g.operations, databaseId: g.databaseId, fields: g.fields, createdBy });
    }
  }
}
