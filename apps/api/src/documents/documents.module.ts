import { Module } from '@nestjs/common';
import { DatabasesModule } from '../databases/databases.module';
import { RecordsModule } from '../records/records.module';
import { WorkspacesModule } from '../workspaces/workspaces.module';
import { MentionsModule } from '../mentions/mentions.module';
import { BillingModule } from '../billing/billing.module';
import { DocumentsController } from './documents.controller';
import { DocumentsService } from './documents.service';
import { SpaceDocumentsController } from './space-documents.controller';
import { SpaceDocumentsService } from './space-documents.service';
import { PdfRenderer, pdfRendererOptionsFromEnv } from './export/pdf-renderer';

@Module({
  imports: [WorkspacesModule, DatabasesModule, RecordsModule, MentionsModule, BillingModule],
  controllers: [DocumentsController, SpaceDocumentsController],
  providers: [
    DocumentsService,
    SpaceDocumentsService,
    { provide: PdfRenderer, useFactory: () => new PdfRenderer(pdfRendererOptionsFromEnv()) },
  ],
  exports: [DocumentsService],
})
export class DocumentsModule {}
