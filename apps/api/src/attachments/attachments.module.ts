import { forwardRef, Module } from '@nestjs/common';
import { RecordsModule } from '../records/records.module';
import { WorkspacesModule } from '../workspaces/workspaces.module';
import { AttachmentsController } from './attachments.controller';
import { AttachmentsService } from './attachments.service';

@Module({
  // #599: RecordsModule now imports AttachmentsModule back (RecordsService
  // copies a duplicated record's files) — forwardRef breaks the cycle.
  // #473: DatabasesModule is no longer needed here — AttachmentsController's
  // access check goes through RecordsService.assertRecordAccess now, which
  // already resolves through AccessService rather than a direct DatabasesService
  // dependency.
  imports: [WorkspacesModule, forwardRef(() => RecordsModule)],
  controllers: [AttachmentsController],
  providers: [AttachmentsService],
  exports: [AttachmentsService],
})
export class AttachmentsModule {}
