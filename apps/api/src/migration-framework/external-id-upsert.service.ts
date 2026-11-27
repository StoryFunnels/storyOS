import { ConflictException, Injectable } from '@nestjs/common';
import type { ChangeSource } from '../db/schema';
import { RecordsService } from '../records/records.service';
import { runAsImportRun } from '../common/import-run-context';
import type { Membership } from '../workspaces/workspace-access.guard';

export interface UpsertResult {
  id: string;
  updated: boolean;
}

export interface UpsertOptions {
  /**
   * Ticket #1363 — the public number the source already gave this record (a Linear issue's 5201). Honoured on CREATE only: the record is
   * written at exactly this number and the database's counter is raised to at least it (GREATEST, same transaction), so records made
   * afterwards continue after the highest imported number. A number that is already held refuses, naming the holder, and overwrites
   * nothing. NOT reachable from any HTTP route: a client choosing numbers is a collision machine. An existing match keeps its number;
   * naming a different one refuses rather than renumbering.
   */
  number?: number;
  /** Provenance written to the record's history. Defaults to 'automation', as before; a caller replaying a source's own history passes 'import'. */
  source?: ChangeSource;
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

  /**
   * Ticket #1377 - every write below is part of an import run, so the events it emits say so (`DomainEvent.importRun`) and a Slack
   * channel subscription posts nothing for a record an import created. An importer that knows it is incremental sets its mode on the
   * run it is already inside (the Linear sync does); one that does not is `full`, which is the quiet default.
   */
  upsert(
    membership: Membership,
    databaseId: string,
    identityField: string,
    identityValue: string,
    values: Record<string, unknown>,
    actorId: string,
    options: UpsertOptions = {},
  ): Promise<UpsertResult> {
    return runAsImportRun(() => this.upsertInRun(membership, databaseId, identityField, identityValue, values, actorId, options));
  }

  private async upsertInRun(
    membership: Membership,
    databaseId: string,
    identityField: string,
    identityValue: string,
    values: Record<string, unknown>,
    actorId: string,
    options: UpsertOptions,
  ): Promise<UpsertResult> {
    const source = options.source ?? 'automation';
    const existing = await this.recordsService.query(
      databaseId,
      { filter: { field: identityField, op: 'eq', value: identityValue }, sorts: [], limit: 1 } as never,
      actorId,
    );
    const match = existing.data[0];
    if (match) {
      if (options.number !== undefined && match.number !== options.number) {
        throw new ConflictException(
          `The record for ${identityField} "${identityValue}" already exists as number ${match.number}; an import never renumbers a record (asked for ${options.number})`,
        );
      }
      // #481 — an external-source sync upsert, never a person typing.
      await this.recordsService.update(
        membership.workspaceId,
        databaseId,
        match.id,
        values,
        actorId,
        0,
        source,
      );
      return { id: match.id, updated: true };
    }
    if (options.number !== undefined) {
      const [created] = await this.recordsService.createBatch(
        membership.workspaceId,
        databaseId,
        [{ ...values, [identityField]: identityValue }],
        actorId,
        0,
        { source, numbers: [options.number] },
      );
      return { id: created!.id, updated: false };
    }
    const created = await this.recordsService.create(
      membership.workspaceId,
      databaseId,
      { ...values, [identityField]: identityValue },
      actorId,
      0,
      source,
    );
    return { id: created.id, updated: false };
  }
}
