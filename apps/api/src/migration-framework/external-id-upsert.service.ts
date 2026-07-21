import { Injectable } from '@nestjs/common';
import { RecordsService } from '../records/records.service';
import type { Membership } from '../workspaces/workspace-access.guard';

export interface UpsertResult {
  id: string;
  updated: boolean;
}

/**
 * Upsert-by-external-id (ADR-0013 §3): find a record by a designated identity
 * field's current value and update it, else create it stamped with that value.
 * Generalizes Linear's hand-rolled `upsertByLinearId` (MN-066) so any adapter
 * gets idempotent re-import for free.
 *
 * The identity lives in an ordinary field (e.g. `linear_id`), not a dedicated
 * DB column — see the doc comment on migration-framework/types.ts for why the
 * DB-level `source_id` primitive ADR-0013 also proposes is deferred.
 */
@Injectable()
export class ExternalIdUpsertService {
  constructor(private readonly recordsService: RecordsService) {}

  async upsert(
    membership: Membership,
    databaseId: string,
    identityField: string,
    identityValue: string,
    values: Record<string, unknown>,
    actorId: string,
  ): Promise<UpsertResult> {
    const existing = await this.recordsService.query(
      databaseId,
      { filter: { field: identityField, op: 'eq', value: identityValue }, sorts: [], limit: 1 } as never,
      actorId,
    );
    const match = existing.data[0];
    if (match) {
      await this.recordsService.update(membership.workspaceId, databaseId, match.id, values, actorId);
      return { id: match.id, updated: true };
    }
    const created = await this.recordsService.create(
      membership.workspaceId,
      databaseId,
      { ...values, [identityField]: identityValue },
      actorId,
      0,
    );
    return { id: created.id, updated: false };
  }
}
