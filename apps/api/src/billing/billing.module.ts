import { Module } from '@nestjs/common';
import { AccessModule } from '../access/access.module';
import { WorkspacesModule } from '../workspaces/workspaces.module';
import { BillingController, BillingWebhookController } from './billing.controller';
import { BillingService } from './billing.service';
import { StripeService } from './stripe.service';

/**
 * MN-165 — billing spine. Wires the Stripe client, the plan projection service,
 * the admin-facing management endpoints and the signature-verified webhook.
 * AccessModule supplies the billable-seat count (MN-190's predicate).
 */
@Module({
  imports: [AccessModule, WorkspacesModule],
  controllers: [BillingController, BillingWebhookController],
  providers: [StripeService, BillingService],
  exports: [BillingService],
})
export class BillingModule {}
