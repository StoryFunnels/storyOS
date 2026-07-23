import { createHmac, timingSafeEqual } from 'node:crypto';
import { Controller, Headers, HttpCode, Inject, Logger, Param, Post, Req, UnauthorizedException } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { eq, sql } from 'drizzle-orm';
import { DB } from '../db/db.module';
import type { Db } from '../db/client';
import { connections } from '../db/schema';
import { open } from '../common/secretbox';
import type { RawBodyRequest } from '../app.setup';
import { NotificationsService } from '../notifications/notifications.service';
import type { ResendAuth } from './providers/resend';

/**
 * Path PREFIX (not an exact path — `:connectionId` varies), so app.setup.ts's
 * raw-body allowlist can match every delivery here — same reason
 * HOOKS_PATH_PREFIX (automations/hooks.controller.ts) is a prefix, not the
 * exact-match GITHUB_WEBHOOK_PATH/BILLING_WEBHOOK_PATH.
 */
export const RESEND_WEBHOOK_PATH_PREFIX = '/api/v1/providers/resend/webhook/';

const BOUNCE_STREAK_THRESHOLD = 5;

/**
 * Resend's Svix-signed webhook format: `svix-id`/`svix-timestamp` sign the
 * content `${id}.${timestamp}.${rawBody}`, HMAC-SHA256'd with the base64
 * portion of a `whsec_...` secret, base64-encoded; `svix-signature` carries
 * one or more space-separated `v1,<base64>` tokens (key rotation sends
 * several) — a match against ANY of them is a valid signature.
 */
export function verifySvixSignature(
  secret: string,
  svixId: string,
  svixTimestamp: string,
  rawBody: Buffer,
  signatureHeader: string,
): boolean {
  let secretBytes: Buffer;
  try {
    secretBytes = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  } catch {
    return false;
  }
  const signedContent = `${svixId}.${svixTimestamp}.${rawBody.toString('utf8')}`;
  const expected = createHmac('sha256', secretBytes).update(signedContent).digest('base64');
  const expectedBuf = Buffer.from(expected, 'utf8');
  return signatureHeader
    .trim()
    .split(/\s+/)
    .some((token) => {
      const sig = token.includes(',') ? token.split(',')[1] : token;
      if (!sig) return false;
      const sigBuf = Buffer.from(sig, 'utf8');
      return sigBuf.length === expectedBuf.length && timingSafeEqual(sigBuf, expectedBuf);
    });
}

/**
 * MN-256 Step 5 — bounce/complaint degradation. Per-CONNECTION, not
 * per-instance: each workspace's own Resend account owns its own webhook
 * (pointed at THIS connection's own `:connectionId` URL) and its own signing
 * secret (`ResendAuth.webhook_secret`, set alongside `api_key` when
 * connecting) — there is no single instance-level secret the way
 * GITHUB_APP_WEBHOOK_SECRET is for the GitHub App path, so the URL's
 * connection id both names the tenant and scopes which secret verifies it.
 *
 * Unauthenticated by necessity (Resend holds no session) — every failure
 * mode is a 401 with no further detail, the same "leak nothing" posture
 * hooks.controller.ts documents for its own inbound receiver: an unknown
 * connection, a non-Resend connection, one with no `webhook_secret`
 * configured yet, and a bad signature are all indistinguishable from outside.
 *
 * Self-hosted SMTP connections have no equivalent: there is no Resend
 * account, hence no webhook to receive — bounce/complaint handling for SMTP
 * is left entirely to whatever the underlying relay/provider offers on its
 * own (documented in the `smtp` provider's own file, connections/providers/smtp.ts).
 */
@ApiTags('connections')
@Controller('providers/resend')
export class ResendWebhookController {
  private readonly logger = new Logger(ResendWebhookController.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly notifications: NotificationsService,
  ) {}

  @Post('webhook/:connectionId')
  @HttpCode(200)
  @ApiOperation({ summary: 'Resend bounce/complaint webhook for one connection — signature-verified, unauthenticated by design' })
  async receive(
    @Param('connectionId') connectionId: string,
    @Req() req: RawBodyRequest,
    @Headers('svix-id') svixId?: string,
    @Headers('svix-timestamp') svixTimestamp?: string,
    @Headers('svix-signature') svixSignature?: string,
  ): Promise<{ received: true }> {
    const row = await this.db.query.connections.findFirst({ where: eq(connections.id, connectionId) });
    if (!row || row.provider !== 'resend' || !req.rawBody || !svixId || !svixTimestamp || !svixSignature) {
      throw new UnauthorizedException();
    }
    let auth: Partial<ResendAuth>;
    try {
      auth = JSON.parse(open(row.authSealed)) as Partial<ResendAuth>;
    } catch {
      throw new UnauthorizedException();
    }
    if (!auth.webhook_secret || !verifySvixSignature(auth.webhook_secret, svixId, svixTimestamp, req.rawBody, svixSignature)) {
      throw new UnauthorizedException();
    }

    let event: { type?: string };
    try {
      event = JSON.parse(req.rawBody.toString('utf8')) as { type?: string };
    } catch {
      return { received: true }; // well-signed but unparseable — ack, nothing actionable
    }
    if (event.type === 'email.bounced' || event.type === 'email.complained') {
      await this.degrade(row);
    }
    return { received: true };
  }

  /**
   * Reuses `connections.errorStreak` — the SAME running counter MN-253's
   * circuit breaker uses — rather than a new time-windowed column (no
   * migration in flight for this ticket). Known simplification vs. a strict
   * "5 in 24h": any unrelated successful send on this connection resets the
   * streak to 0 (JobRunnerService.finalizeSuccess), so this is closer to "5
   * consecutive bounces/complaints since the last successful send" than a
   * true rolling day window — documented here rather than silently assumed.
   */
  private async degrade(row: typeof connections.$inferSelect): Promise<void> {
    const [updated] = await this.db
      .update(connections)
      .set({ errorStreak: sql`${connections.errorStreak} + 1` })
      .where(eq(connections.id, row.id))
      .returning({ errorStreak: connections.errorStreak });
    if (!updated || updated.errorStreak < BOUNCE_STREAK_THRESHOLD) return;
    await this.db.update(connections).set({ status: 'error' }).where(eq(connections.id, row.id));
    if (!row.createdBy) return;
    await this.notifications
      .notify({
        workspaceId: row.workspaceId,
        actorId: row.createdBy,
        type: 'connection_error',
        recipients: [row.createdBy],
        snippet: `"${row.name}" (Resend) has repeated bounces/complaints — sending is blocked until reconnected`,
        allowSelf: true,
      })
      .catch((error: unknown) => this.logger.warn(`bounce-degrade notify failed: ${String(error)}`));
  }
}
