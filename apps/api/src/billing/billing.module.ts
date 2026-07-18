import { Module } from '@nestjs/common';
import { AccessModule } from '../access/access.module';
import { WorkspacesModule } from '../workspaces/workspaces.module';
import { BillingController, BillingWebhookController } from './billing.controller';
import { BillingService } from './billing.service';
import { EntitlementsService } from './entitlements.service';
import { StripeService } from './stripe.service';

/**
 * MN-165/MN-168 — billing spine + entitlements. Wires the Stripe client, the
 * plan projection service, the entitlements/metering read path, the
 * admin-facing management endpoints and the signature-verified webhook.
 * AccessModule supplies the billable-seat count (MN-190's predicate).
 */
@Module({
  imports: [AccessModule, WorkspacesModule],
  controllers: [BillingController, BillingWebhookController],
  providers: [StripeService, BillingService, EntitlementsService],
  exports: [BillingService, EntitlementsService],
})
export class BillingModule {}
