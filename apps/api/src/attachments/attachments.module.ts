import { forwardRef, Module } from '@nestjs/common';
import { DatabasesModule } from '../databases/databases.module';
import { RecordsModule } from '../records/records.module';
import { WorkspacesModule } from '../workspaces/workspaces.module';
import { AttachmentsController } from './attachments.controller';
import { AttachmentsService } from './attachments.service';

@Module({
  // #599: RecordsModule now imports AttachmentsModule back (RecordsService
  // copies a duplicated record's files) — forwardRef breaks the cycle.
  imports: [WorkspacesModule, DatabasesModule, forwardRef(() => RecordsModule)],
  controllers: [AttachmentsController],
  providers: [AttachmentsService],
  exports: [AttachmentsService],
})
export class AttachmentsModule {}
