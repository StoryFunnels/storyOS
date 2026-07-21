import { Module } from '@nestjs/common';
import { DatabasesModule } from '../databases/databases.module';
import { FieldsModule } from '../fields/fields.module';
import { RecordsModule } from '../records/records.module';
import { RelationsModule } from '../relations/relations.module';
import { MigrationFrameworkModule } from '../migration-framework/migration-framework.module';
import { ImportController } from './import.controller';
import { ImportService } from './import.service';

@Module({
  imports: [DatabasesModule, FieldsModule, RecordsModule, RelationsModule, MigrationFrameworkModule],
  controllers: [ImportController],
  providers: [ImportService],
})
export class ImportModule {}
