import { Module } from '@nestjs/common';
import { DatabasesModule } from '../databases/databases.module';
import { DocumentsModule } from '../documents/documents.module';
import { RecordsModule } from '../records/records.module';
import { RecordTemplatesController } from './record-templates.controller';
import { RecordTemplatesService } from './record-templates.service';

/** ticket #1218 - record templates. Imports Records and Documents rather than reimplementing record creation. */
@Module({
  imports: [DatabasesModule, DocumentsModule, RecordsModule],
  controllers: [RecordTemplatesController],
  providers: [RecordTemplatesService],
  exports: [RecordTemplatesService],
})
export class RecordTemplatesModule {}
