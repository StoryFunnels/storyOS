import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '../config/env';

/**
 * Ticket #51 — a short-lived, signed URL for ONE record attachment, so a network that publishes by fetching an image
 * (Instagram's container creation takes an `image_url`, nothing else) can read it without the object ever becoming public.
 *
 * Same construction as files/signed-download.ts: an HMAC over the literal id and the literal `expires` string, a domain
 * prefix so a signature minted here can never verify as a file download (or anything else signed with the same key), a
 * constant-time compare, and an expiry checked after the signature from the same raw string. One route serves both
 * storage drivers (local disk and S3-compatible), so there is no per-driver presigning and no new dependency. Nothing is
 * cached, and the URL names an attachment id, never a storage key.
 */
export const ATTACHMENT_URL_TTL_SECONDS = 15 * 60;

function raw(attachmentId: string, expires: string): string {
  return `attachment-image:${attachmentId}:${expires}`;
}

export function signAttachmentUrl(attachmentId: string, expiresEpochSeconds: string): string {
  return createHmac('sha256', env().BETTER_AUTH_SECRET).update(raw(attachmentId, expiresEpochSeconds)).digest('hex');
}

/** `expiresEpochSeconds` MUST be the literal query string, never a number parsed and put back. */
export function verifyAttachmentSignature(attachmentId: string, expiresEpochSeconds: string, signature: string): boolean {
  const a = Buffer.from(signAttachmentUrl(attachmentId, expiresEpochSeconds), 'utf8');
  const b = Buffer.from(signature, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

export function mintAttachmentUrl(attachmentId: string, nowMs = Date.now()): { url: string; expiresAt: Date } {
  const expires = String(Math.floor(nowMs / 1000) + ATTACHMENT_URL_TTL_SECONDS);
  const sig = signAttachmentUrl(attachmentId, expires);
  return {
    url: `${env().API_URL}/api/v1/attachments/signed/${attachmentId}?expires=${expires}&sig=${sig}`,
    expiresAt: new Date(Number(expires) * 1000),
  };
}
