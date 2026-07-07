import { Module } from '@nestjs/common';
import { DatabasesModule } from '../databases/databases.module';
import { RecordsModule } from '../records/records.module';
import { WorkspacesModule } from '../workspaces/workspaces.module';
import { ActivityController } from '../activity/activity.controller';
import { ActivityService } from '../activity/activity.service';
import { CommentsController } from './comments.controller';
import { CommentsService } from './comments.service';

@Module({
  imports: [WorkspacesModule, DatabasesModule, RecordsModule],
  controllers: [CommentsController, ActivityController],
  providers: [CommentsService, ActivityService],
  exports: [CommentsService, ActivityService],
})
export class CollaborationModule {}
