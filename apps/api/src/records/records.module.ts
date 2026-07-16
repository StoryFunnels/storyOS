import { Module } from '@nestjs/common';
import { DatabasesModule } from '../databases/databases.module';
import { MentionsModule } from '../mentions/mentions.module';
import { WorkspacesModule } from '../workspaces/workspaces.module';
import { RecordsController } from './records.controller';
import { RecordsService } from './records.service';

@Module({
  imports: [WorkspacesModule, DatabasesModule, MentionsModule],
  controllers: [RecordsController],
  providers: [RecordsService],
  exports: [RecordsService],
})
export class RecordsModule {}
