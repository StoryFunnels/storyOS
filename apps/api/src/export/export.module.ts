import { Module } from '@nestjs/common';
import { DatabasesModule } from '../databases/databases.module';
import { RecordsModule } from '../records/records.module';
import { WorkspacesModule } from '../workspaces/workspaces.module';
import { ViewerStateModule } from '../viewer-state/viewer-state.module';
import { ExportController } from './export.controller';
import { ExportService } from './export.service';
import { WorkspaceExportController } from './workspace-export.controller';
import { WorkspaceExportService } from './workspace-export.service';

@Module({
  // ViewerStateModule (#259 / ADR-0019): ExportService ANDs the exporting user's personal filter
  // override into the CSV.
  imports: [WorkspacesModule, DatabasesModule, RecordsModule, ViewerStateModule],
  controllers: [ExportController, WorkspaceExportController],
  providers: [ExportService, WorkspaceExportService],
  exports: [ExportService, WorkspaceExportService],
})
export class ExportModule {}
