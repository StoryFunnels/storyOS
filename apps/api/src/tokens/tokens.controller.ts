import { Body, Controller, Delete, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { AuthGuard } from '../auth/auth.guard';
import type { AuthedRequest } from '../auth/auth.guard';
import { TokensService } from './tokens.service';

const createTokenSchema = z.object({
  name: z.string().trim().min(1).max(100),
  workspace_id: z.uuid(),
});
class CreateTokenDto extends createZodDto(createTokenSchema) {}

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
    return this.tokens.create(req.user.id, body.workspace_id, body.name);
  }

  @Delete(':token')
  @ApiOperation({ summary: 'Revoke a token (immediate)' })
  revoke(@Req() req: AuthedRequest, @Param('token') tokenId: string) {
    return this.tokens.revoke(req.user.id, tokenId);
  }
}
