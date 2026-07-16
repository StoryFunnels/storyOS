import { Module } from '@nestjs/common';
import { AccessModule } from '../access/access.module';
import { DatabasesModule } from '../databases/databases.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { WorkspacesModule } from '../workspaces/workspaces.module';
import { MentionsController } from './mentions.controller';
import { MentionsService } from './mentions.service';

@Module({
  imports: [WorkspacesModule, DatabasesModule, AccessModule, NotificationsModule],
  controllers: [MentionsController],
  providers: [MentionsService],
  exports: [MentionsService],
})
export class MentionsModule {}
