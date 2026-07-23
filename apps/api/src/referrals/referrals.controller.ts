import { Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { AuthGuard } from '../auth/auth.guard';
import type { AuthedRequest } from '../auth/auth.guard';
import { StripeService } from '../billing/stripe.service';
import { env } from '../config/env';
import { REFERRAL_TERMS } from './referrals.terms';
import { ReferralsService } from './referrals.service';

class AttributeDto extends createZodDto(z.object({ code: z.string().min(1).max(64) })) {}

/**
 * #33 — cloud referral program. User-scoped (not workspace-scoped): a
 * referral link belongs to a person, not a workspace, so this sits next to
 * `/me` rather than under `/workspaces/:ws/...` like billing does.
 *
 * `enabled` mirrors MN-166's `StripeService.enabled` flag exactly (see
 * BillingController.status's own comment) — this is the existing
 * cloud-vs-self-host signal in this codebase; the settings nav hides the
 * "Referrals" link entirely when it's false, same as it does for Billing.
 */
@ApiTags('referrals')
@Controller('referrals')
export class ReferralsController {
  constructor(
    private readonly referrals: ReferralsService,
    private readonly stripe: StripeService,
  ) {}

  @Get('me')
  @UseGuards(AuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'This user’s referral link, code, and rewards summary' })
  async me(@Req() req: AuthedRequest) {
    if (!this.stripe.enabled) {
      return { enabled: false, code: null, link: null, signups: 0, paidConversions: 0, rewardCents: 0, terms: REFERRAL_TERMS };
    }
    const summary = await this.referrals.getSummary(req.user.id, env().WEB_URL);
    return { enabled: true, ...summary, terms: REFERRAL_TERMS };
  }

  @Post('attribute')
  @UseGuards(AuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Attribute the current user as referred by a code (first-touch, one-time, best-effort)' })
  async attribute(@Req() req: AuthedRequest, @Body() body: AttributeDto) {
    if (!this.stripe.enabled) return { attributed: false };
    return this.referrals.attribute(req.user.id, body.code);
  }
}
