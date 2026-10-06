import { createHash } from 'node:crypto';
import { Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import { PostHog } from 'posthog-node';
import { env } from '../config/env';

export type CaptureResult = 'sent' | 'disabled' | 'failed';

export interface CaptureInput {
  /** The PERSON — the same id the web client passes to posthog.identify (the auth user id). */
  distinctId: string;
  event: string;
  properties?: Record<string, unknown>;
  /** Deterministic id for this logical event; PostHog collapses duplicates that share it. */
  uuid?: string;
}

/**
 * A stable UUID for "this event, about this subject". Sending the same logical
 * event twice (a retry after a lost response, two instances racing) then produces
 * the same id, which PostHog deduplicates — so "exactly once" does not rest on the
 * claim alone. Not a security primitive: a hash laid out as a version-5 UUID.
 */
export function eventUuid(event: string, subjectId: string): string {
  const h = createHash('sha256').update(`${event}:${subjectId}`).digest('hex');
  const variant = ((parseInt(h.slice(16, 18), 16) & 0x3f) | 0x80).toString(16).padStart(2, '0');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${variant}${h.slice(18, 20)}-${h.slice(20, 32)}`;
}

/**
 * #817 — the API's one door to PostHog.
 *
 * ENV-GATED BY CONSTRUCTION: with POSTHOG_PROJECT_TOKEN/POSTHOG_HOST unset (the
 * default, and every self-hoster) `capture` returns 'disabled' without building a
 * client or touching the network, and callers are expected to skip their own work
 * when `enabled` is false. It NEVER throws: analytics is decoration, and a PostHog
 * outage must not fail a Stripe webhook (Stripe would retry the whole delivery).
 *
 * Privacy: events carry the auth user id as the person and opaque workspace ids as
 * properties. No email, no name — the web client's identify call already sets those
 * on the same person — and geoip is disabled, because the request originates from
 * this server and PostHog would otherwise stamp the person with OUR location.
 */
@Injectable()
export class AnalyticsService implements OnApplicationShutdown {
  private readonly logger = new Logger(AnalyticsService.name);
  private client: PostHog | null = null;

  /** Swappable in tests, like the other services' `fetcher` fields. */
  clientFactory: (token: string, host: string) => Pick<PostHog, 'captureImmediate' | 'shutdown'> = (token, host) =>
    new PostHog(token, { host, flushAt: 1, flushInterval: 0, disableGeoip: true });

  /** The ONE place configuration is read, and the seam tests override (env() is cached). */
  config(): { token: string; host: string } | null {
    const e = env();
    return e.POSTHOG_PROJECT_TOKEN && e.POSTHOG_HOST ? { token: e.POSTHOG_PROJECT_TOKEN, host: e.POSTHOG_HOST } : null;
  }

  get enabled(): boolean {
    return this.config() !== null;
  }

  async capture(input: CaptureInput): Promise<CaptureResult> {
    const config = this.config();
    if (!config) return 'disabled';
    try {
      this.client ??= this.clientFactory(config.token, config.host) as PostHog;
      await this.client.captureImmediate({
        distinctId: input.distinctId,
        event: input.event,
        // `surface` is a property, not a name prefix (#13): this is the app.
        properties: { ...input.properties, surface: 'app' },
        ...(input.uuid ? { uuid: input.uuid } : {}),
        disableGeoip: true,
      });
      return 'sent';
    } catch (error) {
      this.logger.warn(`analytics: could not send ${input.event}: ${String(error)}`);
      return 'failed';
    }
  }

  async onApplicationShutdown(): Promise<void> {
    await this.client?.shutdown().catch(() => undefined);
  }
}
