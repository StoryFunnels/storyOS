import { Module } from '@nestjs/common';
import { CollaborationModule } from '../comments/collaboration.module';
import { DatabasesModule } from '../databases/databases.module';
import { RecordsModule } from '../records/records.module';
import { RelationsModule } from '../relations/relations.module';
import { AutomationActionsService } from './actions.service';
import { ButtonsController } from './buttons.controller';

@Module({
  imports: [DatabasesModule, RecordsModule, RelationsModule, CollaborationModule],
  controllers: [ButtonsController],
  providers: [AutomationActionsService],
  exports: [AutomationActionsService],
})
export class AutomationsModule {}
