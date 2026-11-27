import { Module } from '@nestjs/common';
import { SlackService } from './slack.service';
import { SlackSubscriptionsController } from './slack-subscriptions.controller';
import { SlackSubscriptionsService } from './slack-subscriptions.service';

/**
 * Ticket #1377. Its own module, imported by CollaborationModule (CommentsService calls `onCommented`; that import also mounts the
 * controller), so CollaborationModule does not have to import the whole IntegrationsModule (the same reason it provides SlackService
 * directly, see its comment). The service holds the delivery queue, so there must be ONE instance of it.
 */
@Module({
  controllers: [SlackSubscriptionsController],
  providers: [SlackService, SlackSubscriptionsService],
  exports: [SlackSubscriptionsService],
})
export class SlackSubscriptionsModule {}
