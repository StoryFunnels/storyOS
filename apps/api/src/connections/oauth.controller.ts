import { BadRequestException, Controller, Get, Query, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';
import { env } from '../config/env';
import { ConnectionsService } from './connections.service';

function redirect(reply: FastifyReply, url: string): void {
  void reply.header('location', url).code(302).send();
}

/**
 * MN-252 — the OAuth2 return leg. **Unauthenticated** — the provider redirects
 * the browser here — so a signed `state` (not any request-supplied workspace
 * id) is what proves which workspace/admin started the connect (CSRF), exactly
 * like integrations/integrations.controller.ts's GithubOAuthController.
 *
 * State is verified BEFORE anything provider-specific: an invalid/expired/
 * tampered state is rejected without ever touching the registry, so a bad
 * state can't be used to probe which providers exist or are configured.
 */
@ApiTags('connections')
@Controller('connections/oauth')
export class ConnectionsOAuthController {
  constructor(private readonly connections: ConnectionsService) {}

  @Get('callback')
  @ApiOperation({ summary: 'OAuth2 callback — verifies state, exchanges the code, seals the tokens' })
  async callback(
    @Res() reply: FastifyReply,
    @Query('state') state?: string,
    @Query('code') code?: string,
    @Query('error') providerError?: string,
  ) {
    const verified = this.connections.verifyOAuthState(state);
    if (!verified) throw new BadRequestException('Invalid or expired OAuth state');

    if (providerError || !code) {
      redirect(
        reply,
        `${env().WEB_URL}/w/${verified.ws}/settings/connections?error=${encodeURIComponent(providerError ?? 'missing_code')}`,
      );
      return;
    }

    await this.connections.completeOAuth(verified, code);
    redirect(reply, `${env().WEB_URL}/w/${verified.ws}/settings/connections?connected=${verified.provider}`);
  }
}
