import { UnprocessableEntityException } from '@nestjs/common';
import { buildSmtpTransport } from '../../mail/mail-driver';
import type { ProviderDescriptor } from './types';

/**
 * The auth JSON shape stored (sealed) for a direct SMTP connection (MN-256).
 * A separate provider from `resend` (providers/resend.ts's Resend HTTP API) —
 * this is the "or SMTP" half of "a workspace Resend/SMTP connection" the
 * ticket describes, for a self-hosted mail relay, Resend's own SMTP endpoint
 * (smtp.resend.com), or any other SMTP smarthost.
 *
 * `from_address` is NOT optional here (unlike Resend's): a raw SMTP
 * credential carries no notion of "verified domains" to check a from-address
 * against, so the only guardrail against sending as an arbitrary address is
 * requiring one be fixed at connect time — send_email can never override it.
 */
export interface SmtpConnectionAuth {
  host: string;
  port: number;
  user?: string;
  pass?: string;
  from_address: string;
}

/**
 * Direct SMTP (MN-256). `healthCheck` reuses mail/mail-driver.ts's
 * `buildSmtpTransport` (the same builder `SmtpMailDriver` — the transactional
 * mailer's own SMTP path — uses) rather than a second `createTransport` call,
 * and verifies the connection actually authenticates via nodemailer's own
 * `transporter.verify()`. `buildTransport` is a mutable property (mirrors
 * ConnectionsService.fetcher/SlackService's own swappable seams) so tests
 * exercise this without opening a real TCP connection.
 */
export const smtpProvider: ProviderDescriptor & { buildTransport: typeof buildSmtpTransport } = {
  id: 'smtp',
  label: 'SMTP',
  authKind: 'smtp',
  buildTransport: buildSmtpTransport,
  async healthCheck(auth: unknown): Promise<void> {
    const a = (auth ?? {}) as Partial<SmtpConnectionAuth>;
    if (!a.host || !a.host.trim()) {
      throw new UnprocessableEntityException('SMTP connection needs a host');
    }
    if (!a.port) {
      throw new UnprocessableEntityException('SMTP connection needs a port');
    }
    if (!a.from_address || !a.from_address.trim()) {
      throw new UnprocessableEntityException('SMTP connection needs a from_address — send_email can never override it');
    }
    const transporter = smtpProvider.buildTransport({ host: a.host, port: a.port, user: a.user, pass: a.pass });
    try {
      await transporter.verify();
    } catch (error) {
      throw new UnprocessableEntityException(
        `SMTP check failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      transporter.close();
    }
  },
  /** Always exactly one scope entry — the from_address send_email's
   * validate() looks for, mirroring Resend's `from:` scope shape. */
  async resolveScopes(auth: unknown): Promise<string[]> {
    const { from_address } = (auth ?? {}) as Partial<SmtpConnectionAuth>;
    return from_address ? [`from:${from_address}`] : [];
  },
};
