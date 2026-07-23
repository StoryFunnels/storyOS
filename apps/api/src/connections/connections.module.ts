import { Module } from '@nestjs/common';
import { NotificationsModule } from '../notifications/notifications.module';
import { ConnectionsController } from './connections.controller';
import { ConnectionsOAuthController } from './oauth.controller';
import { ConnectionsService } from './connections.service';
import { ResendWebhookController } from './resend-webhook.controller';

/**
 * MN-252 — the workspace credential registry. Exported (ConnectionsService)
 * so the follow-up tickets it unblocks (post_social, http_request, the Apify
 * source, send_email…) can import it exactly like automations.module.ts
 * imports IntegrationsModule today.
 */
@Module({
  imports: [NotificationsModule],
  controllers: [ConnectionsController, ConnectionsOAuthController, ResendWebhookController],
  providers: [ConnectionsService],
  exports: [ConnectionsService],
})
export class ConnectionsModule {}
