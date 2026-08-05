import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { CreatableFieldType, FilterNode, FormulaFieldInfo, FormulaType, SystemFieldType } from '@storyos/schemas';
import { activeFilter, FormulaError, formulaRefs, parseFormula, SYSTEM_FIELDS, titleConfigSchema, typecheck } from '@storyos/schemas';
import { DB } from '../db/db.module';
import type { Db } from '../db/client';
import { fields, records, relations, selectOptions } from '../db/schema';
import { slugify } from '../databases/databases.service';
import { presentFieldConfig, restoreFieldConfig } from '../common/webhook-headers';
import { RecordsService } from '../records/records.service';
import { compileFilter } from '../records/query-compiler';
import type { CompilerContext } from '../records/query-compiler';

type Field = typeof fields.$inferSelect;

/** Allowed type conversions — docs/architecture/record-storage.md (field lifecycle). */
const CONVERTIBLE: Record<string, CreatableFieldType[]> = {
  text: ['number', 'date', 'rich_text'],
  rich_text: ['text'],
  number: ['text'],
  checkbox: ['text'],
  date: ['text'],
  // #172: workflow is single-select-shaped, so it round-trips with select/multi_select
  // (option ids are preserved on select↔workflow) and degrades to text.
  select: ['text', 'multi_select', 'workflow'],
  multi_select: ['text', 'select', 'workflow'],
  workflow: ['text', 'select', 'multi_select'],
  url: ['text', 'email'],
  email: ['text', 'url'],
  user: [],
};

/** #172: field types that carry coloured select_options (single- or multi-valued). */
const OPTIONED_FIELD_TYPES = new Set(['select', 'multi_select', 'workflow']);

/** Plain text of a BlockNote document (lossy rich_text → text). */
function richTextToPlain(blocks: unknown): string {
  const out: string[] = [];
  const walk = (nodes: unknown[]) => {
    for (const node of nodes) {
      if (typeof node !== 'object' || node === null) continue;
      const block = node as { content?: unknown; children?: unknown[]; text?: unknown };
      if (typeof block.text === 'string') out.push(block.text);
      if (Array.isArray(block.content)) walk(block.content);
      if (Array.isArray(block.children)) walk(block.children);
    }
  };
  if (Array.isArray(blocks)) walk(blocks);
  return out.join(' ').trim();
}

/** MN-295: finds a "me"-valued condition on a user/created_by field anywhere in a
 * filter tree, or undefined if there isn't one. Returns the offending field's api_name. */
function findMeReference(node: FilterNode, ctx: CompilerContext): string | undefined {
  if ('and' in node) return node.and.map((n) => findMeReference(n, ctx)).find((f) => f !== undefined);
  if ('or' in node) return node.or.map((n) => findMeReference(n, ctx)).find((f) => f !== undefined);
  const def = ctx.defs.get(node.field);
  if (!def || (def.type !== 'user' && def.type !== 'created_by')) return undefined;
  const usesMe = node.value === 'me' || (Array.isArray(node.value) && node.value.includes('me'));
  return usesMe ? node.field : undefined;
}

