import { Inject, Injectable, Logger, UnprocessableEntityException } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import type { FieldDef, FilterNode } from '@storyos/schemas';
import { systemFieldDefsFor } from '@storyos/schemas';
import { DB } from '../db/db.module';
import type { Db } from '../db/client';
import { records, validationRules } from '../db/schema';
import { compileFilter, filterReferencedFields } from '../records/query-compiler';

export type ValidationRuleRow = typeof validationRules.$inferSelect;

/** Field types a rule cannot read: derived after the write commits, so the value is not there to check yet. */
export const NON_VALIDATABLE_TYPES = new Set(['formula', 'rollup', 'lookup', 'ai', 'attachment', 'button']);

export interface EnforceContext {
  databaseId: string;
  recordId: string;
  defs: FieldDef[];
  event: 'create' | 'update';
  /** The values BEFORE the write (null on create). */
  before: Record<string, unknown> | null;
  /** The values AFTER the write, as stored. */
  after: Record<string, unknown>;
  /** Ids of the fields this write changed: stored values, written relations, and the title field when it moved. */
  changedFieldIds: ReadonlySet<string>;
  actorId: string | null;
}

/**
 * #231 — evaluates validation rules INSIDE a record write's transaction and aborts it when one fails.
 *
 * It deliberately has no dependency on RecordsService (which calls it): the condition is evaluated as SQL over the
 * row the write has just produced (`SELECT 1 FROM records WHERE id = $id AND <compiled condition>`), by the same
 * `compileFilter` saved views use, so there is ONE condition language and no second evaluator to drift, and the
 * transaction rolling back is what makes "the change is not persisted" true by construction.
 */
@Injectable()
export class ValidationEnforcer {
  private readonly logger = new Logger(ValidationEnforcer.name);

  constructor(@Inject(DB) private readonly db: Db) {}

  /** Field api_names a rule reads (its condition, plus the transition field). */
  static referencedApiNames(rule: Pick<ValidationRuleRow, 'condition'>, defs: FieldDef[], transitionFieldId?: string | null): Set<string> {
    const names = filterReferencedFields(rule.condition as unknown as FilterNode);
    if (transitionFieldId) {
      const t = defs.find((d) => d.id === transitionFieldId);
      if (t) names.add(t.api_name);
    }
    return names;
  }

  /** Every field a rule names still exists. A rule that does not is DANGLING: skipped, and reported on read. */
  static isDangling(rule: ValidationRuleRow, defs: FieldDef[]): boolean {
    const byName = new Map([...defs, ...systemFieldDefsFor(defs.map((d) => d.api_name))].map((d) => [d.api_name, d]));
    for (const name of filterReferencedFields(rule.condition as unknown as FilterNode)) if (!byName.has(name)) return true;
    if (rule.transitionFieldId && !defs.some((d) => d.id === rule.transitionFieldId)) return true;
    return false;
  }

  /** The compiled condition for a rule, against the database's current fields. */
  static compile(rule: ValidationRuleRow, defs: FieldDef[], actorId: string | null) {
    const byApiName = new Map(defs.map((d) => [d.api_name, d]));
    for (const d of systemFieldDefsFor(byApiName.keys())) byApiName.set(d.api_name, d);
    return compileFilter(rule.condition as unknown as FilterNode, { defs: byApiName, currentUserId: actorId ?? '' });
  }

  private fires(rule: ValidationRuleRow, ctx: EnforceContext): boolean {
    if (rule.trigger === 'create') return ctx.event === 'create';
    if (rule.trigger === 'update') {
      if (ctx.event !== 'update') return false;
      const idByName = new Map(ctx.defs.map((d) => [d.api_name, d.id]));
      for (const name of ValidationEnforcer.referencedApiNames(rule, ctx.defs)) {
        const id = idByName.get(name);
        if (id && ctx.changedFieldIds.has(id)) return true;
      }
      return false;
    }
    // transition: the field is now AT the target and was not before.
    const fieldId = rule.transitionFieldId;
    if (!fieldId) return false;
    const now = ctx.after[fieldId] ?? null;
    if (now !== rule.transitionTo) return false;
    if (ctx.event === 'create') return true;
    return (ctx.before?.[fieldId] ?? null) !== rule.transitionTo;
  }

  /** Throws a 422 carrying the rule's own message when a rule that applies is not satisfied. */
  async enforce(tx: Db, ctx: EnforceContext): Promise<void> {
    const rules = await tx.query.validationRules.findMany({
      where: and(eq(validationRules.databaseId, ctx.databaseId), eq(validationRules.enabled, true)),
    });
    for (const rule of rules) {
      if (ValidationEnforcer.isDangling(rule, ctx.defs)) {
        // A rule naming a deleted field must not lock every write to the database (#305's rule: unconfigured is not invalid).
        this.logger.warn({ ruleId: rule.id }, 'validation rule skipped: it names a field that no longer exists');
        continue;
      }
      if (!this.fires(rule, ctx)) continue;
      const condition = ValidationEnforcer.compile(rule, ctx.defs, ctx.actorId);
      const [ok] = await tx
        .select({ one: sql<number>`1` })
        .from(records)
        .where(and(eq(records.id, ctx.recordId), condition))
        .limit(1);
      if (!ok) {
        throw new UnprocessableEntityException({
          message: rule.message,
          details: [{ path: 'validation_rule', message: `${rule.name} (${rule.id})` }],
        });
      }
    }
  }
}
