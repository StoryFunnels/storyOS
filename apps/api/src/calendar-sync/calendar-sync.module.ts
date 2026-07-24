import { Module } from '@nestjs/common';
import { ConnectionsModule } from '../connections/connections.module';
import { RecordsModule } from '../records/records.module';
import { CalendarSyncController } from './calendar-sync.controller';
import { CalendarSyncService } from './calendar-sync.service';

@Module({
  imports: [ConnectionsModule, RecordsModule],
  controllers: [CalendarSyncController],
  providers: [CalendarSyncService],
  exports: [CalendarSyncService],
})
export class CalendarSyncModule {}
