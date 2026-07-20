import { createTransport } from 'nodemailer';
import type { Transporter } from 'nodemailer';

export interface MailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
}

export interface MailDriver {
  readonly name: string;
  send(message: MailMessage): Promise<void>;
}

/** Minimal fetch surface so the driver is testable without a network (mirrors
 * SlackFetcher in integrations/slack.service.ts). */
export type ResendFetcher = (
  url: string,
  init: { headers: Record<string, string>; body: string },
) => Promise<{ status: number; text: () => Promise<string> }>;

const defaultResendFetcher: ResendFetcher = (url, init) =>
  fetch(url, { method: 'POST', headers: init.headers, body: init.body });

const RESEND_ENDPOINT = 'https://api.resend.com/emails';

/** Sends via Resend's HTTP API (MN-103) — the standard transactional-email path
 * going forward. Swappable `fetcher` for tests; never touches a real network key. */
export class ResendMailDriver implements MailDriver {
  readonly name = 'resend';
  fetcher: ResendFetcher = defaultResendFetcher;

  constructor(
    private readonly apiKey: string,
    private readonly from: string,
  ) {}

  async send(message: MailMessage): Promise<void> {
    const res = await this.fetcher(RESEND_ENDPOINT, {
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        from: this.from,
        to: [message.to],
        subject: message.subject,
        html: message.html,
        text: message.text,
      }),
    });
    if (res.status >= 300) {
      throw new Error(`Resend API error: HTTP ${res.status} — ${await res.text()}`);
    }
  }
}

/** Existing nodemailer/SMTP transport (pre-MN-103 behavior), kept for deploys
 * that configure SMTP_HOST directly — including ones already pointing it at
 * Resend's own SMTP relay (smtp.resend.com). */
export class SmtpMailDriver implements MailDriver {
  readonly name = 'smtp';
  private readonly transporter: Transporter;

  constructor(
    opts: { host: string; port: number; user?: string; pass?: string },
    private readonly from: string,
  ) {
    this.transporter = createTransport({
      host: opts.host,
      port: opts.port,
      secure: opts.port === 465,
      auth: opts.user ? { user: opts.user, pass: opts.pass } : undefined,
    });
  }

  async send(message: MailMessage): Promise<void> {
    await this.transporter.sendMail({
      from: this.from,
      to: message.to,
      subject: message.subject,
      html: message.html,
      text: message.text,
    });
  }
}

/** No email provider configured — logs so invite/verification/reset flows stay
 * usable in dev (admins can still copy an accept link; verification links are
 * readable in the server log). Never throws. */
export class LogMailDriver implements MailDriver {
  readonly name = 'log';

  constructor(private readonly warn: (message: string) => void) {}

  async send(message: MailMessage): Promise<void> {
    this.warn(`Email delivery not configured — to ${message.to} [${message.subject}] ${message.text}`);
  }
}
