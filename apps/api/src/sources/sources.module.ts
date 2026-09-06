import { forwardRef, Module } from '@nestjs/common';
import { ConnectionsModule } from '../connections/connections.module';
import { DatabasesModule } from '../databases/databases.module';
import { RecordsModule } from '../records/records.module';
import { AutomationsModule } from '../automations/automations.module';
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
  // #282 — forwardRef breaks the module-evaluation cycle this creates:
  // SourcesModule -> AutomationsModule -> IntegrationsModule -> SourcesModule.
  imports: [DatabasesModule, RecordsModule, ConnectionsModule, forwardRef(() => AutomationsModule)],
  controllers: [SourcesController],
  providers: [SourcesService, WriteBackSubscriber],
  exports: [SourcesService],
})
export class SourcesModule {}
