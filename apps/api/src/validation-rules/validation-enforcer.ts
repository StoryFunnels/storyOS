import { Inject, Injectable, Logger, UnprocessableEntityException } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import type { FieldDef, FilterNode } from '@storyos/schemas';
import { systemFieldDefsFor } from '@storyos/schemas';
import { DB } from '../db/db.module';
import type { Db } from '../db/client';
import { records, selectOptions, validationRules } from '../db/schema';
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

  /**
   * WHY a rule cannot be checked right now, or null when it can. A rule that cannot be checked is SKIPPED on every
   * write (never a lockout) and must be SHOWN as not checkable, never left displaying as enabled while enforcing
   * nothing. Live-derived rather than stored, so it cannot go stale:
   *   - a field it names was deleted;
   *   - its transition field is no longer a select/workflow field, or the option it names is gone;
   *   - a field it reads is now a type a rule cannot read;
   *   - its condition no longer compiles (an operator or option that no longer fits the field's current type).
   * `optionIds` is the set of option ids that exist on the transition field (needed only for transition rules).
   */
  static notCheckableReason(rule: ValidationRuleRow, defs: FieldDef[], optionIds?: ReadonlySet<string>): string | null {
    const byName = new Map([...defs, ...systemFieldDefsFor(defs.map((d) => d.api_name))].map((d) => [d.api_name, d]));
    for (const name of filterReferencedFields(rule.condition as unknown as FilterNode)) {
      const def = byName.get(name);
      if (!def) return `the field "${name}" it names no longer exists`;
      if (NON_VALIDATABLE_TYPES.has(def.type)) return `the field "${name}" is now a ${def.type} field, which a rule cannot read`;
    }
    if (rule.transitionFieldId) {
      const t = defs.find((d) => d.id === rule.transitionFieldId);
      if (!t) return 'its transition field no longer exists';
      if (t.type !== 'select' && t.type !== 'workflow') return `its transition field "${t.api_name}" is now a ${t.type} field, not a select or workflow field`;
      if (optionIds && !optionIds.has(rule.transitionTo ?? '')) return `the option it moves to no longer exists on "${t.api_name}"`;
    }
    try {
      ValidationEnforcer.compile(rule, defs, null);
    } catch (err) {
      return `its condition no longer fits the current fields: ${err instanceof Error ? err.message : 'does not compile'}`;
    }
    return null;
  }

  /** The option ids of a transition rule's field (empty set otherwise): one small read, only for transition rules. */
  async optionIdsFor(tx: Db, rule: ValidationRuleRow): Promise<ReadonlySet<string> | undefined> {
    if (!rule.transitionFieldId) return undefined;
    const rows = await tx.query.selectOptions.findMany({ where: eq(selectOptions.fieldId, rule.transitionFieldId), columns: { id: true } });
    return new Set(rows.map((r) => r.id));
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
      if (!this.fires(rule, ctx)) continue;
      // A rule that cannot be checked must not lock every write to the database (#305's rule: unconfigured is not
      // invalid); it is skipped here and SHOWN as not checkable on read (see `present`).
      const unchecked = ValidationEnforcer.notCheckableReason(rule, ctx.defs, await this.optionIdsFor(tx, rule));
      if (unchecked) {
        this.logger.warn({ ruleId: rule.id, unchecked }, 'validation rule skipped: it cannot be checked');
        continue;
      }
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
