import { Module } from '@nestjs/common';
import { DatabasesModule } from '../databases/databases.module';
import { FieldsModule } from '../fields/fields.module';
import { RecordsModule } from '../records/records.module';
import { RelationsModule } from '../relations/relations.module';
import { WorkspacesModule } from '../workspaces/workspaces.module';
import { GithubService } from './github.service';
import { IntegrationsController } from './integrations.controller';

@Module({
  imports: [DatabasesModule, FieldsModule, RecordsModule, RelationsModule, WorkspacesModule],
  controllers: [IntegrationsController],
  providers: [GithubService],
  exports: [GithubService],
})
export class IntegrationsModule {}
