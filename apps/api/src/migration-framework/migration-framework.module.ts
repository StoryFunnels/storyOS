import { Module } from '@nestjs/common';
import { RecordsModule } from '../records/records.module';
import { RelationsModule } from '../relations/relations.module';
import { ChunkedApplyService } from './chunked-apply.service';
import { ExternalIdUpsertService } from './external-id-upsert.service';
import { RelationLinkerService } from './relation-linker.service';

/**
 * The shared migration framework (#198 / MN-236, ADR-0013). Import this module
 * to get the map → dry-run → chunked-apply primitives every source-specific
 * importer (CSV, Linear, and the four planned competitor importers) builds on.
 */
@Module({
  imports: [RecordsModule, RelationsModule],
  providers: [ChunkedApplyService, ExternalIdUpsertService, RelationLinkerService],
  exports: [ChunkedApplyService, ExternalIdUpsertService, RelationLinkerService],
})
export class MigrationFrameworkModule {}
