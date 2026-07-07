import { Module } from '@nestjs/common';
import { DatabasesModule } from '../databases/databases.module';
import { RecordsModule } from '../records/records.module';
import { WorkspacesModule } from '../workspaces/workspaces.module';
import { AttachmentsController } from './attachments.controller';
import { AttachmentsService } from './attachments.service';

@Module({
  imports: [WorkspacesModule, DatabasesModule, RecordsModule],
  controllers: [AttachmentsController],
  providers: [AttachmentsService],
  exports: [AttachmentsService],
})
export class AttachmentsModule {}
