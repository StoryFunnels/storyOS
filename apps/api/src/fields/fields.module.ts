import { Module } from '@nestjs/common';
import { DatabasesModule } from '../databases/databases.module';
import { WorkspacesModule } from '../workspaces/workspaces.module';
import { RecordsModule } from '../records/records.module';
import { UsersModule } from '../users/users.module';
import { FieldsController } from './fields.controller';
import { FieldsService } from './fields.service';
import { PersonalCollectionViewController } from './personal-collection-view.controller';

@Module({
  // UsersModule (#736): PersonalCollectionViewController reads/writes the
  // personal collection-view override through PreferencesService, which
  // UsersModule exports — same wiring reason ViewsModule imports it for
  // PersonalFilterController.
  imports: [WorkspacesModule, DatabasesModule, RecordsModule, UsersModule],
  controllers: [FieldsController, PersonalCollectionViewController],
  providers: [FieldsService],
  exports: [FieldsService],
})
export class FieldsModule {}
