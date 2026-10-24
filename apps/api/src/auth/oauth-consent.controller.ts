import { Body, Controller, ForbiddenException, Get, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { AuthGuard } from './auth.guard';
import type { AuthedRequest } from './auth.guard';
import { OauthConsentService } from './oauth-consent.service';

const decisionSchema = z.object({
  consent_code: z.string().min(8).max(200),
  decision: z.enum(['allow', 'deny']),
  workspace_id: z.uuid().optional(),
  access: z.enum(['read', 'write']).optional(),
});
class ConsentDecisionDto extends createZodDto(decisionSchema) {}

/**
 * #1030 — the two calls behind the OAuth consent page (`/oauth/consent` in the web app). Session only: an OAuth client or an API
 * token must never be able to approve a connection on someone's behalf.
 */
@ApiTags('auth')
@ApiBearerAuth()
@Controller('oauth/consent')
@UseGuards(AuthGuard)
export class OauthConsentController {
  constructor(private readonly consent: OauthConsentService) {}

  private session(req: AuthedRequest) {
    if (req.auth.via !== 'session') throw new ForbiddenException('Sign in as a person to approve a connection: a token cannot do this');
    return req.user.id;
  }

  @Get()
  @ApiOperation({ summary: 'What an AI client is asking for: its name, the host it redirects to, the scopes, and the workspaces you can bind it to' })
  describe(@Req() req: AuthedRequest, @Query('consent_code') code: string) {
    return this.consent.describe(this.session(req), code ?? '');
  }

  @Post()
  @ApiOperation({ summary: 'Allow (bound to one workspace and read or write) or deny an AI client; returns where to send the browser next' })
  decide(@Req() req: AuthedRequest, @Body() body: ConsentDecisionDto) {
    return this.consent.decide(this.session(req), body);
  }
}
