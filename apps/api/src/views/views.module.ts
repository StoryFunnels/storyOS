import { Module } from '@nestjs/common';
import { AccessModule } from '../access/access.module';
import { DatabasesModule } from '../databases/databases.module';
import { WorkspacesModule } from '../workspaces/workspaces.module';
import { UsersModule } from '../users/users.module';
import { ViewsController } from './views.controller';
import { PersonalFilterController } from './personal-filter.controller';
import { SpaceViewsController } from './space-views.controller';
import { SpaceViewsService } from './space-views.service';
import { ViewsService } from './views.service';

@Module({
  // UsersModule (#259): PersonalFilterController reads/writes the personal filter
  // override through PreferencesService, which UsersModule exports.
  // AccessModule (#347): SpaceViewsService resolves each view's database
  // against the VIEWER, so it needs AccessService directly rather than through
  // DatabasesService.assertAccess — which throws, and would collapse the whole
  // list when one database is unreadable.
  imports: [WorkspacesModule, DatabasesModule, UsersModule, AccessModule],
  controllers: [ViewsController, PersonalFilterController, SpaceViewsController],
  providers: [ViewsService, SpaceViewsService],
  exports: [ViewsService, SpaceViewsService],
})
export class ViewsModule {}
