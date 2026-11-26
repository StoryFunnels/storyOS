import { Body, Controller, Get, HttpCode, Param, Post, Req, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { disablePublishingSchema, enablePublishingSchema } from '@storyos/schemas';
import { AuthGuard } from '../auth/auth.guard';
import { assertHumanSource } from '../auth/assert-human-source';
import { NoRunCredential, RequiresScope } from '../auth/token-scope.guard';
import { WorkspaceAccessGuard } from '../workspaces/workspace-access.guard';
import type { WorkspaceRequest } from '../workspaces/workspace-access.guard';
import { PublishingService } from './publishing.service';

class EnablePublishingDto extends createZodDto(enablePublishingSchema) {}
class DisablePublishingDto extends createZodDto(disablePublishingSchema) {}

/**
 * Ticket #456 - the guided "Turn on publishing" flow for the Social Command Center's Posts database. See PublishingService for what it adds
 * over the generic automation calls, and packages/schemas/src/publishing.ts for the contract (the unmet codes are the stable part).
 *
 * Access is the database's: whoever can create automations there may turn publishing on or off, and the account picker's own rule still
 * applies underneath (a workspace admin or the person who connected the account). Turning publishing ON needs a person: a run credential
 * is refused (@NoRunCredential) and so is any non-human source (assertHumanSource), because "an agent that decides where the company
 * posts" is the exact thing this gate exists to prevent. Pausing is the safe direction and is open to any credential that may edit rules.
 */
@ApiTags('publishing')
@ApiBearerAuth()
@UseGuards(AuthGuard, WorkspaceAccessGuard)
@Controller('workspaces/:ws/databases/:db/publishing')
export class PublishingController {
  constructor(private readonly publishing: PublishingService) {}

  @Get()
  @RequiresScope('read')
  @ApiOperation({
    summary:
      "Publishing setup for the Social Command Center's Posts database: whether a publish rule exists and is on, which connections and networks are available, what blocks turning it on (coded), the pack's field ids and the rule to create. Someone who cannot manage rules gets only `can_manage: false`.",
  })
  setup(@Req() req: WorkspaceRequest, @Param('db') databaseId: string) {
    return this.publishing.setup(req.membership, databaseId, (req.auth?.source ?? 'human') === 'human');
  }

  @Post('enable')
  @HttpCode(200)
  // `write`, not `admin`, like every other @NoRunCredential route: admin scope would refuse a run credential first, for a different reason, and hide this marker. A token of any scope is refused by assertHumanSource below.
  @RequiresScope('write')
  @NoRunCredential()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({
    summary:
      'Turn on publishing for ONE network: saves the publish rule (Status becomes Scheduled -> post Text and Media, save Post URL) with the named connection and account, switched on. Idempotent. 422 with every unmet prerequisite as `unmet[].code`. A person only (never a run credential, token or connected AI). Posts nothing itself.',
  })
  enable(@Req() req: WorkspaceRequest, @Param('db') databaseId: string, @Body() body: EnablePublishingDto) {
    assertHumanSource(req);
    return this.publishing.enable(req.membership, req.user.id, databaseId, body, req.auth?.source ?? 'human');
  }

  @Post('disable')
  @HttpCode(200)
  @RequiresScope('admin')
  @ApiOperation({
    summary: "Pause publishing: switches off the Posts database's publish rules (one network, or all). Idempotent; nothing is deleted, so turning it back on is one call.",
  })
  disable(@Req() req: WorkspaceRequest, @Param('db') databaseId: string, @Body() body: DisablePublishingDto) {
    return this.publishing.disable(req.membership, req.user.id, databaseId, body, req.auth?.source ?? 'human');
  }
}
