import { Module } from '@nestjs/common';
import { DatabasesModule } from '../databases/databases.module';
import { ViewerStateService } from './viewer-state.service';

@Module({
  imports: [DatabasesModule],
  providers: [ViewerStateService],
  exports: [ViewerStateService],
})
export class ViewerStateModule {}
