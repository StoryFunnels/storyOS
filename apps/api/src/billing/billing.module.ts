import { Module } from '@nestjs/common';
import { AccessModule } from '../access/access.module';
import { AiCreditsController } from './ai-credits.controller';
import { AiCreditsService } from './ai-credits.service';
import { AutoReloadRetryService } from './auto-reload-retry.service';
import { BillingController, BillingWebhookController } from './billing.controller';
import { BillingService } from './billing.service';
import { EntitlementsService } from './entitlements.service';
import { StripeService } from './stripe.service';
import { TrialRemindersService } from './trial-reminders.service';

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
 *
 * TrialRemindersService (#263) needs NotificationsService and EmailService,
 * but both NotificationsModule and MailModule are `@Global()` (like DbModule)
 * so they resolve without being listed here — same reason AccessModule is the
 * only explicit import for BillingService's own dependency. AiCreditsService
 * (#265) now needs the same two for its auto-reload failure notifications,
 * for the same reason.
 *
 * AutoReloadRetryService (#265) is the backoff-retry sweep for auto-reload's
 * off-session charge — see its own doc comment; it only depends on
 * AiCreditsService (already a provider here) and DB.
 */
@Module({
  imports: [AccessModule],
  controllers: [BillingController, BillingWebhookController, AiCreditsController],
  providers: [
    StripeService,
    BillingService,
    EntitlementsService,
    AiCreditsService,
    TrialRemindersService,
    AutoReloadRetryService,
  ],
  exports: [BillingService, EntitlementsService, AiCreditsService],
})
export class BillingModule {}
