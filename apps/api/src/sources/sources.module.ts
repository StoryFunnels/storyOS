import { Module } from '@nestjs/common';
import { ConnectionsModule } from '../connections/connections.module';
import { DatabasesModule } from '../databases/databases.module';
import { RecordsModule } from '../records/records.module';
import { SourcesController } from './sources.controller';
import { SourcesService } from './sources.service';
import { WriteBackSubscriber } from './write-back.subscriber';

/**
 * #239 — the Sources framework: sources/source_runs tables, the 60s
 * scheduler + upsert engine, and the provider registry (providers/index.ts,
 * where MN-261/MN-262 register more).
 *
 * #279 — WriteBackSubscriber needs no explicit import for DomainEventsService:
 * EventsModule is @Global().
 */
@Module({
  imports: [DatabasesModule, RecordsModule, ConnectionsModule],
  controllers: [SourcesController],
  providers: [SourcesService, WriteBackSubscriber],
  exports: [SourcesService],
})
export class SourcesModule {}
