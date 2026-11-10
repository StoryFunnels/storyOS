import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';
import { env } from '../config/env';

/**
 * Ticket #1251 — the signed token behind the digest's one-click "Stop these emails" link.
 *
 * Unforgeable: an HMAC-SHA256 over the person's id, keyed with a key HKDF-derived from BETTER_AUTH_SECRET under a label naming THIS
 * purpose. So a token cannot be made without the server secret, and a signature minted for any other purpose (or any other HMAC use of
 * the same secret) never verifies here. Scoped: it names one person and one action (turn their own digest off) — it opens no session and
 * reads nothing. It carries no expiry on purpose: an unsubscribe link in an old email must keep working. The person id inside is only a
 * lookup key; it is never accepted without a valid signature over it.
 */
const PURPOSE = 'storyos.my-work-digest.unsubscribe.v1';

function key(): Buffer {
  return Buffer.from(hkdfSync('sha256', Buffer.from(env().BETTER_AUTH_SECRET, 'utf8'), Buffer.alloc(0), Buffer.from(PURPOSE), 32));
}

function sign(body: string): string {
  return createHmac('sha256', key()).update(`${PURPOSE}:${body}`).digest('base64url');
}

export function signUnsubscribeToken(userId: string): string {
  const body = Buffer.from(userId, 'utf8').toString('base64url');
  return `${body}.${sign(body)}`;
}

/** The person id the token was minted for, or null for anything that is not a token this server signed. */
export function verifyUnsubscribeToken(token: string | undefined): string | null {
  if (!token || token.length > 512) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [body, sig] = parts as [string, string];
  const expected = Buffer.from(sign(body));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  const userId = Buffer.from(body, 'base64url').toString('utf8');
  return userId.length > 0 ? userId : null;
}
