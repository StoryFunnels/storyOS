import { Inject, Injectable, Logger } from '@nestjs/common';
import { env } from '../config/env';
import { DB } from '../db/db.module';
import type { Db } from '../db/client';
import { currentMonthPeriodStart, incrementUsageCounter, EMAIL_SEND_METRIC } from '../billing/usage-metering';
import type { EmailInput } from './email.types';
import { renderEmail } from './templates';
import { LogMailDriver, ResendMailDriver, SmtpMailDriver } from './mail-driver';
import type { MailDriver } from './mail-driver';

/**
 * Transactional email (MN-103): invitations, @mention notifications, and
 * better-auth's verification/reset hooks all go through this one seam. Driver
 * selection happens at first send (not at boot) so tests can stub `env()`
 * freely, and precedence is:
 *
 *   RESEND_API_KEY (Resend HTTP API — the standard going forward)
 *   → SMTP_HOST (existing nodemailer transport; some deploys already point
 *     this at Resend's own SMTP relay, smtp.resend.com)
 *   → log only (dev without either configured — never crashes, same
 *     graceful degrade the previous SMTP-only mailer had).
 *
 * Sending is fire-and-forget: `send()` renders the template and hands the
 * message to the driver without awaiting the network round trip, so an
 * invite/comment/auth request never blocks on mail delivery. A delivery
 * failure is caught and logged, never thrown or re-surfaced to the caller —
 * exactly like the mailer.ts behavior this replaces.
 */
@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);
  /** Public + lazily built so tests can stub it directly (mirrors SlackService's
   * swappable `fetcher`), and so a driver picked before RESEND_API_KEY was set
   * in a test doesn't stick around. */
  driver: MailDriver | undefined;

  /** Optional so existing unit tests (`new EmailService()`) keep working —
   * only the workspaceId-counted path below ever touches `db`, and every
   * production instantiation goes through Nest DI, which always supplies it. */
  constructor(@Inject(DB) private readonly db?: Db) {}

  private resolveDriver(): MailDriver {
    if (this.driver) return this.driver;
    const e = env();
    if (e.RESEND_API_KEY) {
      this.driver = new ResendMailDriver(e.RESEND_API_KEY, e.MAIL_FROM);
    } else if (e.SMTP_HOST) {
      this.driver = new SmtpMailDriver(
        { host: e.SMTP_HOST, port: e.SMTP_PORT, user: e.SMTP_USER, pass: e.SMTP_PASS },
        e.MAIL_FROM,
      );
    } else {
      this.driver = new LogMailDriver((message) => this.logger.warn(message));
    }
    return this.driver;
  }

  /**
   * `workspaceId` is optional and purely for MN-194 cost attribution — the
   * account-level sends (verify-email/reset-password, see auth.ts) have no
   * workspace to attribute to and are simply not counted; that's fine, they're
   * a platform-level cost, not one this workspace-scoped counter needs to
   * carry. Counting is fire-and-forget, same as the send itself: a failed
   * increment must never be the reason a real email doesn't go out.
   */
  async send(input: EmailInput, workspaceId?: string): Promise<void> {
    const rendered = renderEmail(input);
    const driver = this.resolveDriver();
    void driver.send({ to: input.to, ...rendered }).catch((err: unknown) => {
      this.logger.error(
        `Email send failed to ${input.to} [${rendered.subject}] via ${driver.name}: ${err instanceof Error ? err.message : String(err)}`,
      );
    });

    if (workspaceId && this.db) {
      void incrementUsageCounter(this.db, workspaceId, currentMonthPeriodStart(), EMAIL_SEND_METRIC).catch(
        (err: unknown) => {
          this.logger.warn(
            `MN-194 email-send counter failed for workspace ${workspaceId}: ${err instanceof Error ? err.message : String(err)}`,
          );
        },
      );
    }
  }
}
