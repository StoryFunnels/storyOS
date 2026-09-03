import { Inject, Injectable, UnprocessableEntityException } from '@nestjs/common';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { DB } from '../db/db.module';
import type { Db } from '../db/client';
import { fields, selectOptions } from '../db/schema';
import { notDeleted } from '../db/soft-delete';
import { DatabasesService } from '../databases/databases.service';
import { RecordsService } from '../records/records.service';
import { RelationsService } from '../relations/relations.service';
import { ChunkedApplyService } from '../migration-framework/chunked-apply.service';
import { RelationLinkerService } from '../migration-framework/relation-linker.service';
import { DryRunBuilder } from '../migration-framework/dry-run';
import { StoryosSourceAdapter } from '../migration-framework/storyos-source-adapter';
import { blockingFields, isEmptyValue, planField } from '../migration-framework/copy-mapping';
import type { DestinationField, FieldPlan } from '../migration-framework/copy-mapping';
import { buildLabelIndex, pickOption } from '../migration-framework/select-options';
import type { Membership } from '../workspaces/workspace-access.guard';

export interface CopyRecordInput {
  /** #521/#435 — a list from day one: one record and a bulk selection travel
   * the identical path, per StoryosSourceAdapter's own contract. */
  recordIds: string[];
  targetDatabaseId: string;
  /** Source field api_names the caller explicitly skips (resolves a blocking field). */
  skip?: string[];
  dryRun: boolean;
}

interface LiveField {
  id: string;
  apiName: string;
  displayName: string;
  type: string;
  options?: Array<{ id: string; label: string }>;
}

/**
 * #521 — wires #431's StoryosSourceAdapter and #432's copy-mapping through the
 * shared map -> dry-run -> chunked-apply pipeline (ADR-0013) for a copy-record
 * operation, plus the rollback #433's AC8 asks for (ChunkedApplyService has
 * none of its own; import.service.ts's #372 pattern is reimplemented here
 * rather than shared, since nothing generic exists to inherit from).
 */
