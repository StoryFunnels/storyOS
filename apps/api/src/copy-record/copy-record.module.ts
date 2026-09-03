import { Module } from '@nestjs/common';
import { DatabasesModule } from '../databases/databases.module';
import { RecordsModule } from '../records/records.module';
import { RelationsModule } from '../relations/relations.module';
import { MigrationFrameworkModule } from '../migration-framework/migration-framework.module';
import { CopyRecordController } from './copy-record.controller';
import { CopyRecordService } from './copy-record.service';

@Module({
  imports: [DatabasesModule, RecordsModule, RelationsModule, MigrationFrameworkModule],
  controllers: [CopyRecordController],
  providers: [CopyRecordService],
})
export class CopyRecordModule {}
