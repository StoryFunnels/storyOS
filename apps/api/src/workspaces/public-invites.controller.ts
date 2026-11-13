import { Controller, Get, Header, Query } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { InviteDetailsResponseDto } from './dto';
import { InvitesService } from './invites.service';

/**
 * Ticket #1302 — what the invite link says before anyone has signed in. Deliberately NO AuthGuard: the visitor has no account yet,
 * and the token in the link is the only credential. Read-only: it never accepts anything (accepting is `POST /invites/accept`,
 * or `invite_token` on `POST /workspaces`, both signed-in).
 *
 * The token is a bearer secret. It is a query value, which request logging already drops wholesale (common/request-logging.ts), is
 * never echoed in a response or an error, and the response is `no-store` so no shared cache keeps it.
 *
 * Rate limited per client IP by the global guard (an anonymous caller keys on `request.ip`, the trustProxy-aware address; a bogus
 * bearer does not mint a bucket). 192-bit tokens are not guessable, so the limit exists to keep this from being a free oracle for
 * mass probing, not to protect a small keyspace.
 */
@ApiTags('public')
@Controller('public/invites')
export class PublicInvitesController {
  constructor(private readonly invites: InvitesService) {}

  @Get('details')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Header('Cache-Control', 'no-store')
  @ApiQuery({ name: 'token', required: false, description: 'The token from the invite link' })
  @ApiOperation({
    summary:
      'What an invite link says, no sign-in: inviter name, workspace name and logo, the invited email, and whether it is valid, expired or used. ' +
      'An unknown, malformed or revoked token returns status "not_found" with every other field null (same body, so tokens cannot be probed).',
  })
  @ApiOkResponse({ type: InviteDetailsResponseDto })
  details(@Query('token') token: unknown) {
    return this.invites.details(token);
  }
}
