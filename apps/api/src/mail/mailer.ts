import { Logger } from '@nestjs/common';
import { createTransport } from 'nodemailer';
import type { Transporter } from 'nodemailer';
import { env } from '../config/env';

const logger = new Logger('Mailer');

let transporter: Transporter | undefined | null;

function getTransporter(): Transporter | null {
  if (transporter !== undefined) return transporter;
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = env();
  if (!SMTP_HOST) {
    transporter = null;
    return transporter;
  }
  transporter = createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_PORT === 465,
    auth: SMTP_USER ? { user: SMTP_USER, pass: SMTP_PASS } : undefined,
  });
  return transporter;
}

/**
 * Sends an email when SMTP is configured; otherwise logs the content so
 * flows (verification links, resets) remain usable in dev without SMTP.
 */
export async function sendMail(opts: { to: string; subject: string; text: string }) {
  const t = getTransporter();
  if (!t) {
    logger.warn(`SMTP not configured — email to ${opts.to} skipped. [${opts.subject}] ${opts.text}`);
    return;
  }
  // Best-effort: a mail hiccup (e.g. an unverified sender domain) must never fail
  // the calling flow — the invite/verification row is already the source of truth,
  // and admins can copy the accept link. Log and move on.
  try {
    await t.sendMail({ from: env().MAIL_FROM, ...opts });
  } catch (err) {
    logger.error(
      `Email send failed to ${opts.to} [${opts.subject}]: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
