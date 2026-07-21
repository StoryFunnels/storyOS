import { Module } from '@nestjs/common';
import { DatabasesModule } from '../databases/databases.module';
import { MentionsModule } from '../mentions/mentions.module';
import { RecordsModule } from '../records/records.module';
import { UsersModule } from '../users/users.module';
import { WorkspacesModule } from '../workspaces/workspaces.module';
import { ActivityController } from '../activity/activity.controller';
import { ActivityService } from '../activity/activity.service';
import { RecordVersionsController } from '../activity/record-versions.controller';
import { CommentsController } from './comments.controller';
import { CommentsService } from './comments.service';

@Module({
  imports: [WorkspacesModule, DatabasesModule, RecordsModule, MentionsModule, UsersModule],
  controllers: [CommentsController, ActivityController, RecordVersionsController],
  providers: [CommentsService, ActivityService],
  exports: [CommentsService, ActivityService],
})
export class CollaborationModule {}
