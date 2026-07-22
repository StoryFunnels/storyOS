import { randomBytes, randomUUID } from 'node:crypto';
import {
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
  UnprocessableEntityException,
} from '@nestjs/common';
import { and, desc, eq, isNotNull, isNull, lte, sql } from 'drizzle-orm';
import type { AutomationAction } from '@storyos/schemas';
import { DB } from '../db/db.module';
import type { Db } from '../db/client';
import { automationRuns, automations, databases, records, workspaces } from '../db/schema';
import { compileFilter } from '../records/query-compiler';
import type { FilterNode } from '@storyos/schemas';
import { RecordsService } from '../records/records.service';
import { DomainEventsService } from '../events/domain-events.service';
import type { DomainEvent } from '../events/domain-events.service';
import { EntitlementsService } from '../billing/entitlements.service';
import { AutomationActionsService } from './actions.service';
import { env } from '../config/env';
import { presentActionHeaders, restoreActionHeaders } from '../common/webhook-headers';
import { redactSecrets } from '../common/redact-secrets';

interface Trigger {
  type: string;
  field_id?: string;
  relation_field_id?: string;
  every?: 'hour' | 'day' | 'week';
  at?: string;
  weekday?: number;
}

const MAX_DEPTH = 2;
/** Also reused by JobRunnerService (MN-253) for a job-backed rule's failure policy. */
export const MAX_FAILURES = 10;
/** create()/update() apply this whenever a rule's trigger is webhook_received. */
const HOOK_SECRET_PREFIX = 'whin_';

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
  /** MN-254: in-flight webhook hook runs, keyed by the run id returned in the 202. */
  private hookRuns = new Map<string, Promise<void>>();

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly recordsService: RecordsService,
    private readonly actions: AutomationActionsService,
    private readonly domainEvents: DomainEventsService,
    private readonly entitlements: EntitlementsService,
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
    input: {
      name: string;
      trigger: Trigger;
      condition?: unknown;
      actions: AutomationAction[];
      enabled?: boolean;
    },
    actorId: string,
  ) {
    // No prior actions to preserve against — this strips any stray presence flags.
    const actions = restoreActionHeaders(input.actions, []);
    await this.actions.validate(databaseId, workspaceId, actions, input.trigger.type);
    // MN-254: a webhook delivery has no triggering record, so a rule's
    // condition (a record-filter AST) has nothing to evaluate against — v1
    // rejects it outright rather than silently always-match or always-skip.
    if (input.trigger.type === 'webhook_received' && input.condition) {
      throw new UnprocessableEntityException(
        'webhook_received rules cannot use a condition yet — payload-based conditions are not supported in v1.',
      );
    }
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
        ...(input.trigger.type === 'webhook_received' ? this.mintHook() : {}),
      })
      .returning();
    return this.present(rule!);
  }

  async update(
    workspaceId: string,
    databaseId: string,
    ruleId: string,
    patch: {
      name?: string;
      trigger?: Trigger;
      condition?: unknown;
      actions?: AutomationAction[];
      enabled?: boolean;
    },
    actorId: string,
  ) {
    const rule = await this.getRule(databaseId, ruleId);
    const trigger = (patch.trigger ?? rule.trigger) as Trigger;
    // Resolve write-only header presence flags against the stored actions so editing
    // an unrelated part of the rule can't clobber a secret webhook header (#249).
    const actions = patch.actions ? restoreActionHeaders(patch.actions, rule.actions) : undefined;
    if (actions) await this.actions.validate(databaseId, workspaceId, actions, trigger.type);
    const condition = patch.condition === undefined ? rule.condition : patch.condition;
    if (trigger.type === 'webhook_received' && condition) {
      throw new UnprocessableEntityException(
        'webhook_received rules cannot use a condition yet — payload-based conditions are not supported in v1.',
      );
    }
    if (patch.condition) await this.assertConditionCompiles(databaseId, patch.condition, actorId);
    // Mint a hook identity the moment a rule becomes (or starts life as, via a
    // trigger patch) webhook_received and doesn't have one yet; clear it the
    // moment the trigger moves away, so a stale rule never keeps a live URL.
    const hookPatch =
      trigger.type === 'webhook_received'
        ? rule.hookToken
          ? {}
          : this.mintHook()
        : rule.hookToken
          ? { hookToken: null, hookSecret: null, lastHookPayload: null, lastHookAt: null }
          : {};
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
        ...hookPatch,
      })
      .where(eq(automations.id, ruleId))
      .returning();
    return this.present(updated!);
  }

  /** Rotate a rule's hook token + secret (MN-254) — the old URL 404s immediately. */
  async regenerateHook(databaseId: string, ruleId: string) {
    const rule = await this.getRule(databaseId, ruleId);
    if ((rule.trigger as Trigger).type !== 'webhook_received') {
      throw new UnprocessableEntityException(
        'Only a webhook_received rule has a hook to regenerate.',
      );
    }
    const [updated] = await this.db
      .update(automations)
      .set(this.mintHook())
      .where(eq(automations.id, ruleId))
      .returning();
    return this.present(updated!);
  }

  /** The RuleEditor's "last received payload" inspector (MN-254). */
  async lastHookPayload(databaseId: string, ruleId: string) {
    const rule = await this.getRule(databaseId, ruleId);
    return { last_hook_payload: rule.lastHookPayload, last_hook_at: rule.lastHookAt };
  }

  /**
   * token: url-safe, unguessable (18 bytes of entropy). secret: mirrors the
   * outbound `whsec_` convention (webhooks.service.ts create()) so both
   * inbound and outbound webhook secrets are recognizable at a glance.
   */
  private mintHook(): { hookToken: string; hookSecret: string } {
    return {
      hookToken: randomBytes(24).toString('base64url'),
      hookSecret: `${HOOK_SECRET_PREFIX}${randomBytes(24).toString('hex')}`,
    };
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
  async test(
    workspaceId: string,
    databaseId: string,
    ruleId: string,
    recordId: string,
    actorId: string,
  ) {
    const rule = await this.getRule(databaseId, ruleId);
    const matches = rule.condition
      ? await this.conditionMatches(databaseId, rule.condition as FilterNode, recordId, actorId)
      : true;
    await this.actions.validate(
      databaseId,
      workspaceId,
      rule.actions as AutomationAction[],
      (rule.trigger as Trigger).type,
    );
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

  // --- webhook hook path (MN-254) ---

  /**
   * Resolve a delivery's (workspaceSlug, hookToken) pair to the rule it names,
   * or null if there is no such rule, it's disabled, or its trigger has since
   * moved away from webhook_received (a token lingering after a trigger patch
   * would otherwise silently keep working). The receiver turns null into a
   * 404 with no further detail — indistinguishable from a token that never
   * existed.
   */
  async findByHookToken(workspaceSlug: string, hookToken: string) {
    const [row] = await this.db
      .select({
        id: automations.id,
        databaseId: automations.databaseId,
        workspaceId: databases.workspaceId,
        trigger: automations.trigger,
        hookSecret: automations.hookSecret,
        actions: automations.actions,
        createdBy: automations.createdBy,
        enabled: automations.enabled,
      })
      .from(automations)
      .innerJoin(databases, eq(databases.id, automations.databaseId))
      .innerJoin(workspaces, eq(workspaces.id, databases.workspaceId))
      .where(and(eq(automations.hookToken, hookToken), eq(workspaces.slug, workspaceSlug)))
      .limit(1);
    if (!row || !row.enabled || (row.trigger as Trigger).type !== 'webhook_received') return null;
    return row;
  }

  /**
   * Kicks off one webhook delivery's execution and returns a run id
   * synchronously, so the receiver's 202 can carry it immediately — the run
   * row itself, and everything the actions do, land after the reply (Step 2
   * of MN-254's guide: "respond 202 immediately, then execute async").
   */
  startHookRun(
    rule: { id: string; databaseId: string; actions: unknown; createdBy: string | null },
    workspaceId: string,
    payload: Record<string, unknown>,
  ): string {
    const runId = randomUUID();
    const promise = this.runHookRule(rule, workspaceId, payload, runId).catch((error) => {
      this.logger.warn(`webhook hook run ${runId} failed: ${String(error)}`);
    });
    this.hookRuns.set(runId, promise);
    void promise.finally(() => {
      if (this.hookRuns.get(runId) === promise) this.hookRuns.delete(runId);
    });
    return runId;
  }

  /** Test hook: awaits a hook run so assertions see its effects (mirrors settle()). */
  async settleHook(runId: string): Promise<void> {
    await (this.hookRuns.get(runId) ?? Promise.resolve());
  }

  /**
   * Executes one webhook delivery. Deliberately bypasses DomainEventsService —
   * that bus is for record-change events, and a hook delivery has no record —
   * and instead builds an ActionContext whose `record` is null and whose
   * `payload` is the delivered body. Always ends with exactly one
   * automationRuns row, at the pre-minted `runId`, so quota accounting and the
   * run-history view see every delivery whether it succeeds, is skipped for
   * quota, or throws.
   */
  private async runHookRule(
    rule: { id: string; databaseId: string; actions: unknown; createdBy: string | null },
    workspaceId: string,
    payload: Record<string, unknown>,
    runId: string,
  ): Promise<void> {
    const started = Date.now();
    // Observability for the RuleEditor's "last received payload" inspector —
    // recorded even if the run itself is skipped or fails.
    await this.db
      .update(automations)
      .set({ lastHookPayload: redactSecrets(payload), lastHookAt: new Date() })
      .where(eq(automations.id, rule.id));

    try {
      // MN-168: same non-AI allowance every other automation run counts against.
      if (!(await this.entitlements.can(workspaceId, 'automation_run'))) {
        await this.db.insert(automationRuns).values({
          id: runId,
          automationId: rule.id,
          workspaceId,
          triggerRecordId: null,
          status: 'skipped',
          error: 'plan automation-run allowance reached for this month',
          depth: 0,
          durationMs: Date.now() - started,
        });
        return;
      }
      const effects = await this.actions.execute(rule.actions as AutomationAction[], {
        workspaceId,
        databaseId: rule.databaseId,
        record: null,
        payload,
        actorId: rule.createdBy ?? 'automation',
        // A create_record action's own write emits record_created at depth 1,
        // consistent with the normal path's depth+1 — so a downstream rule can
        // run exactly once (MAX_DEPTH guard) instead of chaining forever.
        depth: 1,
        triggerType: 'webhook_received',
        ruleId: rule.id,
        runId,
      });
      await this.db.insert(automationRuns).values({
        id: runId,
        automationId: rule.id,
        workspaceId,
        triggerRecordId: null,
        status: 'ok',
        effects,
        depth: 1,
        durationMs: Date.now() - started,
      });
      await this.entitlements.recordNonAiRun(workspaceId);
      await this.db
        .update(automations)
        .set({ failureStreak: 0 })
        .where(eq(automations.id, rule.id));
    } catch (error) {
      await this.db.insert(automationRuns).values({
        id: runId,
        automationId: rule.id,
        workspaceId,
        triggerRecordId: null,
        status: 'error',
        error: (error as Error).message?.slice(0, 500) ?? 'failed',
        depth: 0,
        durationMs: Date.now() - started,
      });
      const current = await this.db.query.automations.findFirst({
        where: eq(automations.id, rule.id),
      });
      if (current) {
        const streak = current.failureStreak + 1;
        await this.db
          .update(automations)
          .set({ failureStreak: streak, enabled: streak >= MAX_FAILURES ? false : undefined })
          .where(eq(automations.id, rule.id));
        if (streak >= MAX_FAILURES)
          this.logger.warn(`automation ${rule.id} auto-disabled after ${streak} failures`);
      }
    }
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
      if (trigger.type === 'record_linked' && trigger.relation_field_id !== event.relationFieldId)
        continue;

      if (event.depth >= MAX_DEPTH) {
        await this.logRun(
          rule.id,
          event.workspaceId,
          event.recordId,
          'skipped',
          `depth ${event.depth} — loop guard`,
          null,
          event.depth,
          0,
        );
        continue;
      }
      await this.runRule(rule.id, event.workspaceId, event.databaseId, event.recordId, event.depth);
    }
  }

  private async runRule(
    ruleId: string,
    workspaceId: string,
    databaseId: string,
    recordId: string,
    depth: number,
  ) {
    const started = Date.now();
    // MN-253: pre-minted, like startHookRun's runId — actions.execute() needs
    // it before the run row exists, to key any job it enqueues (idempotencyKey
    // = ruleId:recordId:runId:actionIndex). Threaded into the same
    // automationRuns.id below so a job's runId FK actually resolves to this run.
    const runId = randomUUID();
    const rule = await this.db.query.automations.findFirst({ where: eq(automations.id, ruleId) });
    if (!rule || !rule.enabled) return;
    try {
      if (rule.condition) {
        const matches = await this.conditionMatches(
          databaseId,
          rule.condition as FilterNode,
          recordId,
          rule.createdBy ?? '',
        );
        if (!matches) {
          return; // silent non-match: no run row (intended behavior; run log stays signal, not noise)
        }
      }
      const record = await this.recordsService.get(databaseId, recordId).catch(() => null);
      if (!record) {
        await this.logRun(
          ruleId,
          workspaceId,
          recordId,
          'skipped',
          'record gone',
          null,
          depth,
          Date.now() - started,
        );
        return;
      }

      // MN-168: this engine only ever runs deterministic, non-AI actions —
      // there is no LLM anywhere in this path — so every completed run here
      // is gated against, and counts toward, the plan's non-AI allowance.
      // Graceful degradation, never destructive: a workspace over its
      // allowance gets a clearly-reasoned 'skipped' row, not a crash.
      if (!(await this.entitlements.can(workspaceId, 'automation_run'))) {
        await this.logRun(
          ruleId,
          workspaceId,
          recordId,
          'skipped',
          'plan automation-run allowance reached for this month',
          null,
          depth,
          Date.now() - started,
        );
        return;
      }

      const effects = await this.actions.execute(rule.actions as AutomationAction[], {
        workspaceId,
        databaseId,
        record,
        actorId: rule.createdBy ?? 'automation',
        depth: depth + 1,
        ruleId,
        runId,
      });
      await this.logRun(
        ruleId,
        workspaceId,
        recordId,
        'ok',
        null,
        effects,
        depth,
        Date.now() - started,
        runId,
      );
      await this.entitlements.recordNonAiRun(workspaceId);
      await this.db.update(automations).set({ failureStreak: 0 }).where(eq(automations.id, ruleId));
    } catch (error) {
      const streak = rule.failureStreak + 1;
      await this.logRun(
        ruleId,
        workspaceId,
        recordId,
        'error',
        (error as Error).message?.slice(0, 500) ?? 'failed',
        null,
        depth,
        Date.now() - started,
        runId,
      );
      await this.db
        .update(automations)
        .set({ failureStreak: streak, enabled: streak >= MAX_FAILURES ? false : undefined })
        .where(eq(automations.id, ruleId));
      if (streak >= MAX_FAILURES)
        this.logger.warn(`automation ${ruleId} auto-disabled after ${streak} failures`);
    }
  }

  private async logRun(
    automationId: string,
    workspaceId: string,
    recordId: string | null,
    status: string,
    error: string | null,
    effects: unknown,
    depth: number,
    durationMs: number,
    id?: string,
  ) {
    await this.db.insert(automationRuns).values({
      ...(id ? { id } : {}),
      automationId,
      workspaceId,
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
      where: and(
        eq(automations.enabled, true),
        isNotNull(automations.nextDueAt),
        lte(automations.nextDueAt, new Date()),
      ),
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

        const database = await this.db.query.databases.findFirst({
          where: eq(databases.id, rule.databaseId),
        });
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
        if (targets.length === 500)
          this.logger.warn(`schedule ${rule.id}: truncated at 500 records`);
        for (const target of targets) {
          await this.runRule(rule.id, database.workspaceId, rule.databaseId, target.id, 0);
        }
      } finally {
        await this.db.execute(sql`SELECT pg_advisory_unlock(hashtext(${rule.id}))`);
      }
    }
    // Retention: purge runs older than 30 days (cheap daily-ish pass).
    await this.db
      .delete(automationRuns)
      .where(lte(automationRuns.createdAt, new Date(Date.now() - 30 * 86_400_000)));
  }
}
