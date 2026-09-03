import { Module } from '@nestjs/common';
import { AccessModule } from '../access/access.module';
import { DatabasesModule } from '../databases/databases.module';
import { RecordsModule } from '../records/records.module';
import { WorkspacesModule } from '../workspaces/workspaces.module';
import { UsersModule } from '../users/users.module';
import { ViewsController } from './views.controller';
import { PersonalFilterController } from './personal-filter.controller';
import { PublicViewsController } from './public-views.controller';
import { PublicViewsService } from './public-views.service';
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
  // RecordsModule (#264): PublicViewsService reads a published view's records
  // through the same RecordsService.query every signed-in read uses.
  imports: [WorkspacesModule, DatabasesModule, RecordsModule, UsersModule, AccessModule],
  controllers: [ViewsController, PersonalFilterController, SpaceViewsController, PublicViewsController],
  providers: [ViewsService, SpaceViewsService, PublicViewsService],
  exports: [ViewsService, SpaceViewsService],
})
export class ViewsModule {}
