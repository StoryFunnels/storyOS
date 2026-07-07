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
    return { id, email, name, image: image ?? null, email_verified: emailVerified };
  }

  @Get('auth/providers')
  @ApiOperation({ summary: 'Enabled auth providers (google appears only when configured)' })
  providers() {
    return { providers: enabledProviders() };
  }
}
