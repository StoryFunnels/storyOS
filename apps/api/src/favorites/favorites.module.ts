import { Module } from '@nestjs/common';
import { RecordsModule } from '../records/records.module';
import { WorkspacesModule } from '../workspaces/workspaces.module';
import { FavoritesController } from './favorites.controller';
import { FavoritesService } from './favorites.service';

@Module({
  imports: [WorkspacesModule, RecordsModule],
  controllers: [FavoritesController],
  providers: [FavoritesService],
})
export class FavoritesModule {}
