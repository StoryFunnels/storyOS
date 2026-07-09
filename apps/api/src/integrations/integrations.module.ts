import { Module } from '@nestjs/common';
import { DatabasesModule } from '../databases/databases.module';
import { FieldsModule } from '../fields/fields.module';
import { RecordsModule } from '../records/records.module';
import { RelationsModule } from '../relations/relations.module';
import { WorkspacesModule } from '../workspaces/workspaces.module';
import { GithubService } from './github.service';
import { IntegrationsController, LinearIntegrationsController } from './integrations.controller';
import { LinearService } from './linear.service';

@Module({
  imports: [DatabasesModule, FieldsModule, RecordsModule, RelationsModule, WorkspacesModule],
  controllers: [IntegrationsController, LinearIntegrationsController],
  providers: [GithubService, LinearService],
  exports: [GithubService, LinearService],
})
export class IntegrationsModule {}
