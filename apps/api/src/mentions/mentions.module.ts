import { forwardRef, Module } from '@nestjs/common';
import { AccessModule } from '../access/access.module';
import { DatabasesModule } from '../databases/databases.module';
import { RecordsModule } from '../records/records.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { WorkspacesModule } from '../workspaces/workspaces.module';
import { MentionsController } from './mentions.controller';
import { MentionsService } from './mentions.service';

@Module({
  // #884 — the controller narrows backlink titles through RecordsService; RecordsModule imports this module, so both edges are forwardRef.
  imports: [WorkspacesModule, DatabasesModule, AccessModule, NotificationsModule, forwardRef(() => RecordsModule)],
  controllers: [MentionsController],
  providers: [MentionsService],
  exports: [MentionsService],
})
export class MentionsModule {}
