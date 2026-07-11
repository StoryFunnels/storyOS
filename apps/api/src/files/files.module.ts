import { Module } from '@nestjs/common';
import { WorkspacesModule } from '../workspaces/workspaces.module';
import { FilesController, PublicFilesController } from './files.controller';
import { FilesService } from './files.service';

@Module({
  imports: [WorkspacesModule],
  controllers: [FilesController, PublicFilesController],
  providers: [FilesService],
})
export class FilesModule {}
