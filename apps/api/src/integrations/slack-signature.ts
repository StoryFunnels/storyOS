import { createHmac, timingSafeEqual } from 'node:crypto';

/** Slack's own rule: a request whose timestamp is more than five minutes from now, in either direction, is refused. */
export const SLACK_TIMESTAMP_TOLERANCE_SECONDS = 5 * 60;

export interface SlackSignatureInput {
  /** `SLACK_SIGNING_SECRET`. Absent, empty or blank means NOTHING verifies: the receiver fails closed. */
  signingSecret: string | null | undefined;
  /** `X-Slack-Request-Timestamp`: whole seconds since the epoch. */
  timestamp: string | undefined;
  /** `X-Slack-Signature`: `v0=<hex hmac-sha256 of "v0:<timestamp>:<raw body>">`. */
  signature: string | undefined;
  /** The bytes Slack sent. Never a re-serialized body: JSON.parse then JSON.stringify does not round-trip. */
  rawBody: Buffer | undefined;
  nowMs?: number;
}

/**
 * Ticket #1379 - Slack's request signing (https://api.slack.com/authentication/verifying-requests-from-slack).
 *
 * This is the ONLY authentication the Events API route has, so every doubt is a refusal: no secret configured, no raw body, a
 * malformed header, a timestamp outside the window or not a plain integer, a signature of the wrong length. The compare is
 * constant-time over equal-length buffers (`timingSafeEqual` throws on a length mismatch, so the length is checked first, and the
 * length of the expected value is public: it is always `v0=` plus 64 hex characters).
 */
export function verifySlackSignature(input: SlackSignatureInput): boolean {
  const secret = input.signingSecret?.trim();
  if (!secret) return false;
  const { timestamp, signature, rawBody } = input;
  if (!timestamp || !signature || !rawBody) return false;
  // Plain digits only: "1.5e9", "0x10" and " 12" are not what Slack sends, and Number() would accept every one of them.
  if (!/^[0-9]{1,12}$/.test(timestamp)) return false;
  const nowMs = input.nowMs ?? Date.now();
  if (Math.abs(nowMs / 1000 - Number(timestamp)) > SLACK_TIMESTAMP_TOLERANCE_SECONDS) return false;
  const expected = Buffer.from(
    `v0=${createHmac('sha256', secret).update(`v0:${timestamp}:`).update(rawBody).digest('hex')}`,
    'utf8',
  );
  const given = Buffer.from(signature, 'utf8');
  return given.length === expected.length && timingSafeEqual(given, expected);
}
