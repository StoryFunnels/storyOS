import { Injectable } from '@nestjs/common';

const WINDOW_MS = 60_000;
const LIMIT = 60;

interface Bucket {
  windowStart: number;
  count: number;
}

/**
 * Per-hook inbound rate limit (MN-254): 60 requests/minute keyed on the
 * hookToken itself, not the caller's IP. A legitimate high-volume sender
 * (Stripe, an ad platform, a Zapier hand-off) calls from many source
 * addresses, so IP-keying — what the app's global ApiThrottlerGuard already
 * does for everything else — would either under- or over-throttle a hook for
 * the wrong reason. Keying on the hook decouples one rule's budget from
 * whatever else shares its caller's IP.
 *
 * Fixed 60-second windows, in-memory only — the same single-node-v1 tradeoff
 * the scheduler (automations.service.ts tick()) and the webhook dispatcher
 * already make. A full sliding window or cross-replica storage is more engine
 * than a v1 needs; this is deliberately the "simple windowed count" the
 * ticket's guide called for, not a second copy of @nestjs/throttler wired
 * across a module boundary for one route.
 */
@Injectable()
export class HookRateLimiterService {
  private buckets = new Map<string, Bucket>();

  /** True if this call is within budget (and counts against it); false if over. */
  hit(hookToken: string, now = Date.now()): boolean {
    const bucket = this.buckets.get(hookToken);
    if (!bucket || now - bucket.windowStart >= WINDOW_MS) {
      this.buckets.set(hookToken, { windowStart: now, count: 1 });
      return true;
    }
    if (bucket.count >= LIMIT) return false;
    bucket.count += 1;
    return true;
  }

  /** Drops expired buckets so long-lived processes don't accumulate stale tokens. */
  sweep(now = Date.now()): void {
    for (const [token, bucket] of this.buckets) {
      if (now - bucket.windowStart >= WINDOW_MS) this.buckets.delete(token);
    }
  }
}