@Injectable()
export class FieldsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly recordsService: RecordsService,
  ) {}

  async getField(databaseId: string, fieldId: string): Promise<Field> {
    const field = await this.db.query.fields.findFirst({
      where: and(eq(fields.id, fieldId), eq(fields.databaseId, databaseId), isNull(fields.deletedAt)),
    });
    if (!field) throw new NotFoundException('Field not found');
    return field;
  }

  private async uniqueApiName(databaseId: string, displayName: string): Promise<string> {
    const root = slugify(displayName);
    const taken = new Set(
      (
        await this.db.query.fields.findMany({
          where: eq(fields.databaseId, databaseId), // includes soft-deleted: api_name unique index covers them
          columns: { apiName: true },
        })
      ).map((f) => f.apiName),
    );
    for (let i = 0; ; i++) {
      const candidate = i === 0 ? root : `${root}_${i + 1}`;
      if (!taken.has(candidate)) return candidate;
    }
  }

  /** Count of live records carrying a value for this field. */
  async usageCount(databaseId: string, fieldId: string): Promise<number> {
    const [row] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(records)
      .where(
        and(
          eq(records.databaseId, databaseId),
          isNull(records.deletedAt),
          sql`${records.values} ? ${fieldId}`,
        ),
      );
    return row?.count ?? 0;
  }

  /**
   * MN-212: display-name uniqueness within a database (case-insensitive, trimmed).
   * apiName was always unique; the display NAME wasn't, so two fields could render
   * the same label on a card. A user-typed name is hard-blocked — never silently
   * suffixed. Soft-deleted fields don't count (their label is gone from the UI).
   */
  async assertUniqueDisplayName(databaseId: string, displayName: string, excludeFieldId?: string) {
    const existing = await this.db.query.fields.findMany({
      where: and(eq(fields.databaseId, databaseId), isNull(fields.deletedAt)),
      columns: { id: true, displayName: true },
    });
    const wanted = displayName.trim().toLowerCase();
    const clash = existing.find(
      (f) => f.id !== excludeFieldId && f.displayName.trim().toLowerCase() === wanted,
    );
    if (clash) {
      throw new UnprocessableEntityException(
        `A field named "${displayName.trim()}" already exists in this database`,
      );
    }
  }

  /**
   * #172: enforce "at most one Workflow (canonical status) field per database".
   * Called on create AND on change-type-to-workflow; `excludeFieldId` lets a
   * field being converted ignore itself. Soft-deleted fields don't count.
   */
  async assertNoExistingWorkflowField(databaseId: string, excludeFieldId?: string) {
    const existing = await this.db.query.fields.findFirst({
      where: and(
        eq(fields.databaseId, databaseId),
        eq(fields.type, 'workflow'),
        isNull(fields.deletedAt),
      ),
      columns: { id: true },
    });
    if (existing && existing.id !== excludeFieldId) {
      throw new ConflictException('This database already has a Workflow field');
    }
  }

  async create(
    databaseId: string,
    input: {
      display_name: string;
      type: CreatableFieldType;
      config?: Record<string, unknown>;
      options?: Array<{ label: string; color?: string; icon?: string | null }>; // #202
    },
  ) {
    await this.assertUniqueDisplayName(databaseId, input.display_name);
    // #172: a database is allowed at most one Workflow (canonical status) field.
    if (input.type === 'workflow') await this.assertNoExistingWorkflowField(databaseId);
    if (input.type === 'lookup') await this.assertLookupConfig(databaseId, input.config ?? {});
    if (input.type === 'rollup') await this.assertRollupConfig(databaseId, input.config ?? {});
    // MN-129: resolve the api_name before compiling, so a formula field can be
    // guarded against referencing its own (about-to-exist) field.
    const apiName = await this.uniqueApiName(databaseId, input.display_name);
    if (input.type === 'formula') {
      input.config = await this.compileFormulaConfig(databaseId, input.config ?? {}, apiName);
    }
    // No prior config to preserve against on create — this only strips any stray
    // presence flags so a `{ __keep: true }` never lands in storage (#249).
    const config = restoreFieldConfig(input.config ?? {}, {});
    const siblings = await this.db.query.fields.findMany({
      where: and(eq(fields.databaseId, databaseId), eq(fields.isSystem, false)),
      columns: { position: true },
    });
    const position = Math.max(0, ...siblings.map((f) => f.position)) + 1;

    const created = await this.db.transaction(async (tx) => {
      const [field] = await tx
        .insert(fields)
        .values({
          databaseId,
          displayName: input.display_name,
          apiName,
          type: input.type,
          config,
          position,
        })
        .returning();

      if (OPTIONED_FIELD_TYPES.has(input.type) && input.options && input.options.length > 0) {
        await tx.insert(selectOptions).values(
          input.options.map((option, i) => ({
            fieldId: field!.id,
            label: option.label,
            color: option.color ?? 'gray',
            icon: option.icon ?? null, // #202
            position: i,
          })),
        );
      }
      return this.withOptions(tx as unknown as Db, field!);
    });
    await this.backfillFormulaField(databaseId, created);
    await this.backfillRollupField(databaseId, created);
    return created;
  }

  /**
   * MN-260: a formula field is only useful for sorting once existing records
   * carry a materialized value, not just ones written after the field existed
   * — without this, "add a formula field, sort by it" would show every
   * pre-existing record as an empty sort value until it was next touched.
   * Best-effort/isolated: never fails the field-create response the caller is
   * waiting on. No-ops for a field that isn't a same-record-only formula
   * (materializeFormulaFieldForAllRecords checks the type; the sortability gate
   * itself lives in RecordsService.query's SORTABLE check).
   */
  private async backfillFormulaField(databaseId: string, field: { id: string; type: string }): Promise<void> {
    if (field.type !== 'formula') return;
    await this.recordsService.materializeFormulaFieldForAllRecords(databaseId, field.id).catch(() => undefined);
  }

  /**
   * MN-267: same reasoning as backfillFormulaField, for a newly-created rollup
   * field — without this, "add a rollup field, sort by it" would show every
   * pre-existing record as null until its relation next changed.
   * Best-effort/isolated: never fails the field-create response.
   */
  private async backfillRollupField(databaseId: string, field: { id: string; type: string }): Promise<void> {
    if (field.type !== 'rollup') return;
    await this.recordsService.recomputeRollupFieldForAllRecords(databaseId, field.id).catch(() => undefined);
  }

  /** Field types a formula may reference, mapped to formula types. */
  static formulaTypeOf(type: string): FormulaType | null {
    // MN-129: `id` is the record's sequential public #id (records.number) — a
    // plain number, so `"#" + format({Number})`-style name templates compose.
    if (type === 'number' || type === 'rollup' || type === 'id') return 'number';
    if (type === 'checkbox') return 'checkbox';
    if (type === 'date' || type === 'created_at' || type === 'updated_at') return 'date';
    if (['text', 'title', 'select', 'workflow', 'url', 'email', 'lookup'].includes(type)) return 'text';
    if (type === 'formula') return null; // resolved per-field from its result_type
    return null;
  }

  /**
   * MN-129: formula type for a purely-synthetic system field (one with no stored
   * `fields` row, e.g. the canonical `number` handle). Reuses formulaTypeOf on the
   * compiler type so `number`/`id` land as numbers and the date system fields as
   * dates; `created_by`/`updated_by` (user) stay unreferenceable (no clean scalar).
   */
  static systemFieldFormulaType(type: SystemFieldType): FormulaType | null {
    if (type === 'created_by' || type === 'updated_by') return null;
    return FieldsService.formulaTypeOf(type);
  }

  /**
   * MN-043: parse + typecheck + cycle-check; stores {expression, ast, result_type}.
   *
   * MN-129: `selfApiName` is the api_name of the field this formula is being
   * attached to. It powers the self-reference guard — a formula must not
   * reference its own field, or it forms an infinite cycle (the formula's output
   * feeds the field, which feeds the formula…). This matters for computed Names
   * (#130), which put a formula ON the title field: `{Name}` would otherwise
   * resolve to that very field. The referenceable set also now includes the
   * record's public number and the other purely-synthetic system fields that
   * have no stored `fields` row.
   */
  private async compileFormulaConfig(
    databaseId: string,
    config: Record<string, unknown>,
    selfApiName?: string,
  ) {
    const expression = String(config['expression'] ?? '');
    const live = await this.db.query.fields.findMany({
      where: and(eq(fields.databaseId, databaseId), isNull(fields.deletedAt)),
    });
    const infos: FormulaFieldInfo[] = [];
    for (const f of live) {
      if (f.type === 'formula') {
        const rt = (f.config as { result_type?: string }).result_type;
        if (rt) infos.push({ api_name: f.apiName, display_name: f.displayName, formula_type: rt as never });
        continue;
      }
      const ft = FieldsService.formulaTypeOf(f.type);
      if (ft) infos.push({ api_name: f.apiName, display_name: f.displayName, formula_type: ft });
    }
    // MN-129: additive system fields with no stored row (e.g. the canonical
    // `number` handle for the sequential #id). A real field row of the same
    // api_name always wins, so a user field literally named `number` is unaffected.
    for (const spec of SYSTEM_FIELDS) {
      if (infos.some((i) => i.api_name === spec.api_name)) continue;
      const ft = FieldsService.systemFieldFormulaType(spec.type);
      if (ft) infos.push({ api_name: spec.api_name, display_name: spec.display_name, formula_type: ft });
    }
    // MN-129: make the field's own name resolvable even if it has no row yet (a
    // brand-new formula field), so a self-reference produces the dedicated guard
    // error below rather than a bare "unknown field".
    if (selfApiName && !infos.some((i) => i.api_name === selfApiName)) {
      infos.push({ api_name: selfApiName, display_name: selfApiName, formula_type: 'text' });
    }
    let ast;
    let resultType;
    try {
      ast = parseFormula(expression, infos);
      resultType = typecheck(ast, infos);
    } catch (error) {
      if (error instanceof FormulaError) throw new UnprocessableEntityException(`Formula error: ${error.message}`);
      throw error;
    }
    // MN-129: self-reference guard — reject before storing an AST that would cycle.
    if (selfApiName && formulaRefs(ast).includes(selfApiName)) {
      throw new UnprocessableEntityException(
        'A formula cannot reference its own field — it would create a cycle',
      );
    }
    if (resultType === 'null') resultType = 'text';

    // Cycle check: walking refs into other formulas must terminate within depth 5.
    const formulaByApi = new Map(live.filter((f) => f.type === 'formula').map((f) => [f.apiName, f]));
    const visit = (refs: string[], depth: number): void => {
      if (depth > 5) throw new UnprocessableEntityException('Formula chains are limited to 5 levels');
      for (const ref of refs) {
        const target = formulaByApi.get(ref);
        if (!target) continue;
        const targetAst = (target.config as { ast?: unknown }).ast;
        if (targetAst) visit(formulaRefs(targetAst as never), depth + 1);
      }
    };
    visit(formulaRefs(ast), 1);

    return { expression, ast, result_type: resultType };
  }

  /** Types a lookup can surface — no chains (lookup-of-lookup) or nested relations in v1. */
  private static readonly LOOKUPABLE = new Set([
    'title', 'text', 'number', 'checkbox', 'date', 'select', 'multi_select', 'workflow', 'url', 'email',
  ]);

  /** Resolves the related database behind a relation field of THIS database, or 422s. */
  private async resolveRelationTargetDb(databaseId: string, relationFieldId: string | undefined): Promise<string> {
    const relationField = relationFieldId
      ? await this.db.query.fields.findFirst({
          where: and(eq(fields.id, relationFieldId), eq(fields.databaseId, databaseId), isNull(fields.deletedAt)),
        })
      : undefined;
    if (!relationField || relationField.type !== 'relation') {
      throw new UnprocessableEntityException('relation_field_id must be a relation field of this database');
    }
    const relConfig = relationField.config as { relation_id: string; side: 'a' | 'b' };
    const relation = await this.db.query.relations.findFirst({ where: eq(relations.id, relConfig.relation_id) });
    if (!relation) throw new UnprocessableEntityException('The underlying relation no longer exists');
    return relConfig.side === 'a' ? relation.databaseBId : relation.databaseAId;
  }

  /** MN-040: the relation must live on this database; the target field on the related one. */
  private async assertLookupConfig(databaseId: string, config: Record<string, unknown>) {
    const targetApiName = config['target_field_api_name'] as string | undefined;
    const targetDbId = await this.resolveRelationTargetDb(databaseId, config['relation_field_id'] as string | undefined);
    const targetField = await this.db.query.fields.findFirst({
      where: and(eq(fields.databaseId, targetDbId), eq(fields.apiName, targetApiName ?? ''), isNull(fields.deletedAt)),
    });
    if (!targetField) {
      throw new UnprocessableEntityException('target_field_api_name does not exist on the related database');
    }
    if (!FieldsService.LOOKUPABLE.has(targetField.type)) {
      throw new UnprocessableEntityException(`Cannot look up ${targetField.type} fields`);
    }
  }

  static readonly ROLLUP_OPS = new Set(['count', 'sum', 'avg', 'min', 'max']);

  /**
   * MN-064: count needs no target; sum/avg/min/max aggregate a NUMBER field on
   * the related database. MN-295: an optional `filter` (the same AST used for
   * saved views / POST /records/query) is validated against the RELATED
   * database's live fields — reusing query-compiler's compileFilter() itself
   * as the validator (its `err()` throws are already the right shape for a
   * config 422), rather than re-implementing field/op/option-id checks here.
   */
  private async assertRollupConfig(databaseId: string, config: Record<string, unknown>) {
    const op = config['op'] as string | undefined;
    if (!op || !FieldsService.ROLLUP_OPS.has(op)) {
      throw new UnprocessableEntityException('rollup op must be one of count, sum, avg, min, max');
    }
    const targetApiName = config['target_field_api_name'] as string | undefined | null;
    const targetDbId = await this.resolveRelationTargetDb(databaseId, config['relation_field_id'] as string | undefined);
    if (op !== 'count' || targetApiName) {
      if (!targetApiName) {
        throw new UnprocessableEntityException(`rollup op "${op}" needs a target_field_api_name`);
      }
      const targetField = await this.db.query.fields.findFirst({
        where: and(eq(fields.databaseId, targetDbId), eq(fields.apiName, targetApiName), isNull(fields.deletedAt)),
      });
      if (!targetField) {
        throw new UnprocessableEntityException('target_field_api_name does not exist on the related database');
      }
      if (op !== 'count' && targetField.type !== 'number') {
        throw new UnprocessableEntityException(`rollup "${op}" aggregates number fields, not ${targetField.type}`);
      }
    }

    const filter = config['filter'] as FilterNode | undefined;
    if (filter) await this.assertRollupFilter(targetDbId, filter);
  }

  /** MN-295: compiles the rollup's filter against the related database's fields, purely
   * for validation — the resulting SQL is discarded here; the real evaluation happens in
   * RecordsService (attachRollups / computeRollupValuesForChunk) at read/recompute time. */
  private async assertRollupFilter(targetDbId: string, filter: FilterNode) {
    const targetDefs = await this.recordsService.fieldDefs(targetDbId);
    const ctx: CompilerContext = {
      defs: new Map(targetDefs.map((d) => [d.api_name, d])),
      currentUserId: '',
    };
    const pruned = activeFilter(filter);
    if (!pruned) return; // every condition disabled — same as no filter

    // A rollup's aggregate is materialized once and shared across every viewer
    // (RecordsService.recomputeRollupsForRelationField), not recomputed per
    // request — so a "me" value (which view/query filters resolve against
    // whichever user is asking) has no well-defined meaning here. Reject it
    // explicitly rather than silently resolving "me" against a placeholder.
    const meField = findMeReference(pruned, ctx);
    if (meField) {
      throw new UnprocessableEntityException(
        `rollup filter on "${meField}" cannot use "me" — rollups are materialized once and shared across every viewer, not scoped per-viewer`,
      );
    }

    compileFilter(pruned, ctx);
  }

  /** Soft-delete lookups AND rollups that point at a deleted target field or severed relation field. */
  async removeDependentLookups(db: Db, opts: { relationFieldIds?: string[]; targetField?: Field }) {
    const lookups = await db.query.fields.findMany({
      where: and(inArray(fields.type, ['lookup', 'rollup']), isNull(fields.deletedAt)),
    });
    const doomed: string[] = [];
    for (const lookup of lookups) {
      const config = lookup.config as { relation_field_id?: string; target_field_api_name?: string };
      if (opts.relationFieldIds?.includes(config.relation_field_id ?? '')) doomed.push(lookup.id);
      if (opts.targetField && config.target_field_api_name === opts.targetField.apiName) {
        // Same api_name may exist elsewhere; confirm the relation actually points at the target's db.
        const relationField = await db.query.fields.findFirst({
          where: eq(fields.id, config.relation_field_id ?? ''),
        });
        const relConfig = relationField?.config as { relation_id?: string; side?: 'a' | 'b' } | undefined;
        if (!relConfig?.relation_id) continue;
        const relation = await db.query.relations.findFirst({ where: eq(relations.id, relConfig.relation_id) });
        if (!relation) continue;
        const targetDbId = relConfig.side === 'a' ? relation.databaseBId : relation.databaseAId;
        if (targetDbId === opts.targetField.databaseId) doomed.push(lookup.id);
      }
    }
    if (doomed.length) {
      await db.update(fields).set({ deletedAt: new Date() }).where(inArray(fields.id, doomed));
    }
    return doomed.length;
  }

  private async withOptions(db: Db, field: Field) {
    // Never let a stored secret webhook header value leave in a button's config (#249).
    const presented = { ...field, config: presentFieldConfig(field.config) };
    if (!OPTIONED_FIELD_TYPES.has(presented.type)) return presented;
    const options = await db.query.selectOptions.findMany({
      where: eq(selectOptions.fieldId, presented.id),
      orderBy: [asc(selectOptions.position)],
    });
    return { ...presented, options };
  }

  async update(
    databaseId: string,
    fieldId: string,
    patch: { display_name?: string; config?: Record<string, unknown>; position?: number },
  ) {
    const field = await this.getField(databaseId, fieldId);
    // A system field's schema (name, type, position) is fixed — but its per-view
    // LAYOUT config is not schema. The record page needs to toggle entity_zones /
    // entity_hidden on the audit fields to show them (MN-126), so allow a
    // config-only patch on system fields while still refusing name/position edits.
    if (field.isSystem) {
      if (patch.display_name !== undefined || patch.position !== undefined) {
        throw new UnprocessableEntityException('System fields cannot be renamed or reordered');
      }
      if (!patch.config) return this.withOptions(this.db, field);
      // Resolve write-only header presence flags against the stored config so an
      // unrelated edit can't clobber a secret webhook header to a sentinel (#249).
      const restored = restoreFieldConfig(patch.config, field.config);
      const [updated] = await this.db
        .update(fields)
        .set({ config: { ...(field.config as object), ...restored } })
        .where(eq(fields.id, fieldId))
        .returning();
      return this.withOptions(this.db, updated!);
    }

    if (patch.display_name !== undefined) {
      await this.assertUniqueDisplayName(databaseId, patch.display_name, fieldId);
    }
    // MN-130: the title field's config is a computed-name descriptor, not a merge
    // target — `freetext` must fully clear a prior template, and `computed`
    // compiles `source` into a fresh {ast, result_type}. Replace it wholesale
    // (instead of the shallow merge the generic path does), and backfill every
    // record's title when the resulting mode is `computed` (or the template
    // changed) so existing rows aren't left on their old names.
    let backfillTitles = false;
    let nextConfig: object | undefined;
    if (field.type === 'title' && patch.config !== undefined) {
      nextConfig = await this.compileTitleConfig(databaseId, field, patch.config);
      backfillTitles = (nextConfig as { name_mode?: string }).name_mode === 'computed';
    } else {
      const restored = patch.config ? restoreFieldConfig(patch.config, field.config) : undefined;
      nextConfig = restored ? { ...(field.config as object), ...restored } : undefined;
    }
    const [updated] = await this.db
      .update(fields)
      .set({
        displayName: patch.display_name,
        config: nextConfig,
        position: patch.position,
      })
      .where(eq(fields.id, fieldId))
      .returning();
    // Best-effort/isolated (mirrors backfillFormulaField): a large-DB rename must
    // never fail the config-save the caller is waiting on. Chunked internally.
    if (backfillTitles) {
      await this.recordsService.recomputeTitlesForAllRecords(databaseId).catch(() => undefined);
    }
    return this.withOptions(this.db, updated!);
  }

  /**
   * MN-130: validate + compile a title field's computed-name config. `freetext`
   * stores the bare mode (clearing any prior template). `computed` compiles the
   * `source` template through the SAME formula path formula fields use
   * (compileFormulaConfig, passing the title's own api_name as `selfApiName` so a
   * `{Name}` self-reference is rejected as a cycle), then restricts which
   * cross-record references it may make — see assertTitleRefs (#132: lookup/rollup
   * allowed, direct relation traversal still rejected).
   */
  private async compileTitleConfig(
    databaseId: string,
    field: Field,
    config: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const parsed = titleConfigSchema.safeParse(config);
    if (!parsed.success) {
      throw new UnprocessableEntityException(`Title config error: ${parsed.error.issues[0]?.message}`);
    }
    if (parsed.data.name_mode !== 'computed') return { name_mode: 'freetext' };
    const source = (parsed.data.source ?? '').trim();
    if (!source) {
      throw new UnprocessableEntityException('A computed name needs a template expression');
    }
    const compiled = await this.compileFormulaConfig(databaseId, { expression: source }, field.apiName);
    await this.assertTitleRefs(databaseId, compiled.ast);
    return {
      name_mode: 'computed',
      source: compiled.expression,
      ast: compiled.ast,
      result_type: compiled.result_type,
    };
  }

  /**
   * #132: which cross-record references a computed name may make.
   *
   * A `lookup`/`rollup` field already MATERIALIZES a related record's value ONTO
   * this record (attachLookups/attachRollups), so referencing it is still an
   * own-record read at title-compute time — allowed, and kept live by the
   * reactive recompute (RecordsService.recomputeTitlesForRecords, hung off the
   * MN-267 invalidation path). A direct `relation` traversal (`{Assignee}.{Name}`)
   * is different: it reaches THROUGH the relation into fields we don't hold, and
   * is deferred to #145 — so relation refs are still rejected here. (Relation
   * fields carry no formula type either, so a bare `{Assignee}` already fails to
   * compile; this guard is the explicit, friendly rejection for the case that
   * does resolve.)
   */
  private async assertTitleRefs(databaseId: string, ast: unknown): Promise<void> {
    const live = await this.db.query.fields.findMany({
      where: and(eq(fields.databaseId, databaseId), isNull(fields.deletedAt)),
    });
    const byApi = new Map(live.map((f) => [f.apiName, f]));
    for (const ref of formulaRefs(ast as never)) {
      const target = byApi.get(ref);
      if (target && target.type === 'relation') {
        throw new UnprocessableEntityException(
          `A computed name can't traverse a relation directly — "${target.displayName}" is a relation field. Reference a lookup or rollup of it instead (direct relation traversal isn't supported yet)`,
        );
      }
    }
  }

  /** Soft delete (B6). Title/system fields are protected; relation fields belong to MN-018. */
  async remove(databaseId: string, fieldId: string) {
    const field = await this.getField(databaseId, fieldId);
    if (field.type === 'title') throw new UnprocessableEntityException('The title field cannot be deleted');
    if (field.isSystem) throw new UnprocessableEntityException('System fields cannot be deleted');
    if (field.type === 'relation') {
      throw new UnprocessableEntityException('Delete relation fields via the relations API');
    }
    const recordsWithValue = await this.usageCount(databaseId, fieldId);
    await this.db.update(fields).set({ deletedAt: new Date() }).where(eq(fields.id, fieldId));
    const lookupsRemoved = await this.removeDependentLookups(this.db, { targetField: field });
    return { deleted: true, records_with_value: recordsWithValue, lookups_removed: lookupsRemoved };
  }

  /**
   * Type change within the compatibility matrix. dry_run returns the lossy
   * count without applying. Conversion runs in one transaction (per-row —
   * fine at v1 scale, documented in record-storage.md).
   */
  async changeType(databaseId: string, fieldId: string, targetType: CreatableFieldType, dryRun: boolean) {
    const field = await this.getField(databaseId, fieldId);
    if (field.isSystem || field.type === 'title' || field.type === 'relation') {
      throw new UnprocessableEntityException(`Type of ${field.type} fields cannot be changed`);
    }
    if (field.type === targetType) throw new BadRequestException('Field already has this type');
    // #172: converting a field INTO workflow is subject to the one-per-database rule.
    if (targetType === 'workflow') await this.assertNoExistingWorkflowField(databaseId, fieldId);
    if (!CONVERTIBLE[field.type]?.includes(targetType)) {
      throw new UnprocessableEntityException(
        `Cannot convert ${field.type} → ${targetType}. Allowed: ${(CONVERTIBLE[field.type] ?? []).join(', ') || 'none'}. Delete and recreate the field instead.`,
      );
    }

    const optionLabels = new Map(
      (
        await this.db.query.selectOptions.findMany({ where: eq(selectOptions.fieldId, fieldId) })
      ).map((o) => [o.id, o.label]),
    );

    const rows = await this.db.query.records.findMany({
      where: and(
        eq(records.databaseId, databaseId),
        isNull(records.deletedAt),
        sql`${records.values} ? ${fieldId}`,
      ),
      columns: { id: true, values: true },
    });

    let lossy = 0;
    const updates: Array<{ id: string; value: unknown }> = [];
    for (const row of rows) {
      const current = (row.values as Record<string, unknown>)[fieldId];
      const { value, lost } = convertValue(current, field.type, targetType, optionLabels);
      if (lost) lossy++;
      updates.push({ id: row.id, value });
    }

    if (dryRun) {
      return { dry_run: true, records_affected: rows.length, lossy_conversions: lossy };
    }

    await this.db.transaction(async (tx) => {
      for (const u of updates) {
        await tx
          .update(records)
          .set({
            values:
              u.value === null
                ? sql`${records.values} - ${fieldId}::text`
                : sql`jsonb_set(${records.values}, ${`{${fieldId}}`}::text[], ${JSON.stringify(u.value)}::jsonb)`,
          })
          .where(eq(records.id, u.id));
      }
      await tx.update(fields).set({ type: targetType, config: {} }).where(eq(fields.id, fieldId));
      // #172: options survive any conversion between optioned types (select ↔
      // multi_select ↔ workflow); they're only dropped when leaving that family.
      if (OPTIONED_FIELD_TYPES.has(field.type) && !OPTIONED_FIELD_TYPES.has(targetType)) {
        await tx.delete(selectOptions).where(eq(selectOptions.fieldId, fieldId));
      }
    });

    return { dry_run: false, records_affected: rows.length, lossy_conversions: lossy };
  }

  // --- Select options ---

  private async assertSelectField(databaseId: string, fieldId: string) {
    const field = await this.getField(databaseId, fieldId);
    // #172: workflow uses the same option CRUD endpoints as select/multi_select.
    if (!OPTIONED_FIELD_TYPES.has(field.type)) {
      throw new UnprocessableEntityException('Not a select field');
    }
    return field;
  }

  async addOption(databaseId: string, fieldId: string, input: { label: string; color: string; icon?: string | null }) {
    await this.assertSelectField(databaseId, fieldId);
    const existing = await this.db.query.selectOptions.findMany({
      where: eq(selectOptions.fieldId, fieldId),
      columns: { position: true },
    });
    const [option] = await this.db
      .insert(selectOptions)
      .values({
        fieldId,
        label: input.label,
        color: input.color,
        icon: input.icon ?? null, // #202
        position: Math.max(-1, ...existing.map((o) => o.position)) + 1,
      })
      .returning();
    return option!;
  }

  async updateOption(
    databaseId: string,
    fieldId: string,
    optionId: string,
    // #202: `icon: null` clears it; `undefined` leaves it unchanged (Drizzle skips undefined).
    patch: { label?: string; color?: string; icon?: string | null; position?: number },
  ) {
    await this.assertSelectField(databaseId, fieldId);
    const [option] = await this.db
      .update(selectOptions)
      .set(patch)
      .where(and(eq(selectOptions.id, optionId), eq(selectOptions.fieldId, fieldId)))
      .returning();
    if (!option) throw new NotFoundException('Option not found');
    return option;
  }

  /** Option delete: 409 with usage count unless confirmed (B5). */
  async removeOption(
    databaseId: string,
    fieldId: string,
    optionId: string,
    input: { confirm: boolean; reassign_to?: string },
  ) {
    const field = await this.assertSelectField(databaseId, fieldId);
    const option = await this.db.query.selectOptions.findFirst({
      where: and(eq(selectOptions.id, optionId), eq(selectOptions.fieldId, fieldId)),
    });
    if (!option) throw new NotFoundException('Option not found');

    const usage = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(records)
      .where(
        and(
          eq(records.databaseId, databaseId),
          isNull(records.deletedAt),
          field.type !== 'multi_select'
            ? sql`${records.values}->>${fieldId} = ${optionId}`
            : sql`${records.values}->${fieldId} ? ${optionId}`,
        ),
      );
    const count = usage[0]?.count ?? 0;

    if (count > 0 && !input.confirm) {
      throw new ConflictException(`Option is used by ${count} record(s). Pass confirm: true to clear.`);
    }

    await this.db.transaction(async (tx) => {
      if (count > 0) {
        if (field.type !== 'multi_select') {
          await tx
            .update(records)
            .set({
              values: input.reassign_to
                ? sql`jsonb_set(${records.values}, ${`{${fieldId}}`}::text[], ${JSON.stringify(input.reassign_to)}::jsonb)`
                : sql`${records.values} - ${fieldId}::text`,
            })
            .where(and(eq(records.databaseId, databaseId), sql`${records.values}->>${fieldId} = ${optionId}`));
        } else {
          await tx
            .update(records)
            .set({
              values: input.reassign_to
                ? sql`jsonb_set(${records.values}, ${`{${fieldId}}`}::text[], (${records.values}->${fieldId}) - ${optionId} || ${JSON.stringify([input.reassign_to])}::jsonb)`
                : sql`jsonb_set(${records.values}, ${`{${fieldId}}`}::text[], (${records.values}->${fieldId}) - ${optionId})`,
            })
            .where(and(eq(records.databaseId, databaseId), sql`${records.values}->${fieldId} ? ${optionId}`));
        }
      }
      await tx.delete(selectOptions).where(eq(selectOptions.id, optionId));
    });

    return { deleted: true, records_cleared: input.reassign_to ? 0 : count };
  }
}

