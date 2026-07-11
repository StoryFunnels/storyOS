import { Module } from '@nestjs/common';
import { DatabasesModule } from '../databases/databases.module';
import { RecordsModule } from '../records/records.module';
import { WorkspacesModule } from '../workspaces/workspaces.module';
import { DocumentsController } from './documents.controller';
import { DocumentsService } from './documents.service';
import { SpaceDocumentsController } from './space-documents.controller';
import { SpaceDocumentsService } from './space-documents.service';

@Module({
  imports: [WorkspacesModule, DatabasesModule, RecordsModule],
  controllers: [DocumentsController, SpaceDocumentsController],
  providers: [DocumentsService, SpaceDocumentsService],
  exports: [DocumentsService],
})
export class DocumentsModule {}
