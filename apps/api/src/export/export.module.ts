import { Module } from '@nestjs/common';
import { DatabasesModule } from '../databases/databases.module';
import { RecordsModule } from '../records/records.module';
import { WorkspacesModule } from '../workspaces/workspaces.module';
import { UsersModule } from '../users/users.module';
import { ExportController } from './export.controller';
import { ExportService } from './export.service';
import { WorkspaceExportController } from './workspace-export.controller';
import { WorkspaceExportService } from './workspace-export.service';

@Module({
  // UsersModule (#259): ExportService ANDs the exporting user's personal filter
  // override into the CSV, via PreferencesService.
  imports: [WorkspacesModule, DatabasesModule, RecordsModule, UsersModule],
  controllers: [ExportController, WorkspaceExportController],
  providers: [ExportService, WorkspaceExportService],
  exports: [ExportService, WorkspaceExportService],
})
export class ExportModule {}
