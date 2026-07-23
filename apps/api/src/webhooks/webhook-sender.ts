import { createHmac, timingSafeEqual } from 'node:crypto';
import { assertPublicHost, defaultWebhookFetcher, isPrivateAddress } from '../common/net-guard';
import type { WebhookFetcher } from '../common/net-guard';

/**
 * The one HTTP path every outgoing webhook takes (MN-032, MN-088).
 *
 * Kept free of Nest and the db so both callers — the activity-event dispatcher and
 * the button's `send_webhook` action — share exactly one sender, one signature
 * scheme and one backoff schedule, per MN-088's "don't build a second HTTP path".
 *
 * MN-263: `isPrivateAddress`/`assertPublicHost` moved to common/net-guard.ts (the
 * http_request action's send path needed the same guard, hardened with a redirect
 * chase and a self-host allowlist neither of which applies here) — re-exported so
 * every existing import of them from this module keeps working unchanged.
 */
export { assertPublicHost, defaultWebhookFetcher, isPrivateAddress };
export type { WebhookFetcher };

export const MAX_ATTEMPTS = 5;
const TIMEOUT_MS = 10_000;

/**
 * Signed like Stripe's scheme: the timestamp is inside the signed string, so a
 * captured payload can't be replayed later against a receiver that checks age.
 */
export function signPayload(secret: string, body: string, timestamp: number): string {
  return createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

/** Constant-time verify — the helper a receiver (or our own test) uses. */
export function verifySignature(
  secret: string,
  body: string,
  timestamp: number,
  signature: string,
): boolean {
  const expected = signPayload(secret, body, timestamp);
  const a = Buffer.from(expected);
  const b = Buffer.from(signature.replace(/^sha256=/, ''));
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Exponential backoff: 1, 2, 4, 8 minutes. Returns null once attempts are spent,
 * which is the signal to mark the delivery failed for good.
 */
export function nextAttemptDelayMs(attempts: number): number | null {
  if (attempts >= MAX_ATTEMPTS) return null;
  return 2 ** (attempts - 1) * 60_000;
}

/** A 2xx is success; anything else is retryable, including a network throw. */
export function isSuccess(status: number): boolean {
  return status >= 200 && status < 300;
}

export interface DeliveryResult {
  ok: boolean;
  statusCode?: number;
  error?: string;
}

export async function deliverWebhook(
  fetcher: WebhookFetcher,
  input: {
    url: string;
    secret: string;
    body: unknown;
    eventType: string;
    deliveryId: string;
    headers?: Record<string, string>;
    now?: number;
  },
): Promise<DeliveryResult> {
  const raw = JSON.stringify(input.body);
  const timestamp = Math.floor((input.now ?? Date.now()) / 1000);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    await assertPublicHost(new URL(input.url).hostname);
    const res = await fetcher(input.url, {
      method: 'POST',
      headers: {
        // Caller headers first: our signing headers must not be overridable (MN-088
        // lets a button supply its own headers).
        ...(input.headers ?? {}),
        'Content-Type': 'application/json',
        'User-Agent': 'StoryOS-Webhook/1',
        'X-StoryOS-Event': input.eventType,
        'X-StoryOS-Delivery': input.deliveryId,
        'X-StoryOS-Timestamp': String(timestamp),
        'X-StoryOS-Signature': `sha256=${signPayload(input.secret, raw, timestamp)}`,
      },
      body: raw,
      signal: controller.signal,
    });
    return isSuccess(res.status)
      ? { ok: true, statusCode: res.status }
      : { ok: false, statusCode: res.status, error: `HTTP ${res.status}` };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message === 'The operation was aborted.' ? 'timed out' : message };
  } finally {
    clearTimeout(timer);
  }
}
