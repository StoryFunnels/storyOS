import { Module } from '@nestjs/common';
import { ActionGatesModule } from '../action-gates/action-gates.module';
import { WorkspacesModule } from '../workspaces/workspaces.module';
import { DatabasesController } from './databases.controller';
import { DatabasesService } from './databases.service';

@Module({
  // #542 — ActionGatesModule imports nothing itself (by design, see its own
  // doc comment), so both this module and WorkspacesModule can import it
  // directly with no cycle risk.
  imports: [WorkspacesModule, ActionGatesModule],
  controllers: [DatabasesController],
  providers: [DatabasesService],
  exports: [DatabasesService],
})
export class DatabasesModule {}
