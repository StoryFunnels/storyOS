import { Module } from '@nestjs/common';
import { DatabasesModule } from '../databases/databases.module';
import { RecordsModule } from '../records/records.module';
import { WorkspacesModule } from '../workspaces/workspaces.module';
import { UsersModule } from '../users/users.module';
import { ExportController } from './export.controller';
import { ExportService } from './export.service';

@Module({
  // UsersModule (#259): ExportService ANDs the exporting user's personal filter
  // override into the CSV, via PreferencesService.
  imports: [WorkspacesModule, DatabasesModule, RecordsModule, UsersModule],
  controllers: [ExportController],
  providers: [ExportService],
  exports: [ExportService],
})
export class ExportModule {}
