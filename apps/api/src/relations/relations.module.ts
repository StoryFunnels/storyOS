import { Module } from '@nestjs/common';
import { DatabasesModule } from '../databases/databases.module';
import { WorkspacesModule } from '../workspaces/workspaces.module';
import { LinksController, RelationsController } from './relations.controller';
import { RelationsService } from './relations.service';

@Module({
  imports: [WorkspacesModule, DatabasesModule],
  controllers: [RelationsController, LinksController],
  providers: [RelationsService],
  exports: [RelationsService],
})
export class RelationsModule {}
