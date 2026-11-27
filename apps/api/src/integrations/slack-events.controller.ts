import { Controller, Headers, HttpCode, Post, Req, UnauthorizedException } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { RawBodyRequest } from '../app.setup';
import { SlackEventsService } from './slack-events.service';
import { verifySlackSignature } from './slack-signature';

/**
 * Ticket #1379 - the Slack Events API receiver (`link_shared`, for link previews).
 *
 * UNAUTHENTICATED BY NECESSITY: Slack holds no StoryOS session, so no AuthGuard and no workspace in the path (an unauthenticated
 * `:ws` would be a parameter for a stranger to probe). The request signature IS the authentication: `SLACK_SIGNING_SECRET` is read
 * from the environment on every request, and with it unset, empty or blank NOTHING verifies and every delivery is a 401 (fail
 * closed). A 401 carries no reason, so a missing secret, a stale timestamp, a bad signature and a missing header look the same.
 *
 * It is subject to the same global per-IP rate limit as the other public receivers (the GitHub and Shopify webhooks): Slack's
 * volume for one app is far under it, and a flood of forged requests is cut off before it costs more than a header check.
 * There is no CSRF concern: no cookie or session is read, and the only thing a request can do is make us ask Slack to unfurl.
 */
@ApiTags('integrations')
@Controller('integrations/slack')
export class SlackEventsController {
  constructor(private readonly events: SlackEventsService) {}

  @Post('events')
  // 200, not Nest's default 201: this is an acknowledgement, and Slack reads anything else as a failed delivery.
  @HttpCode(200)
  @ApiOperation({ summary: 'Slack Events API receiver (link previews) - signature-verified, unauthenticated by design' })
  receive(
    @Req() req: RawBodyRequest,
    @Headers('x-slack-signature') signature?: string,
    @Headers('x-slack-request-timestamp') timestamp?: string,
  ) {
    // req.rawBody, not req.body: the signature is over the bytes Slack sent.
    const verified = verifySlackSignature({
      signingSecret: process.env.SLACK_SIGNING_SECRET,
      timestamp,
      signature,
      rawBody: req.rawBody,
    });
    if (!verified || !req.rawBody) throw new UnauthorizedException();
    return this.events.handle(req.rawBody);
  }
}
