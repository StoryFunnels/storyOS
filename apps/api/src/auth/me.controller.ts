import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthGuard } from './auth.guard';
import type { AuthedRequest } from './auth.guard';
import { enabledProviders } from './auth';

@ApiTags('auth')
@Controller()
export class MeController {
  @Get('me')
  @UseGuards(AuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Current authenticated user' })
  me(@Req() req: AuthedRequest) {
    const { id, email, name, image, emailVerified } = req.user;
    // MN-134: how you're authed + a scoped token's ceiling, so the MCP can trim
    // its advertised tools to what the token can actually do. A session is full.
    return {
      id,
      email,
      name,
      image: image ?? null,
      email_verified: emailVerified,
      auth: {
        via: req.auth?.via ?? 'session',
        token_scope: req.auth?.tokenScope ?? null,
        allow_run_button: req.auth?.via === 'token' ? req.auth.allowRunButton ?? true : true,
      },
    };
  }

  @Get('auth/providers')
  @ApiOperation({ summary: 'Enabled auth providers (google appears only when configured)' })
  providers() {
    return { providers: enabledProviders() };
  }
}
