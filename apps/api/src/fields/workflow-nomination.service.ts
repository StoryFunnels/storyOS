import { ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import type { ApplyWorkflowNominationInput, WorkflowNominationApplyResult, WorkflowNominationScan } from '@storyos/schemas';
import { DB } from '../db/db.module';
import type { Db } from '../db/client';
import { databases, fields, selectOptions } from '../db/schema';
import { notDeleted } from '../db/soft-delete';
import { AccessService } from '../access/access.service';
import { DatabasesService } from '../databases/databases.service';
import type { Membership } from '../workspaces/workspace-access.guard';
import { FieldsService } from './fields.service';
import { scoreWorkflowCandidate } from './workflow-candidate';

/**
 * #598 — find the selects across a workspace that look like a database's lifecycle field, and convert
 * the chosen ones to `workflow` through the EXISTING per-field conversion (`FieldsService.changeType`,
 * so the compatibility matrix, the one-workflow-per-database rule and the value-preserving conversion
 * are not re-implemented here and cannot drift).
 *
 * The scan is READ-ONLY and respects what the caller may read: a database a guest cannot see is not
 * listed, with no placeholder and no count. Applying needs `creator` on each database (the same floor
 * as the per-field endpoint), judged per item, so one refusal does not stop the others.
 */
@Injectable()
export class WorkflowNominationService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly access: AccessService,
    private readonly databasesService: DatabasesService,
    private readonly fieldsService: FieldsService,
  ) {}

  async scan(membership: Membership): Promise<WorkflowNominationScan> {
    const visible = await this.access.visibleDatabaseIds(membership);
    const dbRows = await this.db.query.databases.findMany({
      where: and(eq(databases.workspaceId, membership.workspaceId), notDeleted(databases.deletedAt)),
      columns: { id: true, name: true },
      orderBy: [asc(databases.name)],
    });
    const scoped = dbRows.filter((d) => visible === null || visible.has(d.id));
    const ids = scoped.map((d) => d.id);
    const fieldRows = ids.length
      ? await this.db.query.fields.findMany({
          where: and(inArray(fields.databaseId, ids), inArray(fields.type, ['select', 'workflow']), isNull(fields.deletedAt)),
          columns: { id: true, databaseId: true, type: true, displayName: true, apiName: true, isSystem: true },
          orderBy: [asc(fields.position)],
        })
      : [];
    const optionRows = fieldRows.length
      ? await this.db.query.selectOptions.findMany({
          where: inArray(selectOptions.fieldId, fieldRows.map((f) => f.id)),
          orderBy: [asc(selectOptions.position)],
        })
      : [];
    const labelsByField = new Map<string, string[]>();
    for (const o of optionRows) labelsByField.set(o.fieldId, [...(labelsByField.get(o.fieldId) ?? []), o.label]);

    const out = scoped.map((d) => {
      const own = fieldRows.filter((f) => f.databaseId === d.id);
      const existing = own.find((f) => f.type === 'workflow') ?? null;
      if (existing) {
        return {
          database_id: d.id,
          database_name: d.name,
          status: 'has_workflow' as const,
          existing_workflow: { field_id: existing.id, display_name: existing.displayName },
          ambiguous: false,
          candidates: [],
        };
      }
      const candidates = own
        .filter((f) => f.type === 'select' && !f.isSystem)
        .map((f) => {
          const optionLabels = labelsByField.get(f.id) ?? [];
          const s = scoreWorkflowCandidate({ displayName: f.displayName, apiName: f.apiName, optionLabels });
          return s ? { f, s, optionLabels } : null;
        })
        .filter((c): c is NonNullable<typeof c> => c !== null)
        .sort((a, b) => b.s.score - a.s.score);
      return {
        database_id: d.id,
        database_name: d.name,
        status: candidates.length ? ('candidates' as const) : ('none' as const),
        existing_workflow: null,
        // More than one plausible lifecycle: a database holds ONE workflow field, so a person chooses.
        ambiguous: candidates.length > 1,
        candidates: candidates.map((c) => ({
          field_id: c.f.id,
          display_name: c.f.displayName,
          api_name: c.f.apiName,
          confidence: c.s.confidence,
          reasons: c.s.reasons,
          option_labels: c.optionLabels,
        })),
      };
    });
    return {
      databases: out,
      summary: {
        databases_scanned: out.length,
        with_workflow: out.filter((d) => d.status === 'has_workflow').length,
        with_candidates: out.filter((d) => d.status === 'candidates').length,
        ambiguous: out.filter((d) => d.ambiguous).length,
      },
    };
  }

  async apply(membership: Membership, input: ApplyWorkflowNominationInput): Promise<WorkflowNominationApplyResult> {
    const results: WorkflowNominationApplyResult['results'] = [];
    const claimed = new Map<string, string>(); // database_id -> the field already nominated in this batch
    for (const item of input.nominations) {
      const done = (status: 'converted' | 'would_convert' | 'skipped' | 'error', reason: string | null = null) =>
        results.push({ database_id: item.database_id, field_id: item.field_id, status, reason });
      try {
        // A database the caller cannot see is indistinguishable from one that does not exist.
        const database = await this.db.query.databases.findFirst({
          where: and(eq(databases.id, item.database_id), eq(databases.workspaceId, membership.workspaceId), notDeleted(databases.deletedAt)),
          columns: { id: true },
        });
        if (!database) throw new NotFoundException('Database not found');
        await this.databasesService.assertAccess(membership, item.database_id, 'creator');
        const field = await this.db.query.fields.findFirst({
          where: and(eq(fields.id, item.field_id), eq(fields.databaseId, item.database_id), isNull(fields.deletedAt)),
          columns: { id: true, type: true },
        });
        if (!field) throw new NotFoundException('Field not found in that database');
        if (field.type === 'workflow') {
          done('skipped', 'Already a workflow field.');
          continue;
        }
        const other = claimed.get(item.database_id);
        if (other && other !== item.field_id) {
          // A dry run applies nothing, so the one-per-database rule cannot catch this on its own.
          throw new ForbiddenException(`A database holds one workflow field; this batch already nominated another field (${other}) in it.`);
        }
        const res = await this.fieldsService.changeType(item.database_id, item.field_id, 'workflow', input.dry_run);
        claimed.set(item.database_id, item.field_id);
        done(input.dry_run ? 'would_convert' : 'converted', summariseLoss(res));
      } catch (error) {
        done('error', error instanceof Error ? error.message : String(error));
      }
    }
    return { dry_run: input.dry_run, results };
  }
}

/** The per-field path reports `{ records_affected, lossy_conversions }`; a select to workflow loses nothing, but say so rather than assume. */
function summariseLoss(res: unknown): string | null {
  const r = res as { records_affected?: number; lossy_conversions?: number } | null;
  if (typeof r?.lossy_conversions === 'number' && r.lossy_conversions > 0) return `${r.lossy_conversions} value(s) would be lost`;
  return typeof r?.records_affected === 'number' ? `${r.records_affected} record(s) carry a value; option ids are preserved` : null;
}
