import { Module } from '@nestjs/common';
import { StripeService } from '../billing/stripe.service';
import { ReferralsController } from './referrals.controller';
import { ReferralsService } from './referrals.service';

/**
 * #33 — referral program. This module is imported BY BillingModule (so
 * BillingService can call ReferralsService.recordConversionIfEligible on
 * conversion) — importing BillingModule back for its StripeService would be
 * circular, and BillingModule doesn't export StripeService anyway. StripeService
 * has no dependencies of its own (env() only), so declaring it as its own
 * provider here — a second, independent instance from BillingModule's — is
 * cheaper than threading an export/import just for this one stateless
 * wrapper.
 */
@Module({
  controllers: [ReferralsController],
  providers: [ReferralsService, StripeService],
  exports: [ReferralsService],
})
export class ReferralsModule {}
