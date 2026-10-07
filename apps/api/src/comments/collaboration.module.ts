import { Module } from '@nestjs/common';
import { DatabasesModule } from '../databases/databases.module';
import { MentionsModule } from '../mentions/mentions.module';
import { RecordsModule } from '../records/records.module';
import { UsersModule } from '../users/users.module';
import { WorkspacesModule } from '../workspaces/workspaces.module';
import { MembersDbModule } from '../members/members-db.module';
import { ActivityController } from '../activity/activity.controller';
import { ActivityService } from '../activity/activity.service';
import { AuditLogController } from '../activity/audit-log.controller';
import { AuditLogService } from '../activity/audit-log.service';
import { RecordVersionsController } from '../activity/record-versions.controller';
import { DatabaseActivityController } from '../activity/database-activity.controller';
import { SlackService } from '../integrations/slack.service';
import { CommentsController } from './comments.controller';
import { CommentsService } from './comments.service';

@Module({
  imports: [WorkspacesModule, DatabasesModule, RecordsModule, MentionsModule, UsersModule, MembersDbModule],
  controllers: [CommentsController, ActivityController, DatabaseActivityController, RecordVersionsController, AuditLogController],
  // #268 — SlackService is provided directly (it only needs the global DB) rather
  // than importing the whole IntegrationsModule: adding that module edge shifts
  // Nest's init order and needlessly reorders the generated OpenAPI. A second
  // stateless instance (config read from DB per call) is harmless.
  providers: [CommentsService, ActivityService, SlackService, AuditLogService],
  exports: [CommentsService, ActivityService],
})
export class CollaborationModule {}
