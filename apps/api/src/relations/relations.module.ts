import { Module } from '@nestjs/common';
import { DatabasesModule } from '../databases/databases.module';
import { WorkspacesModule } from '../workspaces/workspaces.module';
import { LinksController, RelationsController } from './relations.controller';
import { RelationsService } from './relations.service';
import { AutoLinkService } from './auto-link.service';
import { AutoLinkSubscriber } from './auto-link.subscriber';
import { SelectRelationDriftService } from './select-relation-drift.service';

@Module({
  imports: [WorkspacesModule, DatabasesModule],
  controllers: [RelationsController, LinksController],
  providers: [RelationsService, AutoLinkService, AutoLinkSubscriber, SelectRelationDriftService],
  exports: [RelationsService, AutoLinkService, SelectRelationDriftService],
})
export class RelationsModule {}