function convertValue(
  value: unknown,
  from: string,
  to: CreatableFieldType,
  optionLabels: Map<string, string>,
): { value: unknown; lost: boolean } {
  if (value === null || value === undefined) return { value: null, lost: false };

  if (to === 'rich_text' && from === 'text') {
    const text = String(value);
    return {
      value: [{ type: 'paragraph', content: [{ type: 'text', text, styles: {} }] }],
      lost: false,
    };
  }
  if (to === 'text') {
    if (from === 'rich_text') {
      const text = richTextToPlain(value);
      return { value: text || null, lost: text.length === 0 };
    }
    // #172: workflow → text degrades through the option label, same as select.
    if (from === 'select' || from === 'workflow') {
      return { value: optionLabels.get(String(value)) ?? null, lost: !optionLabels.has(String(value)) };
    }
    if (from === 'multi_select') {
      const labels = (value as string[]).map((id) => optionLabels.get(id)).filter(Boolean);
      return { value: labels.join(', '), lost: labels.length !== (value as string[]).length };
    }
    return { value: String(value), lost: false };
  }
  if (to === 'number') {
    const n = Number.parseFloat(String(value).replace(/,/g, '.'));
    return Number.isFinite(n) ? { value: n, lost: false } : { value: null, lost: true };
  }
  if (to === 'date') {
    const ms = Date.parse(String(value));
    return Number.isNaN(ms)
      ? { value: null, lost: true }
      : { value: new Date(ms).toISOString().slice(0, 10), lost: false };
  }
  // #172: select ↔ workflow keep the SAME option id (options are preserved), so
  // the value passes straight through with no loss.
  if ((to === 'select' && from === 'workflow') || (to === 'workflow' && from === 'select')) {
    return { value, lost: false };
  }
  if (to === 'multi_select' && (from === 'select' || from === 'workflow')) return { value: [value], lost: false };
  if ((to === 'select' || to === 'workflow') && from === 'multi_select') {
    const arr = value as string[];
    return { value: arr[0] ?? null, lost: arr.length > 1 };
  }
  if ((to === 'url' && from === 'email') || (to === 'email' && from === 'url')) {
    return { value: String(value), lost: false };
  }
  return { value: null, lost: true };
}
