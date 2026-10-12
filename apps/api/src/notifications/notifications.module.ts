import { forwardRef, Global, Module } from '@nestjs/common';
import { RecordsModule } from '../records/records.module';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';

@Global()
@Module({
  // #884 — the controller narrows titles through RecordsService; RecordsModule reaches this module via MentionsModule.
  imports: [forwardRef(() => RecordsModule)],
  controllers: [NotificationsController],
  providers: [NotificationsService],
  exports: [NotificationsService],
})
export class NotificationsModule {}
