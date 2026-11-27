import { Injectable, Logger } from '@nestjs/common';
import { SlackUnfurlService } from './slack-unfurl.service';

/**
 * The inbound delivery path. Exported so app.setup.ts can put exactly this path, and nothing else, on the raw-body allowlist (the
 * signature is over the bytes Slack sent). If this string and the controller's route drift apart the HMAC has no bytes to verify and
 * every delivery 401s: loud, not silent.
 */
export const SLACK_EVENTS_PATH = '/api/v1/integrations/slack/events';

/** How long an `event_id` is remembered. Slack retries within minutes, and a delivery older than five minutes fails the signature window anyway. */
const SEEN_TTL_MS = 10 * 60_000;
const SEEN_MAX = 10_000;

/**
 * Ticket #1379 - what the Events API route does AFTER the signature verified (`verifySlackSignature`, in the controller). Until then
 * nothing here runs, so nothing below reads a payload from a stranger.
 *
 * It answers the two things Slack sends us: the one-time `url_verification` handshake, and `event_callback`s. Only `link_shared`
 * is acted on; every other event, and every malformed body, is a plain acknowledgement (a 4xx would teach Slack to disable the
 * subscription). The answer to a `link_shared` is the SAME constant whatever the link was, so an unfurl that did not happen is
 * indistinguishable from outside from one for a record that does not exist.
 *
 * Slack wants an answer within three seconds and an unfurl takes a database read and a Slack call, so the unfurl runs after the
 * answer. `whenIdle()` is how a test waits for it.
 */
@Injectable()
export class SlackEventsService {
  private readonly logger = new Logger(SlackEventsService.name);
  private readonly seen = new Map<string, number>();
  private readonly pending = new Set<Promise<unknown>>();

  constructor(private readonly unfurl: SlackUnfurlService) {}

  handle(rawBody: Buffer): { challenge: string } | { ok: true } {
    let body: unknown;
    try {
      body = JSON.parse(rawBody.toString('utf8'));
    } catch {
      return { ok: true };
    }
    if (!body || typeof body !== 'object') return { ok: true };
    const envelope = body as { type?: unknown; challenge?: unknown; team_id?: unknown; event_id?: unknown; event?: unknown };

    if (envelope.type === 'url_verification') {
      // The handshake. Signed like every other request, so only Slack (or whoever holds the secret) gets here.
      return typeof envelope.challenge === 'string' && envelope.challenge.length <= 512 ? { challenge: envelope.challenge } : { ok: true };
    }
    if (envelope.type !== 'event_callback' || !envelope.event || typeof envelope.event !== 'object') return { ok: true };
    const event = envelope.event as Record<string, unknown>;
    if (event.type !== 'link_shared') return { ok: true };

    // A repeat of an event id we already took (Slack's own retries carry the same id) is acknowledged and not redone. NOT keyed on
    // `X-Slack-Retry-Num`: a retry of a delivery we answered 4xx/5xx was never taken, and skipping it would lose the preview.
    if (typeof envelope.event_id === 'string' && !this.firstDelivery(envelope.event_id)) return { ok: true };

    const work = this.unfurl
      .handleLinkShared({
        teamId: envelope.team_id,
        channel: event.channel,
        messageTs: event.message_ts,
        source: event.source,
        unfurlId: event.unfurl_id,
        links: event.links,
      })
      .catch((error: unknown) => {
        // The message of an error from our own code, never a request or a token: nothing here ever held one.
        this.logger.warn(`link_shared failed: ${error instanceof Error ? error.message : 'unknown error'}`);
      })
      .finally(() => this.pending.delete(work));
    this.pending.add(work);
    return { ok: true };
  }

  /** Resolves when every unfurl started so far has finished. For tests; production never waits on it. */
  async whenIdle(): Promise<void> {
    while (this.pending.size > 0) await Promise.allSettled([...this.pending]);
  }

  /** True the first time an `event_id` is seen inside the window, false for a repeat. Bounded: the oldest are dropped first. */
  private firstDelivery(eventId: string, nowMs: number = Date.now()): boolean {
    for (const [id, at] of this.seen) {
      if (nowMs - at <= SEEN_TTL_MS && this.seen.size < SEEN_MAX) break; // a Map iterates oldest first
      this.seen.delete(id);
    }
    if (this.seen.has(eventId)) return false;
    this.seen.set(eventId, nowMs);
    return true;
  }
}
