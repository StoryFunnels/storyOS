import { Inject, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { and, asc, eq, gt, isNull, sql } from 'drizzle-orm';
import type { CreateValidationRuleInput, FieldDef, UpdateValidationRuleInput } from '@storyos/schemas';
import { systemFieldDefsFor } from '@storyos/schemas';
import { DB } from '../db/db.module';
import type { Db } from '../db/client';
import { records, selectOptions, validationRules } from '../db/schema';
import { RecordsService } from '../records/records.service';
import { filterReferencedFields } from '../records/query-compiler';
import { NON_VALIDATABLE_TYPES, ValidationEnforcer, type ValidationRuleRow } from './validation-enforcer';

const PAGE = 50;

/**
 * #231 — declaring and reading validation rules. ENFORCEMENT lives in `ValidationEnforcer`, called from inside the
 * record write transactions; this service is the admin-facing half, plus the READ side the ticket's consequence
 * demands: because a rule only fires when a field it references changes, records that already break it persist
 * silently, so every rule can report exactly which stored records violate it now (`violations`). Enforce on write,
 * surface on read.
 */
@Injectable()
export class ValidationRulesService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly records: RecordsService,
    private readonly enforcer: ValidationEnforcer,
  ) {}

  /** Why this rule cannot be checked now (null = it can). */
  private async unchecked(rule: ValidationRuleRow, defs: FieldDef[]): Promise<string | null> {
    return ValidationEnforcer.notCheckableReason(rule, defs, await this.enforcer.optionIdsFor(this.db, rule));
  }

  private async defsOf(databaseId: string): Promise<FieldDef[]> {
    return this.records.fieldDefs(databaseId);
  }

  /** The same checks for create and for a changed condition: every field exists and is one a rule can read. */
  private async assertCondition(condition: unknown, defs: FieldDef[], actorId: string): Promise<void> {
    const byApiName = new Map(defs.map((d) => [d.api_name, d]));
    for (const d of systemFieldDefsFor(byApiName.keys())) byApiName.set(d.api_name, d);
    for (const name of filterReferencedFields(condition as never)) {
      const def = byApiName.get(name);
      if (!def) throw new UnprocessableEntityException(`unknown field "${name}" in the rule's condition`);
      if (NON_VALIDATABLE_TYPES.has(def.type)) {
        throw new UnprocessableEntityException(
          `a validation rule cannot read "${name}" (a ${def.type} field): its value is derived after the write commits, so there is nothing to check yet`,
        );
      }
    }
    // Compiling surfaces a bad op or value for a field's type as the same 422 a view's filter would give.
    ValidationEnforcer.compile({ condition } as ValidationRuleRow, defs, actorId);
  }

  private async resolveTransition(defs: FieldDef[], t: { field: string; to: string }): Promise<{ fieldId: string; to: string }> {
    const def = defs.find((d) => d.api_name === t.field);
    if (!def) throw new UnprocessableEntityException(`unknown field "${t.field}" in transition`);
    if (def.type !== 'select' && def.type !== 'workflow') {
      throw new UnprocessableEntityException(`a transition rule needs a select or workflow field ("${t.field}" is ${def.type})`);
    }
    const options = await this.db.query.selectOptions.findMany({ where: eq(selectOptions.fieldId, def.id) });
    const wanted = t.to.trim().toLowerCase();
    const option = options.find((o) => o.id === t.to) ?? options.find((o) => o.label.trim().toLowerCase() === wanted);
    if (!option) {
      throw new UnprocessableEntityException(`"${t.to}" is not an option of "${t.field}". Options: ${options.map((o) => o.label).join(', ') || '(none)'}`);
    }
    return { fieldId: def.id, to: option.id };
  }

  async create(workspaceId: string, databaseId: string, input: CreateValidationRuleInput, actorId: string) {
    const defs = await this.defsOf(databaseId);
    await this.assertCondition(input.condition, defs, actorId);
    const transition = input.transition ? await this.resolveTransition(defs, input.transition) : null;
    const [row] = await this.db
      .insert(validationRules)
      .values({
        workspaceId,
        databaseId,
        name: input.name,
        trigger: input.trigger,
        transitionFieldId: transition?.fieldId ?? null,
        transitionTo: transition?.to ?? null,
        condition: input.condition as unknown as Record<string, unknown>,
        message: input.message,
        enabled: input.enabled,
        createdBy: actorId,
      })
      .returning();
    return this.present(row!, defs, await this.violationCount(row!, defs));
  }

  private async getRule(databaseId: string, id: string): Promise<ValidationRuleRow> {
    const row = await this.db.query.validationRules.findFirst({
      where: and(eq(validationRules.id, id), eq(validationRules.databaseId, databaseId)),
    });
    if (!row) throw new NotFoundException('Validation rule not found');
    return row;
  }

  async update(databaseId: string, id: string, patch: UpdateValidationRuleInput, actorId: string) {
    const existing = await this.getRule(databaseId, id);
    const defs = await this.defsOf(databaseId);
    if (patch.condition) await this.assertCondition(patch.condition, defs, actorId);
    // A rule that cannot be checked must not be (re)enabled or re-conditioned as if it could: say why instead.
    if (patch.enabled === true || patch.condition) {
      const reason = await this.unchecked(
        { ...existing, ...(patch.condition ? { condition: patch.condition as unknown as Record<string, unknown> } : {}) },
        defs,
      );
      if (reason) throw new UnprocessableEntityException(`This rule cannot be enabled or changed while it cannot be checked: ${reason}. Fix the field, or delete the rule and declare another.`);
    }
    const [row] = await this.db
      .update(validationRules)
      .set({
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.message !== undefined ? { message: patch.message } : {}),
        ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
        ...(patch.condition ? { condition: patch.condition as unknown as Record<string, unknown> } : {}),
      })
      .where(eq(validationRules.id, existing.id))
      .returning();
    return this.present(row!, defs, await this.violationCount(row!, defs));
  }

  async remove(databaseId: string, id: string) {
    const existing = await this.getRule(databaseId, id);
    await this.db.delete(validationRules).where(eq(validationRules.id, existing.id));
    return { deleted: true };
  }

  async list(databaseId: string) {
    const defs = await this.defsOf(databaseId);
    const rows = await this.db.query.validationRules.findMany({
      where: eq(validationRules.databaseId, databaseId),
      orderBy: [asc(validationRules.createdAt)],
    });
    return { data: await Promise.all(rows.map(async (r) => this.present(r, defs, await this.violationCount(r, defs)))) };
  }

  /** Records that ALREADY break the rule (the read side: enforced on write, surfaced on read). */
  private violationWhere(rule: ValidationRuleRow, defs: FieldDef[]) {
    const condition = ValidationEnforcer.compile(rule, defs, null);
    const base = and(eq(records.databaseId, rule.databaseId), isNull(records.deletedAt));
    // A transition rule only judges records currently AT its target; NULL condition results count as violations.
    const atTarget =
      rule.trigger === 'transition' && rule.transitionFieldId
        ? sql`${records.values}->>${rule.transitionFieldId} = ${rule.transitionTo}`
        : undefined;
    return and(base, atTarget, sql`NOT COALESCE((${condition}), false)`);
  }

  private async violationCount(rule: ValidationRuleRow, defs: FieldDef[]): Promise<number | null> {
    if (await this.unchecked(rule, defs)) return null;
    const [row] = await this.db.select({ n: sql<number>`count(*)::int` }).from(records).where(this.violationWhere(rule, defs));
    return row?.n ?? 0;
  }

  async violations(databaseId: string, id: string, cursor?: number) {
    const rule = await this.getRule(databaseId, id);
    const defs = await this.defsOf(databaseId);
    const reason = await this.unchecked(rule, defs);
    if (reason) {
      throw new UnprocessableEntityException(`This rule is NOT CHECKABLE, so there is no honest violation count to give (a count of 0 would read as "all clear"): ${reason}`);
    }
    const where = and(this.violationWhere(rule, defs), cursor ? gt(records.number, cursor) : undefined);
    const rows = await this.db
      .select({ id: records.id, number: records.number, title: records.title })
      .from(records)
      .where(where)
      .orderBy(asc(records.number))
      .limit(PAGE + 1);
    const page = rows.slice(0, PAGE);
    return {
      rule: { id: rule.id, name: rule.name },
      count: await this.violationCount(rule, defs),
      data: page,
      next_cursor: rows.length > PAGE ? page[page.length - 1]!.number : null,
    };
  }

  private async present(rule: ValidationRuleRow, defs: FieldDef[], violationCount: number | null) {
    const notCheckable = await this.unchecked(rule, defs);
    let transition: { field: string; to: string } | null = null;
    if (rule.transitionFieldId) {
      const def = defs.find((d) => d.id === rule.transitionFieldId);
      const option = def ? await this.db.query.selectOptions.findFirst({ where: eq(selectOptions.id, rule.transitionTo ?? '') }) : undefined;
      transition = { field: def?.api_name ?? '(deleted field)', to: option?.label ?? rule.transitionTo ?? '' };
    }
    return {
      id: rule.id,
      database_id: rule.databaseId,
      name: rule.name,
      trigger: rule.trigger,
      transition,
      condition: rule.condition,
      message: rule.message,
      enabled: rule.enabled,
      /** The rule names a field that no longer exists. (A subset of `not_checkable`, kept for clients that read it.) */
      dangling: ValidationEnforcer.isDangling(rule, defs),
      /**
       * Why the rule cannot be checked, or null. A rule that cannot be checked is SKIPPED on every write (it never locks
       * the database) and enforces nothing until fixed: it must not be read as protection.
       */
      not_checkable: notCheckable,
      /** What the rule is actually doing: `enforcing`, `disabled`, or `not_checkable` (enabled, but enforcing NOTHING). */
      status: !rule.enabled ? 'disabled' : notCheckable ? 'not_checkable' : 'enforcing',
      /** How many stored records break this rule right now (null when it cannot be checked: never a misleading 0). */
      violation_count: violationCount,
      created_by: rule.createdBy,
      created_at: rule.createdAt,
    };
  }
}
