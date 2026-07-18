import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '../config/env';

/**
 * Signed, expiring download URLs (#201): `GET /files/:id/download?expires=&sig=`.
 * The signature is an HMAC over the exact `id` and `expires` query-param
 * *strings*, following the same conventions as webhooks/webhook-sender.ts's
 * signPayload/verifySignature:
 *
 *  - the function that signs and the function that verifies both hash the exact
 *    string handed to them — nothing is re-derived or re-serialized in between.
 *    `verifyDownloadSignature` takes `expires` as the raw query-param string, not
 *    a parsed-then-restringified number, so a value that round-trips differently
 *    through `Number()` (leading zeros, `+1234`, exponent notation, etc.) cannot
 *    verify against a signature minted for a different literal string. Expiry is
 *    checked separately, after signature verification, from the same raw string.
 *  - comparison is `timingSafeEqual` over equal-length buffers (falling back to
 *    `false`, never throwing, on a length mismatch) — see the #42 lesson pinned
 *    in webhook-sender.unit.test.ts.
 *
 * Reuses BETTER_AUTH_SECRET rather than adding a new env var: it's already this
 * app's general-purpose HMAC key for signed, opaque, server-only tokens (see
 * integrations/github-app.service.ts's OAuth `state` signing). A domain prefix
 * keeps a file-download signature meaningfully distinct from anything else ever
 * signed with the same key.
 */

/** 15 minutes: long enough to survive minting a URL, rendering a UI, and the
 * user clicking download (plus a slow-network GET) without re-minting; short
 * enough to sharply bound how long a URL that leaks into a browser's history,
 * a proxy log, or a chat message stays live. Sensitive files (pasted client
 * docs, screenshots) get a tight window rather than the old one-year cache. */
export const DOWNLOAD_URL_TTL_SECONDS = 15 * 60;

function raw(fileId: string, expires: string): string {
  return `file-download:${fileId}:${expires}`;
}

export function signDownloadUrl(fileId: string, expiresEpochSeconds: string): string {
  return createHmac('sha256', env().BETTER_AUTH_SECRET).update(raw(fileId, expiresEpochSeconds)).digest('hex');
}

/** `expiresEpochSeconds` MUST be the literal query-param string, not a value
 * that has been parsed to a number and put back — see the file header. */
export function verifyDownloadSignature(
  fileId: string,
  expiresEpochSeconds: string,
  signature: string,
): boolean {
  const expected = signDownloadUrl(fileId, expiresEpochSeconds);
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(signature, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

export function mintDownloadUrl(fileId: string, nowMs = Date.now()): { url: string; expiresAt: Date } {
  const expiresEpochSeconds = String(Math.floor(nowMs / 1000) + DOWNLOAD_URL_TTL_SECONDS);
  const sig = signDownloadUrl(fileId, expiresEpochSeconds);
  return {
    url: `/api/v1/files/${fileId}/download?expires=${expiresEpochSeconds}&sig=${sig}`,
    expiresAt: new Date(Number(expiresEpochSeconds) * 1000),
  };
}
