import { Module } from '@nestjs/common';
import { DatabasesModule } from '../databases/databases.module';
import { WorkspacesModule } from '../workspaces/workspaces.module';
import { UsersModule } from '../users/users.module';
import { ViewsController } from './views.controller';
import { PersonalFilterController } from './personal-filter.controller';
import { ViewsService } from './views.service';

@Module({
  // UsersModule (#259): PersonalFilterController reads/writes the personal filter
  // override through PreferencesService, which UsersModule exports.
  imports: [WorkspacesModule, DatabasesModule, UsersModule],
  controllers: [ViewsController, PersonalFilterController],
  providers: [ViewsService],
  exports: [ViewsService],
})
export class ViewsModule {}
