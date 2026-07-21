import {
  BadRequestException,
  Controller,
  Headers,
  HttpCode,
  HttpException,
  HttpStatus,
  Logger,
  NotFoundException,
  Param,
  PayloadTooLargeException,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { RawBodyRequest } from '../app.setup';
import { verifySignature } from '../webhooks/webhook-sender';
import { AutomationsService } from './automations.service';
import { HookRateLimiterService } from './hook-rate-limiter.service';

/**
 * Path prefix (not an exact path — `:workspaceSlug/:hookToken` vary) so
 * app.setup.ts's raw-body allowlist can match every delivery here, the same
 * way it matches the exact GITHUB_WEBHOOK_PATH / BILLING_WEBHOOK_PATH.
 */
export const HOOKS_PATH_PREFIX = '/api/v1/hooks/';

/** Fastify's app-wide bodyLimit is 3MB; a hook delivery gets a tighter cap. */
const MAX_HOOK_BODY_BYTES = 256 * 1024;
/** Signed like an outgoing webhook: timestamp inside the signed string, checked for age. */
const TIMESTAMP_TOLERANCE_SECONDS = 5 * 60;

/**
 * Public inbound webhook receiver (MN-254) — deliberately carries no
 * AuthGuard, the same way PublicFormsController doesn't: the hook token in
 * the URL *is* the credential, and an optional HMAC layers on top of it.
 * Every failure mode here is calibrated to leak nothing:
 *
 *   unknown token / disabled rule / wrong trigger  -> 404, no detail
 *   hookSecret set, signature missing or wrong      -> 401
 *   over the per-hook rate                          -> 429
 *   over the size cap                                -> 413
 *
 * None of those execute a single action. A valid delivery gets a 202 with a
 * run id immediately; the actions themselves run after the reply is sent
 * (AutomationsService.startHookRun), so a slow action list never holds a
 * webhook sender's connection open.
 */
@ApiTags('hooks')
@Controller('hooks')
export class HooksController {
  private readonly logger = new Logger(HooksController.name);

  constructor(
    private readonly automations: AutomationsService,
    private readonly rateLimiter: HookRateLimiterService,
  ) {}

  @Post(':workspaceSlug/:hookToken')
  @HttpCode(202)
  @ApiOperation({ summary: 'Inbound webhook receiver for a webhook_received automation rule' })
  async receive(
    @Param('workspaceSlug') workspaceSlug: string,
    @Param('hookToken') hookToken: string,
    @Req() req: RawBodyRequest,
    @Headers('x-storyos-signature') signature?: string,
    @Headers('x-storyos-timestamp') timestampHeader?: string,
    @Headers('content-type') contentType?: string,
  ): Promise<{ run_id: string }> {
    // Rate-limit on the raw token before touching the DB — a flood aimed at
    // one hook (valid or not) shouldn't cost a query per request.
    if (!this.rateLimiter.hit(hookToken)) {
      throw new HttpException(
        'Too many requests to this hook — try again in a minute.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const rule = await this.automations.findByHookToken(workspaceSlug, hookToken);
    if (!rule) throw new NotFoundException(); // no detail — indistinguishable from "never existed"

    const raw = req.rawBody;
    if (raw && raw.length > MAX_HOOK_BODY_BYTES) {
      throw new PayloadTooLargeException(
        `Request body exceeds the ${MAX_HOOK_BODY_BYTES / 1024}KB limit for inbound webhooks.`,
      );
    }

    if (rule.hookSecret) {
      if (!raw || !signature || !timestampHeader) {
        throw new UnauthorizedException('Missing signature.');
      }
      const timestamp = Number(timestampHeader);
      if (
        !Number.isFinite(timestamp) ||
        Math.abs(Date.now() / 1000 - timestamp) > TIMESTAMP_TOLERANCE_SECONDS
      ) {
        throw new UnauthorizedException('Signature timestamp is missing or outside tolerance.');
      }
      if (!verifySignature(rule.hookSecret, raw.toString('utf8'), timestamp, signature)) {
        throw new UnauthorizedException('Invalid signature.');
      }
    }

    const payload = this.parseBody(raw, contentType);
    const runId = this.automations.startHookRun(rule, rule.workspaceId, payload);
    return { run_id: runId };
  }

  /**
   * JSON or form-encoded only (per the ticket's scope) — anything else is a
   * 400, not a best-effort guess. Both content types arrive already parsed
   * into an object by app.setup.ts's content-type parsers; this only chooses
   * between them and rejects the rest.
   */
  private parseBody(
    raw: Buffer | undefined,
    contentType: string | undefined,
  ): Record<string, unknown> {
    if (!raw || raw.length === 0) return {};
    const type = (contentType ?? '').split(';')[0]?.trim().toLowerCase();
    if (type === 'application/x-www-form-urlencoded') {
      return Object.fromEntries(new URLSearchParams(raw.toString('utf8')).entries());
    }
    if (type === 'application/json' || type === '') {
      try {
        const parsed: unknown = JSON.parse(raw.toString('utf8'));
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
          return parsed as Record<string, unknown>;
        return { value: parsed };
      } catch {
        throw new BadRequestException('Body must be valid JSON.');
      }
    }
    this.logger.warn(`hook delivery with unsupported content-type "${contentType ?? 'none'}"`);
    throw new BadRequestException(
      'Content-Type must be application/json or application/x-www-form-urlencoded.',
    );
  }
}
