import { Module } from '@nestjs/common';
import { DatabasesModule } from '../databases/databases.module';
import { RecordsModule } from '../records/records.module';
import { WorkspacesModule } from '../workspaces/workspaces.module';
import { ValidationEnforcerModule } from './validation-enforcer.module';
import { ValidationRulesController } from './validation-rules.controller';
import { ValidationRulesService } from './validation-rules.service';

@Module({
  imports: [DatabasesModule, RecordsModule, WorkspacesModule, ValidationEnforcerModule],
  controllers: [ValidationRulesController],
  providers: [ValidationRulesService],
})
export class ValidationRulesModule {}
