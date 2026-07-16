import { Body, Controller, Delete, ForbiddenException, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { tokenScopeSchema } from '@storyos/schemas';
import { AuthGuard } from '../auth/auth.guard';
import type { AuthedRequest } from '../auth/auth.guard';
import { TokensService } from './tokens.service';

const createTokenSchema = z.object({
  name: z.string().trim().min(1).max(100),
  workspace_id: z.uuid(),
  // MN-134: read | write | admin. Defaults to admin so the existing flow is
  // unchanged, but the UI/agent should choose deliberately.
  scope: tokenScopeSchema.default('admin'),
  /** Withhold run_button even from a write-scoped token. */
  allow_run_button: z.boolean().default(true),
});
class CreateTokenDto extends createZodDto(createTokenSchema) {}

/**
 * MN-122: token management is session-only.
 *
 * Scoping a PAT to one workspace is worthless if that PAT can mint another one:
 * a leaked workspace-A token would just call this endpoint for workspace B and
 * walk around the scope. Minting and revoking credentials requires a real login.
 */
function assertSession(req: AuthedRequest, action: string): void {
  if (req.auth?.via !== 'session') {
    throw new ForbiddenException(`Sign in to ${action} — an API token cannot manage tokens`);
  }
}

@ApiTags('tokens')
@ApiBearerAuth()
@Controller('me/tokens')
@UseGuards(AuthGuard)
export class TokensController {
  constructor(private readonly tokens: TokensService) {}

  @Get()
  @ApiOperation({ summary: 'My personal access tokens (prefix only — plaintext is never stored)' })
  list(@Req() req: AuthedRequest) {
    return this.tokens.list(req.user.id);
  }

  @Post()
  @ApiOperation({ summary: 'Create a PAT — the token is shown ONCE in this response' })
  create(@Req() req: AuthedRequest, @Body() body: CreateTokenDto) {
    assertSession(req, 'create a token');
    return this.tokens.create(
      req.user.id,
      body.workspace_id,
      body.name,
      body.scope,
      body.allow_run_button,
    );
  }

  @Delete(':token')
  @ApiOperation({ summary: 'Revoke a token (immediate)' })
  revoke(@Req() req: AuthedRequest, @Param('token') tokenId: string) {
    assertSession(req, 'revoke a token');
    return this.tokens.revoke(req.user.id, tokenId);
  }
}
