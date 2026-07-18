import { Inject, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { and, desc, eq, isNotNull, isNull, lte, sql } from 'drizzle-orm';
import type { AutomationAction } from '@storyos/schemas';
import { DB } from '../db/db.module';
import type { Db } from '../db/client';
import { automationRuns, automations, databases, records } from '../db/schema';
import { compileFilter } from '../records/query-compiler';
import type { FilterNode } from '@storyos/schemas';
import { RecordsService } from '../records/records.service';
import { DomainEventsService } from '../events/domain-events.service';
import type { DomainEvent } from '../events/domain-events.service';
import { AutomationActionsService } from './actions.service';
import { env } from '../config/env';
import { presentActionHeaders, restoreActionHeaders } from '../common/webhook-headers';

interface Trigger {
  type: string;
  field_id?: string;
  relation_field_id?: string;
  every?: 'hour' | 'day' | 'week';
  at?: string;
  weekday?: number;
}

const MAX_DEPTH = 2;
const MAX_FAILURES = 10;

/**
 * Automations engine (MN-047): rules = trigger + condition (view filter AST)
 * + shared actions. Loop guard: automation-caused writes carry depth, max 2.
 * Rules auto-disable after 10 consecutive failures. Schedules tick every 60s
 * (single-node v1; advisory lock keeps it multi-replica-safe later).
 */
@Injectable()
export class AutomationsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AutomationsService.name);
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Serializes runs per record to avoid interleaved writes. */
  private chains = new Map<string, Promise<void>>();

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly recordsService: RecordsService,
    private readonly actions: AutomationActionsService,
    private readonly domainEvents: DomainEventsService,
  ) {}

  onModuleInit() {
    this.domainEvents.subscribe((event) => this.dispatch(event));
    if (env().NODE_ENV !== 'test') {
      this.timer = setInterval(() => void this.tick(), 60_000);
    }
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  // --- CRUD ---

  async list(databaseId: string) {
    const rules = await this.db.query.automations.findMany({
      where: eq(automations.databaseId, databaseId),
      orderBy: [desc(automations.createdAt)],
    });
    // Never surface a stored secret webhook header value in the rules list (#249).
    return { data: rules.map((r) => this.present(r)) };
  }

  /** Read shape: secret send_webhook header values become the presence flag (#249). */
  private present<R extends { actions: unknown }>(rule: R): R {
    return { ...rule, actions: presentActionHeaders(rule.actions) };
  }

  async create(
    workspaceId: string,
    databaseId: string,
    input: { name: string; trigger: Trigger; condition?: unknown; actions: AutomationAction[]; enabled?: boolean },
    actorId: string,
  ) {
    // No prior actions to preserve against — this strips any stray presence flags.
    const actions = restoreActionHeaders(input.actions, []);
    await this.actions.validate(databaseId, workspaceId, actions);
    if (input.condition) await this.assertConditionCompiles(databaseId, input.condition, actorId);
    const [rule] = await this.db
      .insert(automations)
      .values({
        databaseId,
        name: input.name,
        trigger: input.trigger,
        condition: input.condition ?? null,
        actions,
        enabled: input.enabled ?? true,
        createdBy: actorId,
        nextDueAt: input.trigger.type === 'schedule' ? this.nextDue(input.trigger) : null,
      })
      .returning();
    return this.present(rule!);
  }

  async update(
    workspaceId: string,
    databaseId: string,
    ruleId: string,
    patch: { name?: string; trigger?: Trigger; condition?: unknown; actions?: AutomationAction[]; enabled?: boolean },
    actorId: string,
  ) {
    const rule = await this.getRule(databaseId, ruleId);
    // Resolve write-only header presence flags against the stored actions so editing
    // an unrelated part of the rule can't clobber a secret webhook header (#249).
    const actions = patch.actions
      ? restoreActionHeaders(patch.actions, rule.actions)
      : undefined;
    if (actions) await this.actions.validate(databaseId, workspaceId, actions);
    if (patch.condition) await this.assertConditionCompiles(databaseId, patch.condition, actorId);
    const trigger = (patch.trigger ?? rule.trigger) as Trigger;
    const [updated] = await this.db
      .update(automations)
      .set({
        name: patch.name,
        trigger: patch.trigger,
        condition: patch.condition === undefined ? undefined : patch.condition,
        actions,
        enabled: patch.enabled,
        // Re-enabling or editing resets the failure streak and reschedules.
        failureStreak: patch.enabled === true || patch.actions ? 0 : undefined,
        nextDueAt: trigger.type === 'schedule' ? this.nextDue(trigger) : null,
      })
      .where(eq(automations.id, ruleId))
      .returning();
    return this.present(updated!);
  }

  async remove(databaseId: string, ruleId: string) {
    await this.getRule(databaseId, ruleId);
    await this.db.delete(automations).where(eq(automations.id, ruleId));
    return { deleted: true };
  }

  async runs(databaseId: string, ruleId: string) {
    await this.getRule(databaseId, ruleId);
    const rows = await this.db.query.automationRuns.findMany({
      where: eq(automationRuns.automationId, ruleId),
      orderBy: [desc(automationRuns.createdAt)],
      limit: 50,
    });
    return { data: rows };
  }

  /** Dry run against one record: condition verdict + would-run actions. */
  async test(workspaceId: string, databaseId: string, ruleId: string, recordId: string, actorId: string) {
    const rule = await this.getRule(databaseId, ruleId);
    const matches = rule.condition
      ? await this.conditionMatches(databaseId, rule.condition as FilterNode, recordId, actorId)
      : true;
    await this.actions.validate(databaseId, workspaceId, rule.actions as AutomationAction[]);
    return {
      condition_matches: matches,
      would_run: matches,
      actions: (rule.actions as AutomationAction[]).map((a) => a.type),
    };
  }

  private async getRule(databaseId: string, ruleId: string) {
    const rule = await this.db.query.automations.findFirst({
      where: and(eq(automations.id, ruleId), eq(automations.databaseId, databaseId)),
    });
    if (!rule) throw new NotFoundException('Automation not found');
    return rule;
  }

  private async assertConditionCompiles(databaseId: string, condition: unknown, actorId: string) {
    const defs = await this.recordsService.fieldDefs(databaseId);
    compileFilter(condition as FilterNode, {
      defs: new Map(defs.map((d) => [d.api_name, d])),
      currentUserId: actorId,
    });
  }

  private async conditionMatches(
    databaseId: string,
    condition: FilterNode,
    recordId: string,
    actorId: string,
  ): Promise<boolean> {
    const defs = await this.recordsService.fieldDefs(databaseId);
    const where = compileFilter(condition, {
      defs: new Map(defs.map((d) => [d.api_name, d])),
      currentUserId: actorId,
    });
    const [row] = await this.db
      .select({ id: records.id })
      .from(records)
      .where(and(eq(records.id, recordId), where))
      .limit(1);
    return Boolean(row);
  }

  // --- event path ---

  dispatch(event: DomainEvent): void {
    const chain = this.chains.get(event.recordId) ?? Promise.resolve();
    const next = chain
      .then(() => this.handle(event))
      .catch((error) => this.logger.warn(`automation dispatch failed: ${String(error)}`))
      .finally(() => {
        if (this.chains.get(event.recordId) === next) this.chains.delete(event.recordId);
      });
    this.chains.set(event.recordId, next);
  }

  /** Test hook: awaits the record's chain so assertions see automation effects. */
  async settle(recordId: string): Promise<void> {
    await (this.chains.get(recordId) ?? Promise.resolve());
  }

  private async handle(event: DomainEvent): Promise<void> {
    const rules = await this.db.query.automations.findMany({
      where: and(eq(automations.databaseId, event.databaseId), eq(automations.enabled, true)),
    });
    for (const rule of rules) {
      const trigger = rule.trigger as Trigger;
      if (trigger.type !== event.type) continue;
      if (trigger.type === 'record_updated' && trigger.field_id) {
        if (!event.changedFieldIds?.includes(trigger.field_id)) continue;
      }
      if (trigger.type === 'record_linked' && trigger.relation_field_id !== event.relationFieldId) continue;

      if (event.depth >= MAX_DEPTH) {
        await this.logRun(rule.id, event.recordId, 'skipped', `depth ${event.depth} — loop guard`, null, event.depth, 0);
        continue;
      }
      await this.runRule(rule.id, event.workspaceId, event.databaseId, event.recordId, event.depth);
    }
  }

  private async runRule(ruleId: string, workspaceId: string, databaseId: string, recordId: string, depth: number) {
    const started = Date.now();
    const rule = await this.db.query.automations.findFirst({ where: eq(automations.id, ruleId) });
    if (!rule || !rule.enabled) return;
    try {
      if (rule.condition) {
        const matches = await this.conditionMatches(databaseId, rule.condition as FilterNode, recordId, rule.createdBy ?? '');
        if (!matches) {
          return; // silent non-match: no run row (intended behavior; run log stays signal, not noise)
        }
      }
      const record = await this.recordsService.get(databaseId, recordId).catch(() => null);
      if (!record) {
        await this.logRun(ruleId, recordId, 'skipped', 'record gone', null, depth, Date.now() - started);
        return;
      }
      const effects = await this.actions.execute(rule.actions as AutomationAction[], {
        workspaceId,
        databaseId,
        record,
        actorId: rule.createdBy ?? 'automation',
        depth: depth + 1,
      });
      await this.logRun(ruleId, recordId, 'ok', null, effects, depth, Date.now() - started);
      await this.db.update(automations).set({ failureStreak: 0 }).where(eq(automations.id, ruleId));
    } catch (error) {
      const streak = rule.failureStreak + 1;
      await this.logRun(ruleId, recordId, 'error', (error as Error).message?.slice(0, 500) ?? 'failed', null, depth, Date.now() - started);
      await this.db
        .update(automations)
        .set({ failureStreak: streak, enabled: streak >= MAX_FAILURES ? false : undefined })
        .where(eq(automations.id, ruleId));
      if (streak >= MAX_FAILURES) this.logger.warn(`automation ${ruleId} auto-disabled after ${streak} failures`);
    }
  }

  private async logRun(
    automationId: string,
    recordId: string | null,
    status: string,
    error: string | null,
    effects: unknown,
    depth: number,
    durationMs: number,
  ) {
    await this.db.insert(automationRuns).values({
      automationId,
      triggerRecordId: recordId,
      status,
      error,
      effects: effects ?? null,
      depth,
      durationMs,
    });
  }

  // --- schedules ---

  nextDue(trigger: Trigger, from = new Date()): Date {
    const due = new Date(from);
    if (trigger.every === 'hour') {
      due.setMinutes(0, 0, 0);
      due.setHours(due.getHours() + 1);
      return due;
    }
    const [h, m] = (trigger.at ?? '09:00').split(':').map(Number);
    due.setHours(h!, m!, 0, 0);
    if (trigger.every === 'day') {
      if (due <= from) due.setDate(due.getDate() + 1);
      return due;
    }
    // weekly
    const targetDay = trigger.weekday ?? 1;
    while (due.getDay() !== targetDay || due <= from) due.setDate(due.getDate() + 1);
    return due;
  }

  /** One scheduler pass — public so tests can invoke it directly. */
  async tick(): Promise<void> {
    const due = await this.db.query.automations.findMany({
      where: and(eq(automations.enabled, true), isNotNull(automations.nextDueAt), lte(automations.nextDueAt, new Date())),
      limit: 20,
    });
    for (const rule of due) {
      // Advisory lock: safe if multiple replicas tick simultaneously.
      const lockResult = (await this.db.execute(
        sql`SELECT pg_try_advisory_lock(hashtext(${rule.id})) AS locked`,
      )) as unknown as { rows?: Array<{ locked: boolean }> };
      if (!lockResult.rows?.[0]?.locked) continue;
      try {
        const trigger = rule.trigger as Trigger;
        await this.db
          .update(automations)
          .set({ nextDueAt: this.nextDue(trigger) })
          .where(eq(automations.id, rule.id));

        const database = await this.db.query.databases.findFirst({ where: eq(databases.id, rule.databaseId) });
        if (!database) continue;
        // The condition IS the selection for scheduled rules.
        const defs = await this.recordsService.fieldDefs(rule.databaseId);
        const where = rule.condition
          ? compileFilter(rule.condition as FilterNode, {
              defs: new Map(defs.map((d) => [d.api_name, d])),
              currentUserId: rule.createdBy ?? '',
            })
          : undefined;
        const targets = await this.db
          .select({ id: records.id })
          .from(records)
          .where(and(eq(records.databaseId, rule.databaseId), isNull(records.deletedAt), where))
          .limit(500);
        if (targets.length === 500) this.logger.warn(`schedule ${rule.id}: truncated at 500 records`);
        for (const target of targets) {
          await this.runRule(rule.id, database.workspaceId, rule.databaseId, target.id, 0);
        }
      } finally {
        await this.db.execute(sql`SELECT pg_advisory_unlock(hashtext(${rule.id}))`);
      }
    }
    // Retention: purge runs older than 30 days (cheap daily-ish pass).
    await this.db.delete(automationRuns).where(lte(automationRuns.createdAt, new Date(Date.now() - 30 * 86_400_000)));
  }
}
