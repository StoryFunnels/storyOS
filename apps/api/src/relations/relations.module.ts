import { Module } from '@nestjs/common';
import { DatabasesModule } from '../databases/databases.module';
import { WorkspacesModule } from '../workspaces/workspaces.module';
import { LinksController, RelationsController } from './relations.controller';
import { RelationsService } from './relations.service';
import { AutoLinkSubscriber } from './auto-link.subscriber';

@Module({
  imports: [WorkspacesModule, DatabasesModule],
  controllers: [RelationsController, LinksController],
  providers: [RelationsService, AutoLinkSubscriber],
  exports: [RelationsService],
})
export class RelationsModule {}
