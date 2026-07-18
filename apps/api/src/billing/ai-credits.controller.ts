import { Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { AuthGuard } from '../auth/auth.guard';
import { MinRole, WorkspaceAccessGuard } from '../workspaces/workspace-access.guard';
import type { WorkspaceRequest } from '../workspaces/workspace-access.guard';
import { AiCreditsService } from './ai-credits.service';
import { AI_CREDIT_MIN_TOPUP_USD } from './plans';

class TopUpDto extends createZodDto(
  z.object({ amount_usd: z.number().min(AI_CREDIT_MIN_TOPUP_USD) }),
) {}

class AutoReloadDto extends createZodDto(
  z.object({
    enabled: z.boolean(),
    threshold_usd: z.number().positive().optional(),
    amount_usd: z.number().min(AI_CREDIT_MIN_TOPUP_USD).optional(),
  }),
) {}

/**
 * MN-189 — StoryOS AI prepaid credits, in-app management. Admin-only, same
 * boundary as BillingController: money is an admin concern.
 */
@ApiTags('billing')
@UseGuards(AuthGuard, WorkspaceAccessGuard)
@MinRole('admin')
@Controller('workspaces/:ws/billing/ai-credits')
export class AiCreditsController {
  constructor(private readonly aiCredits: AiCreditsService) {}

  @Get()
  @ApiOperation({ summary: 'Current AI credit balance, auto-reload config, and card-on-file status' })
  async status(@Req() req: WorkspaceRequest) {
    const workspaceId = req.membership.workspaceId;
    const [balance, hasCard] = await Promise.all([
      this.aiCredits.getBalance(workspaceId),
      this.aiCredits.hasPaymentMethod(workspaceId),
    ]);
    return { ...balance, hasPaymentMethod: hasCard };
  }

  @Post('top-up')
  @ApiOperation({ summary: 'Create a one-time Checkout session to add credits; returns a redirect URL' })
  async topUp(@Req() req: WorkspaceRequest, @Body() body: TopUpDto) {
    const url = await this.aiCredits.createTopUpSession(req.membership.workspaceId, body.amount_usd);
    return { url };
  }

  @Post('auto-reload')
  @ApiOperation({ summary: 'Configure (or disable) auto-reload' })
  async autoReload(@Req() req: WorkspaceRequest, @Body() body: AutoReloadDto) {
    await this.aiCredits.setAutoReload(req.membership.workspaceId, {
      enabled: body.enabled,
      thresholdCents: body.threshold_usd ? Math.round(body.threshold_usd * 100) : undefined,
      amountCents: body.amount_usd ? Math.round(body.amount_usd * 100) : undefined,
    });
    return this.aiCredits.getBalance(req.membership.workspaceId);
  }
}