@Injectable()
export class CopyRecordService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly databases: DatabasesService,
    private readonly records: RecordsService,
    private readonly relations: RelationsService,
    private readonly chunkedApply: ChunkedApplyService,
    private readonly relationLinker: RelationLinkerService,
  ) {}

  private async liveFields(databaseId: string): Promise<LiveField[]> {
    const rows = await this.db.query.fields.findMany({
      where: and(eq(fields.databaseId, databaseId), notDeleted(fields.deletedAt)),
    });
    const selectFieldIds = rows
      .filter((f) => f.type === 'select' || f.type === 'multi_select' || f.type === 'workflow')
      .map((f) => f.id);
    const options = selectFieldIds.length
      ? await this.db.query.selectOptions.findMany({
          where: inArray(selectOptions.fieldId, selectFieldIds),
          orderBy: [asc(selectOptions.position)],
        })
      : [];
    const optionsByField = new Map<string, Array<{ id: string; label: string }>>();
    for (const option of options) {
      const list = optionsByField.get(option.fieldId) ?? [];
      list.push({ id: option.id, label: option.label });
      optionsByField.set(option.fieldId, list);
    }
    return rows.map((f) => ({
      id: f.id,
      apiName: f.apiName,
      displayName: f.displayName,
      type: f.type,
      options: optionsByField.get(f.id),
    }));
  }

  /** fieldId -> the OTHER side's database id, for every relation touching `databaseId`. */
  private async relationTargets(databaseId: string): Promise<Map<string, string>> {
    const rows = await this.relations.forDatabase(databaseId);
    const out = new Map<string, string>();
    for (const r of rows) {
      if (r.databaseAId === databaseId) out.set(r.fieldAId, r.databaseBId);
      if (r.databaseBId === databaseId) out.set(r.fieldBId, r.databaseAId);
    }
    return out;
  }

  async run(membership: Membership, sourceDatabaseId: string, input: CopyRecordInput, actorId: string) {
    if (input.recordIds.length === 0) {
      throw new UnprocessableEntityException('record_ids must not be empty.');
    }

    // Destination: creating records needs contributor, same as RecordsController.create.
    // The SOURCE is checked by the adapter's own connect() (viewer minimum) below —
    // never duplicated here, so there's exactly one place source access is enforced.
    await this.databases.assertAccess(membership, input.targetDatabaseId, 'contributor');

    const adapter = new StoryosSourceAdapter(this.databases, this.records);
    await adapter.connect({ membership, databaseId: sourceDatabaseId, recordIds: input.recordIds });

    const [sourceFieldRows, targetFieldRows, sourceRelTargets, targetRelTargets] = await Promise.all([
      this.liveFields(sourceDatabaseId),
      this.liveFields(input.targetDatabaseId),
      this.relationTargets(sourceDatabaseId),
      this.relationTargets(input.targetDatabaseId),
    ]);
    const sourceByApiName = new Map(sourceFieldRows.map((f) => [f.apiName, f]));
    const destinations: DestinationField[] = targetFieldRows.map((f) => ({
      id: f.id,
      displayName: f.displayName,
      apiName: f.apiName,
      type: f.type,
      targetDatabaseId: targetRelTargets.get(f.id),
      options: f.options,
    }));
    const destById = new Map(destinations.map((d) => [d.id, d]));

    const schema = await adapter.readSchema();
    const sourceRecords = await adapter.readRecords();
    const sourceRelationLinks = await adapter.readRelations();
    const skip = new Set(input.skip ?? []);

    // Whether ANY record in THIS copy carries a value for a field — planField's
    // blocking rule is per-copy, not per-schema (an empty field never blocks).
    const hasValueByKey = new Map<string, boolean>();
    for (const field of schema) {
      const has =
        sourceRecords.some((r) => !isEmptyValue(r.fields[field.key])) ||
        sourceRelationLinks.some((l) => l.fieldKey === field.key);
      hasValueByKey.set(field.key, has);
    }

    const plans: FieldPlan[] = schema.map((field) => {
      const sourceField = sourceByApiName.get(field.key);
      const sourceTargetDatabaseId =
        sourceField?.type === 'relation' ? sourceRelTargets.get(sourceField.id) : undefined;
      return planField(field, destinations, {
        hasValue: hasValueByKey.get(field.key) ?? false,
        skipped: skip.has(field.key),
        sourceTargetDatabaseId,
      });
    });

    const report = new DryRunBuilder();
    report.willCreate = sourceRecords.length;
    for (const plan of blockingFields(plans)) report.addBlocking(plan.sourceKey, plan.reason!);
    if (sourceRecords[0]) report.addSample({ title: sourceRecords[0].title, ...sourceRecords[0].fields });
    const built = report.build();

    if (input.dryRun) {
      return { dry_run: true, plans, ...built };
    }
    if (report.isBlocked) {
      // Refuse, don't drop (#430) — never silently proceed past a field the
      // caller hasn't explicitly resolved (mapped it, or skipped it).
      throw new UnprocessableEntityException({
        message: `Copy refused: ${built.blocking!.length} field(s) have no destination and were not skipped.`,
        blocking: built.blocking,
      });
    }

    return this.commit(membership, input.targetDatabaseId, plans, destById, sourceFieldRows, sourceRecords, sourceRelationLinks, actorId);
  }

  private async commit(
    membership: Membership,
    targetDatabaseId: string,
    plans: FieldPlan[],
    destById: Map<string, DestinationField>,
    sourceFieldRows: LiveField[],
    sourceRecords: Awaited<ReturnType<StoryosSourceAdapter['readRecords']>>,
    sourceRelationLinks: Awaited<ReturnType<StoryosSourceAdapter['readRelations']>>,
    actorId: string,
  ) {
    const warnings: string[] = [];
    const sourceOptionLabelById = new Map<string, Map<string, string>>();
    for (const f of sourceFieldRows) {
      if (f.options?.length) sourceOptionLabelById.set(f.apiName, new Map(f.options.map((o) => [o.id, o.label])));
    }

    const payloads: Array<Record<string, unknown>> = [];
    const relationsToLink: Array<Array<{ fieldId: string; targetIds: string[] }>> = [];
    for (const record of sourceRecords) {
      const values: Record<string, unknown> = { name: record.title };
      const links: Array<{ fieldId: string; targetIds: string[] }> = [];
      for (const plan of plans) {
        if (plan.state !== 'mapped') continue;
        if (plan.to.kind === 'existing') {
          const dest = destById.get(plan.to.field_id)!;
          const raw = record.fields[plan.sourceKey];
          if (isEmptyValue(raw)) continue;
          const transformed = this.transformValue(
            raw,
            dest,
            sourceOptionLabelById.get(plan.sourceKey),
            plan.label,
            warnings,
          );
          // apiName is always set on every DestinationField this service builds
          // (from LiveField.apiName, never optional in practice) — the `?` on
          // MatchableField.apiName exists for OTHER matchers whose fields may lack one.
          if (transformed !== undefined) values[dest.apiName!] = transformed;
        } else if (plan.to.kind === 'relation') {
          const targetIds = sourceRelationLinks
            .filter((l) => l.fromSourceId === record.sourceId && l.fieldKey === plan.sourceKey)
            .flatMap((l) => l.toSourceIds);
          if (targetIds.length > 0) links.push({ fieldId: plan.to.field_id, targetIds });
        }
      }
      payloads.push(values);
      relationsToLink.push(links);
    }

    // #372's rollback pattern (mirrored from import.service.ts) — the only
    // creation this path does is records, since copy never creates fields or
    // relations (planField only ever maps to EXISTING destinations).
    let createdIds: string[] = [];
    try {
      createdIds = await this.chunkedApply.createChunked(membership.workspaceId, targetDatabaseId, payloads, actorId);
      for (let i = 0; i < createdIds.length; i++) {
        for (const link of relationsToLink[i] ?? []) {
          const warning = await this.relationLinker.link(
            membership.workspaceId,
            targetDatabaseId,
            createdIds[i]!,
            link.fieldId,
            link.targetIds,
            actorId,
          );
          if (warning) warnings.push(warning);
        }
      }
    } catch (error) {
      const undoFailures = await this.rollback(membership.workspaceId, targetDatabaseId, createdIds, actorId);
      const because = error instanceof Error ? error.message : 'the copy failed';
      const suffix =
        undoFailures.length > 0
          ? ` The destination could not be fully restored — left behind: ${undoFailures.join(', ')}. Remove them by hand before retrying.`
          : ' Nothing was created, so you can fix the mapping and try again.';
      throw new UnprocessableEntityException(`${because}${suffix}`);
    }

    return { dry_run: false, created: createdIds, warnings };
  }

  /** Never throws — each undo step is caught individually and its failure
   * described in plain text, matching #372's "report undo failures explicitly
   * rather than swallowing them" (a security control that says "done" and does
   * nothing is the dangerous half — MN-125's own lesson, re-applied here). */
  private async rollback(
    workspaceId: string,
    databaseId: string,
    recordIds: string[],
    actorId: string,
  ): Promise<string[]> {
    if (recordIds.length === 0) return [];
    try {
      await this.records.batchDelete(workspaceId, databaseId, recordIds, actorId);
      return [];
    } catch {
      return [`${recordIds.length} record(s)`];
    }
  }

  /**
   * select/multi_select/workflow carry the SOURCE's option id, which is
   * meaningless in the destination — resolved id -> label (source) -> id
   * (destination) via the same buildLabelIndex/pickOption CSV and Linear
   * already use. A value that can't be matched is DROPPED with a warning
   * (not blocking — the field itself has a valid destination; this is one
   * value within it), matching #432's "empty is fine, missing loses data" line
   * drawn at the field level, applied the same way at the option level.
   */
  private transformValue(
    raw: unknown,
    dest: DestinationField,
    sourceOptionLabelById: Map<string, string> | undefined,
    fieldLabel: string,
    warnings: string[],
  ): unknown {
    if (dest.type !== 'select' && dest.type !== 'workflow' && dest.type !== 'multi_select') return raw;

    const resolveOne = (optionId: string): string | null => {
      const label = sourceOptionLabelById?.get(optionId);
      if (!label || !dest.options?.length) return null;
      return pickOption(buildLabelIndex(dest.options), label);
    };

    if (dest.type === 'multi_select') {
      if (!Array.isArray(raw)) return undefined;
      const ids = (raw as string[]).map(resolveOne).filter((id): id is string => id !== null);
      if (ids.length < raw.length) {
        warnings.push(`"${fieldLabel}": ${raw.length - ids.length} option(s) had no match in the destination and were dropped.`);
      }
      return ids.length > 0 ? ids : undefined;
    }

    if (typeof raw !== 'string') return undefined;
    const id = resolveOne(raw);
    if (!id) {
      warnings.push(`"${fieldLabel}": the copied option has no match in the destination — value dropped.`);
      return undefined;
    }
    return id;
  }
}
