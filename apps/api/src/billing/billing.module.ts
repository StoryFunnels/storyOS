import { Module } from '@nestjs/common';
import { AccessModule } from '../access/access.module';
import { BillingController, BillingWebhookController } from './billing.controller';
import { BillingService } from './billing.service';
import { EntitlementsService } from './entitlements.service';
import { StripeService } from './stripe.service';

/**
 * MN-165/MN-168/MN-190 — billing spine + entitlements. Wires the Stripe
 * client, the plan projection service, the entitlements/metering read path,
 * the admin-facing management endpoints and the signature-verified webhook.
 * AccessModule supplies the billable-seat count (MN-190's predicate).
 *
 * Deliberately NOT importing WorkspacesModule: WorkspaceAccessGuard (used via
 * @UseGuards in billing.controller.ts) only depends on DB (@Global()) and
 * Nest's built-in Reflector, both globally resolvable — Nest instantiates the
 * guard class directly without it needing to be a registered provider here.
 * Not importing it is what breaks the cycle MN-190 would otherwise create:
 * WorkspacesModule needs EntitlementsService/BillingService (seat checks on
 * invite/role-change), which would make WorkspacesModule -> BillingModule ->
 * WorkspacesModule circular if this import stayed.
 */
@Module({
  imports: [AccessModule],
  controllers: [BillingController, BillingWebhookController],
  providers: [StripeService, BillingService, EntitlementsService],
  exports: [BillingService, EntitlementsService],
})
export class BillingModule {}
