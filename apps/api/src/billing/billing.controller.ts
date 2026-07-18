import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Logger,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { AuthGuard } from '../auth/auth.guard';
import type { RawBodyRequest } from '../app.setup';
import { MinRole, WorkspaceAccessGuard } from '../workspaces/workspace-access.guard';
import type { WorkspaceRequest } from '../workspaces/workspace-access.guard';
import { BillingService } from './billing.service';
import { EntitlementsService } from './entitlements.service';
import { PURCHASABLE_PLANS } from './plans';
import { StripeService } from './stripe.service';

class CheckoutDto extends createZodDto(
  z.object({ plan: z.enum(PURCHASABLE_PLANS) }),
) {}

/**
 * Billing management for a workspace (MN-165). Admin-only: money is an admin
 * concern, and the entitlements the plan buys are workspace-wide. The frontend
 * (MN-166) calls checkout/portal and gets back a Stripe-hosted URL to redirect to.
 */
@ApiTags('billing')
@UseGuards(AuthGuard, WorkspaceAccessGuard)
@MinRole('admin')
@Controller('workspaces/:ws/billing')
export class BillingController {
  constructor(
    private readonly billing: BillingService,
    private readonly entitlements: EntitlementsService,
    private readonly stripe: StripeService,
  ) {}

  /**
   * MN-166: one round-trip for the settings page. `enabled` reflects whether
   * Stripe is configured on this instance at all (false on self-host, where
   * getStatus() would otherwise indistinguishably also say "Free") — the
   * frontend uses it to hide the whole billing section, not just show Free.
   */
  @Get()
  @ApiOperation({ summary: 'Plan, status, usage vs limits, and whether billing is configured' })
  async status(@Req() req: WorkspaceRequest) {
    const workspaceId = req.membership.workspaceId;
    const [status, usage, limits] = await Promise.all([
      this.billing.getStatus(workspaceId),
      this.entitlements.getUsage(workspaceId),
      this.entitlements.getLimits(workspaceId),
    ]);
    return { ...status, enabled: this.stripe.enabled, usage, limits };
  }

  @Post('checkout')
  @ApiOperation({ summary: 'Create a Stripe Checkout session for a plan; returns a redirect URL' })
  async checkout(@Req() req: WorkspaceRequest, @Body() body: CheckoutDto) {
    const url = await this.billing.createCheckoutSession(req.membership.workspaceId, body.plan);
    return { url };
  }

  @Post('portal')
  @ApiOperation({ summary: 'Create a Stripe Customer Portal session; returns a redirect URL' })
  async portal(@Req() req: WorkspaceRequest) {
    const url = await this.billing.createPortalSession(req.membership.workspaceId);
    return { url };
  }

  @Post('trial')
  @ApiOperation({ summary: 'Start the 30-day Pro trial (no card, no Stripe subscription yet)' })
  startTrial(@Req() req: WorkspaceRequest) {
    return this.billing.startTrial(req.membership.workspaceId);
  }
}

/**
 * Exact path of the webhook route, so app.setup can put it — and only it — on
 * the raw-body allowlist. If this string and the controller route drift apart,
 * the signature has no bytes to verify and every delivery 400s: loud, not silent.
 * (Mirrors GITHUB_WEBHOOK_PATH.)
 */
export const BILLING_WEBHOOK_PATH = '/api/v1/billing/webhook';

/**
 * Inbound Stripe deliveries. Unauthenticated by necessity — Stripe holds no
 * session — so the `stripe-signature` HMAC over the RAW body is the only trust
 * anchor. It is verified before the payload is parsed as an event, and handling
 * is idempotent (billing_events) so Stripe's retries are safe.
 */
@ApiTags('billing')
@Controller('billing')
export class BillingWebhookController {
  private readonly logger = new Logger(BillingWebhookController.name);

  constructor(private readonly billing: BillingService, private readonly stripe: StripeService) {}

  @Post('webhook')
  @HttpCode(200)
  @ApiOperation({ summary: 'Stripe webhook receiver — signature-verified, unauthenticated by design' })
  async receive(@Req() req: RawBodyRequest, @Headers('stripe-signature') signature?: string) {
    if (!req.rawBody || !signature) {
      throw new BadRequestException('Missing Stripe signature or body.');
    }
    let event;
    try {
      event = this.stripe.constructEvent(req.rawBody, signature);
    } catch (err) {
      // A bad signature is a 400 so Stripe retries; an unverified body is never
      // read as an event.
      this.logger.warn(`Stripe signature verification failed: ${(err as Error).message}`);
      throw new BadRequestException('Invalid Stripe signature.');
    }
    await this.billing.applyEvent(event);
    return { received: true };
  }
}
