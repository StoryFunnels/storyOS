import { UnprocessableEntityException } from '@nestjs/common';
import { buildSmtpTransport } from '../../mail/mail-driver';
import { envCidrList, resolvePublicAddress, SsrfBlockedError } from '../../common/net-guard';
import type { ProviderDescriptor } from './types';

/** #1044: the ports mail is actually submitted on. Anything else is not an SMTP relay a workspace needs. */
export const SMTP_ALLOWED_PORTS: readonly number[] = [25, 465, 587, 2525];

export class SmtpTargetRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SmtpTargetRefused';
  }
}

/**
 * #1044 — where a workspace SMTP connection may connect: a standard SMTP port, on a host that resolves to a public address
 * (or one inside SMTP_ALLOW_PRIVATE_CIDRS, a self-host's own relay). Returns the transport options PINNED to the address that
 * was checked, with TLS still verified against the hostname. Used by the connection check AND by every send, so a connection
 * saved before this rule, or a name re-pointed after saving, is held to it too.
 */
export async function smtpTarget(host: string, port: number): Promise<{ host: string; port: number; servername?: string }> {
  if (!SMTP_ALLOWED_PORTS.includes(port)) {
    throw new SmtpTargetRefused(`SMTP port must be one of ${SMTP_ALLOWED_PORTS.join(', ')}`);
  }
  const name = host.trim();
  let address: string;
  try {
    address = await resolvePublicAddress(name, { allowPrivateCidrs: envCidrList('SMTP_ALLOW_PRIVATE_CIDRS') });
  } catch (error) {
    // One answer for "private", "blocked" and "does not resolve": which one it was is exactly what must not leak.
    if (error instanceof SsrfBlockedError || (error as NodeJS.ErrnoException)?.code === 'ENOTFOUND') {
      throw new SmtpTargetRefused('SMTP host must be a public mail server');
    }
    throw error;
  }
  return address === name.replace(/^\[|\]$/g, '') ? { host: address, port } : { host: address, port, servername: name };
}

/** #1044: what a failed check or send may say. A credential refusal is useful and reveals nothing about the network; the rest is one sentence. */
export function smtpFailureMessage(error: unknown): string {
  const code = (error as { code?: string; responseCode?: number })?.code;
  if (code === 'EAUTH') return 'the mail server rejected the username or password';
  return 'could not connect to the mail server with these settings';
}

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
  tier: 'api_key',
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
    let target: Awaited<ReturnType<typeof smtpTarget>>;
    try {
      target = await smtpTarget(a.host, Number(a.port));
    } catch (error) {
      if (error instanceof SmtpTargetRefused) throw new UnprocessableEntityException(error.message);
      throw error;
    }
    const transporter = smtpProvider.buildTransport({ ...target, user: a.user, pass: a.pass });
    try {
      await transporter.verify();
    } catch (error) {
      throw new UnprocessableEntityException(`SMTP check failed: ${smtpFailureMessage(error)}`);
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
