import { Module } from '@nestjs/common';
import { DatabasesModule } from '../databases/databases.module';
import { WorkspacesModule } from '../workspaces/workspaces.module';
import { RecordsModule } from '../records/records.module';
import { ViewerStateModule } from '../viewer-state/viewer-state.module';
import { FieldsController } from './fields.controller';
import { FieldsService } from './fields.service';
import { WorkflowNominationController } from './workflow-nomination.controller';
import { WorkflowNominationService } from './workflow-nomination.service';
import { PersonalCollectionViewController } from './personal-collection-view.controller';

@Module({
  // ViewerStateModule (#736 / ADR-0019): PersonalCollectionViewController reads/writes the
  // personal collection-view override through ViewerStateService — same wiring reason ViewsModule imports it for
  // PersonalFilterController.
  imports: [WorkspacesModule, DatabasesModule, RecordsModule, ViewerStateModule],
  controllers: [FieldsController, PersonalCollectionViewController, WorkflowNominationController],
  providers: [FieldsService, WorkflowNominationService],
  exports: [FieldsService],
})
export class FieldsModule {}
