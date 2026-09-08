import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '../config/env';

/**
 * #602 — a portal recipient's bearer credential, signed rather than a bare
 * opaque value, following the exact conventions of `files/signed-download.ts`
 * (itself following `webhooks/webhook-sender.ts`'s signPayload/verifySignature):
 *
 *  - the function that signs and the function that verifies both hash the
 *    exact same raw string — nothing is re-derived or re-serialized in
 *    between.
 *  - comparison is `timingSafeEqual` over equal-length buffers (false, never a
 *    throw, on a length mismatch).
 *  - reuses `BETTER_AUTH_SECRET` rather than a new env var — already this
 *    app's general-purpose HMAC key for signed, opaque, server-only tokens. A
 *    domain prefix keeps this signature meaningfully distinct from anything
 *    else signed with the same key.
 *
 * Unlike the download link (which embeds a real expiry timestamp signed into
 * the URL), rotation here needs INSTANT, atomic invalidation of one specific
 * old token — a bumped counter, not a timestamp, does that: `token_version`
 * lives on the row, the signature embeds the version the token was minted
 * for, and verification checks both the signature (no DB needed) AND that the
 * embedded version still matches the row's CURRENT version (needs a DB read,
 * same as checking revocation always did — this is not an extra round trip).
 * A rotated-away token still verifies cryptographically forever (the global
 * secret never changes), but its embedded version stops matching the instant
 * `rotate()`'s single `UPDATE ... token_version = token_version + 1` commits
 * — no window where both the old and new token are valid, no window where
 * neither is.
 *
 * No secret is stored per recipient at all: the credential is a pure function
 * of (recipientId, tokenVersion, the one server-wide secret), so it can be
 * re-derived and shown again on every `list()` read without persisting it —
 * exactly the same shape `mintDownloadUrl` uses for a file id.
 */
function raw(recipientId: string, tokenVersion: number): string {
  return `portal-recipient:${recipientId}:${tokenVersion}`;
}

function signPortalRecipientToken(recipientId: string, tokenVersion: number): string {
  return createHmac('sha256', env().BETTER_AUTH_SECRET).update(raw(recipientId, tokenVersion)).digest('hex');
}

export function mintPortalRecipientToken(recipientId: string, tokenVersion: number): string {
  return `${recipientId}.${tokenVersion}.${signPortalRecipientToken(recipientId, tokenVersion)}`;
}

export interface ParsedPortalRecipientToken {
  recipientId: string;
  tokenVersion: number;
  signature: string;
}

/** Shape-only parse — verifying the signature still needs the row's CURRENT tokenVersion, so it happens separately. */
export function parsePortalRecipientToken(token: string): ParsedPortalRecipientToken | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [recipientId, versionRaw, signature] = parts;
  const tokenVersion = Number(versionRaw);
  if (!recipientId || !Number.isInteger(tokenVersion) || tokenVersion < 1 || !signature) return null;
  return { recipientId, tokenVersion, signature };
}

export function verifyPortalRecipientSignature(
  recipientId: string,
  tokenVersion: number,
  signature: string,
): boolean {
  const expected = signPortalRecipientToken(recipientId, tokenVersion);
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(signature, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}
