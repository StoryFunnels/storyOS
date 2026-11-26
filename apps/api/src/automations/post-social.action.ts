import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { and, eq, isNull } from 'drizzle-orm';
import { parseTweet } from 'twitter-text';
import type { Readable } from 'node:stream';
import type { AutomationAction } from '@storyos/schemas';
import { DB } from '../db/db.module';
import type { Db } from '../db/client';
import { attachments, fields } from '../db/schema';
import { ConnectionsService } from '../connections/connections.service';
import type { LinkedinAuth } from '../connections/providers/linkedin';
import type { XAuth } from '../connections/providers/x';
import { RecordsService } from '../records/records.service';
import { getStorage } from '../attachments/storage';
import { namesAccount } from './social-targets';
import { preflightInstagram, publishToMeta } from './post-social-meta';
import type { MetaPoll } from './post-social-meta';
import { mintAttachmentUrl } from '../attachments/signed-attachment';
import type { MetaAuth } from '../connections/providers/meta';
import { ProviderError } from '../common/provider-error';
import { failClosedFetch } from '../common/test-network-guard';
import { JobRunnerService } from './job-runner.service';
import type { JobHelpers } from './job-runner.service';

export type PostSocialAction = Extract<AutomationAction, { type: 'post_social' }>;

/** Mirrors send-email.action.ts / http-request-action.service.ts's own job
 * payload `ctx` shape (actions.service.ts's execute() queued-job branch). */
export interface PostSocialCtx {
  workspaceId: string;
  databaseId: string;
  recordId: string | null;
  actorId: string;
  depth?: number;
}

export interface PostSocialJobPayload {
  action: PostSocialAction;
  ctx: PostSocialCtx;
}

/** X's own character cap (#42) — tighter than the zod schema's `.max(3000)`,
 * which is sized for LinkedIn's limit and shared by both targets since a
 * single `text` field has to satisfy whichever target the action picks. */
const X_MAX_WEIGHTED_LENGTH = 280;

/** LinkedIn's UGC/rest `/posts` API version header — pinned to a literal
 * recent dated version rather than "latest", per LinkedIn's own versioning
 * scheme (a new version is additive; an unpinned client silently inherits
 * breaking changes on LinkedIn's own schedule). */
const LINKEDIN_API_VERSION = '202401';

/**
 * Ticket #42 — what a failed publish SAYS. The job's `last_error` is shown on the record (the publish-state read, the
 * approval-outcome comment, run history), so it must never carry a provider's raw response: that body can echo the
 * post text, an account's name or an id, and a token fragment in an error detail. A failure is therefore a stable
 * CODE plus a short message this file wrote, stored as `[code] message` and parsed back by `social-publishes.service.ts`.
 * Only the HTTP status is carried over from the provider.
 */
export { publishFailure } from './publish-failure';
export type { PublishFailureCode } from './publish-failure';
import { publishFailure } from './publish-failure';
import type { PublishFailureCode } from './publish-failure';

/** One HTTP failure from a network, reduced to a code and a sentence that carries the status and nothing else. */
function httpFailure(network: 'LinkedIn' | 'X', step: string, status: number): ProviderError {
  const retryable = status >= 500 || status === 429;
  const code: PublishFailureCode =
    status === 401
      ? 'auth_refused'
      : status === 403
        ? 'forbidden'
        : status === 404
          ? 'not_found'
          : status === 429
            ? 'rate_limited'
            : status >= 500
              ? 'provider_unavailable'
              : 'rejected';
  const hint =
    code === 'auth_refused'
      ? ' Reconnect the account.'
      : code === 'forbidden'
        ? network === 'X'
          ? " Usually the X app's tier does not allow posting."
          : ' The connected member may not be allowed to post as this account.'
        : '';
  return publishFailure(code, `${network} refused the ${step} (HTTP ${status}).${hint}`, retryable);
}

export { LINKEDIN_ORG_URN, LINKEDIN_PERSON_URN } from './social-targets';

export interface PostSocialResult {
  url: string;
  external_id: string;
}

/** #599's streamToBuffer, copied rather than imported — attachments.service
 * .ts doesn't export it (it's a private top-of-file helper there), and
 * StorageDriver.getStream is the only read primitive either way. */
async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

interface MediaAsset {
  attachmentId: string;
  buffer: Buffer;
  mime: string;
  filename: string;
}

/**
 * Ticket #42 / MN-257 — the post_social automation action's executor,
 * registered with MN-253's JobRunnerService the same way send_email/
 * http_request register theirs. Reached ONLY through the durable queue —
 * actions.service.ts's execute() already rendered {Field}/{payload} tokens
 * in `text`/`link` before enqueueing (or before an approval snapshot froze
 * them), so this never touches interpolation itself.
 *
 * One registered kind ('post_social') dispatching internally on
 * `action.target` — linkedin_org/linkedin_member share the LinkedIn publish
 * path (differing only in the author URN), `x` is a completely separate API.
 */
@Injectable()
export class PostSocialActionService implements OnModuleInit {
  private readonly logger = new Logger(PostSocialActionService.name);

  /** Swappable in tests — mirrors ConnectionsService.fetcher / SendEmailActionService
   * .buildTransport's own seam, rather than `helpers.fetcher` (http_request's
   * approach): LinkedIn/X are fixed external hosts, not caller-supplied URLs, so
   * there is no guardedFetch/SSRF step to go through — this field is the entire
   * send path, and the real provider HTTP call this is swapped for in tests. */
  fetcher: typeof fetch = failClosedFetch();

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly jobs: JobRunnerService,
    private readonly connections: ConnectionsService,
    private readonly records: RecordsService,
  ) {}

  onModuleInit(): void {
    this.jobs.registerExecutor('post_social', (payload, helpers) => this.run(payload as unknown as PostSocialJobPayload, helpers), {
      timeoutClass: 'long',
    });
  }

  /** Public (not just the registered closure) so tests drive it directly,
   * swapping `this.fetcher` the same way send-email.action.test.ts swaps
   * ConnectionsService.fetcher. `helpers` is still needed for connectionAuth
   * (the decrypted connection credential never flows through `this`). */
  async run(payload: PostSocialJobPayload, helpers: JobHelpers): Promise<PostSocialResult> {
    const { action, ctx } = payload;

    // Dedup (#42): result_field_id doubles as the "already posted" marker — a
    // non-empty value there means a previous attempt already succeeded (the
    // job retried after its write-back but before the job itself was marked
    // succeeded, or the rule re-fired). Never retryable: retrying can't undo
    // an already-published post, and re-posting would duplicate it.
    if (action.result_field_id && ctx.recordId) {
      const already = await this.existingResultValue(ctx.databaseId, ctx.recordId, action.result_field_id);
      if (already) {
        throw publishFailure('already_posted', 'This post already has a link on the record, so it was not posted a second time.', false);
      }
    }

    // Ticket #42/#51 — NOTHING POSTS FROM AN UNNAMED ACCOUNT. A company-page, Facebook Page or Instagram post names the account
    // it goes out as; a job without it (a rule saved before this check existed, or a payload edited by hand) is refused here,
    // before any provider call, rather than falling back to a default.
    if (
      (action.target === 'linkedin_org' || action.target === 'facebook_page' || action.target === 'instagram_business') &&
      !namesAccount(action)
    ) {
      throw publishFailure(
        'no_account',
        action.target === 'linkedin_org'
          ? 'This post does not name the LinkedIn page it goes out as. Pick the page in the rule and run it again.'
          : action.target === 'facebook_page'
            ? 'This post does not name the Facebook Page it goes out as. Pick the Page in the rule and run it again.'
            : 'This post does not name the Instagram account it goes out as. Pick the account in the rule and run it again.',
        false,
      );
    }

    // Pre-flight length check (#42): X's weighted-length cap is tighter than
    // the zod schema's shared `.max(3000)` (sized for LinkedIn) — checked
    // BEFORE any provider call, not caught-and-reported after a failed send.
    if (action.target === 'x') {
      // No options object: twitter-text@3's parseTweet only merges a FULL
      // options object over its defaults, not a partial one — passing just
      // `{ maxWeightedTweetLength }` drops `ranges`/`scale` and silently
      // returns NaN/invalid for every input. The library's own default
      // (configs.defaults.maxWeightedTweetLength) is already 280, which is
      // X_MAX_WEIGHTED_LENGTH, so the no-args call is both correct and the
      // only form that actually works.
      const { weightedLength, valid } = parseTweet(action.text);
      if (!valid || weightedLength > X_MAX_WEIGHTED_LENGTH) {
        throw publishFailure('too_long', `The text is too long for X: ${weightedLength} of ${X_MAX_WEIGHTED_LENGTH} characters.`, false);
      }
    }

    const media = action.media_field_id && ctx.recordId ? await this.loadMedia(ctx.databaseId, ctx.recordId, action.media_field_id) : null;

    // Ticket #51 — Instagram's image rules are checked before the connection's credential is even opened.
    if (action.target === 'instagram_business') preflightInstagram(action, media);

    const { provider, auth } = await helpers.connectionAuth(action.connection_id);
    let result: PostSocialResult;
    if (action.target === 'x') {
      result = await this.publishToX(auth as Partial<XAuth>, action, media);
    } else if (action.target === 'facebook_page' || action.target === 'instagram_business') {
      result = await this.publishToMetaTarget(auth as Partial<MetaAuth>, action, media, provider, ctx.workspaceId);
    } else {
      result = await this.publishToLinkedin(auth as Partial<LinkedinAuth>, action, media, provider);
    }

    if (action.result_field_id && ctx.recordId) {
      const field = await this.db.query.fields.findFirst({
        where: and(eq(fields.id, action.result_field_id), eq(fields.databaseId, ctx.databaseId), isNull(fields.deletedAt)),
      });
      if (field) {
        await this.records.update(
          ctx.workspaceId,
          ctx.databaseId,
          ctx.recordId,
          { [field.apiName]: result.url },
          ctx.actorId,
          (ctx.depth ?? 0) + 1,
          'automation',
        );
      }
    }

    return result;
  }

  /** Raw (unprojected) read of the result field's current value. `records.values`
   * is keyed by field UUID, not api_name (ADR-0002 — see RecordsService.project()'s
   * own `stored[def.id]` lookup), so this reads `resultFieldId` straight off
   * the row rather than resolving an api_name first. */
  private async existingResultValue(databaseId: string, recordId: string, resultFieldId: string): Promise<boolean> {
    const row = await this.records.getRow(databaseId, recordId);
    const value = (row.values as Record<string, unknown> | null)?.[resultFieldId];
    return typeof value === 'string' && value.trim().length > 0;
  }

  /**
   * Which attachment goes out: the media field's FIRST attachment IN THE ORDER THE FIELD HOLDS THEM.
   *
   * An attachment field's value is an ordered list of attachment ids that a person can reorder
   * (assertOwnedAttachments allows reordering), so "first" is what the cell shows first, and it is
   * the SAME rule the approval preview uses to show the approver the image that will be posted
   * (ticket #826). This used to pick the NEWEST upload (`createdAt desc`) while its own doc comment
   * said "first": with two attachments the approver approved one image and a different one was
   * published. An id on the field that no longer resolves is skipped; a field whose value is empty
   * falls back to the oldest upload (the order `loadAttachmentChips` shows when nothing is stored).
   */
  private async pickMediaAttachment(databaseId: string, recordId: string, mediaFieldId: string) {
    const row = await this.records.getRow(databaseId, recordId);
    const stored = (row.values as Record<string, unknown> | null)?.[mediaFieldId];
    const ids = Array.isArray(stored)
      ? stored.map((v) => (typeof v === 'string' ? v : (v as { id?: unknown } | null)?.id)).filter((v): v is string => typeof v === 'string')
      : [];
    const onField = await this.db.query.attachments.findMany({
      where: and(eq(attachments.recordId, recordId), eq(attachments.fieldId, mediaFieldId)),
      orderBy: (a, { asc: ascOrder }) => [ascOrder(a.createdAt)],
    });
    for (const id of ids) {
      const hit = onField.find((a) => a.id === id);
      if (hit) return hit;
    }
    return onField[0] ?? null;
  }

  /** The chosen attachment, fetched into memory — attachments are already capped by
   * ATTACHMENT_MAX_BYTES on upload, so this never buffers more than one upload's worth. */
  private async loadMedia(databaseId: string, recordId: string, mediaFieldId: string): Promise<MediaAsset | null> {
    const attachment = await this.pickMediaAttachment(databaseId, recordId, mediaFieldId);
    if (!attachment) return null;
    const stream = await getStorage().getStream(attachment.storageKey);
    const buffer = await streamToBuffer(stream);
    return { attachmentId: attachment.id, buffer, mime: attachment.mime, filename: attachment.filename };
  }

  // ── Meta (Facebook Pages + Instagram) ──────────────────────────────────

  /** Instagram's container poll: every 3 seconds for up to a minute. Tests replace it so they do not wait. */
  metaPoll: MetaPoll = { intervalMs: 3000, maxAttempts: 20, sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) };

  private async publishToMetaTarget(
    auth: Partial<MetaAuth>,
    action: PostSocialAction,
    media: MediaAsset | null,
    provider: string,
    workspaceId: string,
  ): Promise<PostSocialResult> {
    if (provider !== 'meta') {
      throw publishFailure('wrong_connection', 'The connection this post uses is not a Facebook and Instagram connection.', false);
    }
    return publishToMeta({
      auth,
      action,
      media,
      fetcher: this.fetcher,
      poll: this.metaPoll,
      mintImageUrl: (attachmentId) => mintAttachmentUrl(attachmentId).url,
      // Meta said the credential is dead (error 190): flip the connection so the gallery and the creator see it, once.
      onReconnectRequired: () => this.connections.flagReconnectRequired(workspaceId, action.connection_id),
    });
  }

  // ── LinkedIn ───────────────────────────────────────────────────────────

  private async publishToLinkedin(
    auth: Partial<LinkedinAuth>,
    action: PostSocialAction,
    media: MediaAsset | null,
    provider: string,
  ): Promise<PostSocialResult> {
    if (provider !== 'linkedin') {
      throw publishFailure('wrong_connection', 'The connection this post uses is not a LinkedIn connection.', false);
    }
    if (!auth.access_token) {
      throw publishFailure('no_token', 'The LinkedIn connection has no access token. Reconnect it.', false);
    }
    // Ticket #42: WHO the post goes out as is always named. A company page posts AS the organization the action names
    // (account_id, chosen from the connection's page list); a member post goes out as the connection's own member, and
    // an account_id on it only pins that member, it never redirects the post somewhere else.
    let authorUrn: string;
    if (action.target === 'linkedin_org') {
      authorUrn = action.account_id!;
    } else {
      authorUrn = await this.fetchLinkedinAuthorUrn(auth.access_token);
      if (action.account_id && action.account_id !== authorUrn) {
        throw publishFailure('account_mismatch', 'The member this post names is not the member the connection belongs to.', false);
      }
    }

    let mediaUrn: string | undefined;
    if (media) {
      mediaUrn = await this.uploadLinkedinMedia(auth.access_token, authorUrn, media);
    }

    const postBody: Record<string, unknown> = {
      author: authorUrn,
      commentary: action.link ? `${action.text}\n\n${action.link}` : action.text,
      visibility: 'PUBLIC',
      distribution: { feedDistribution: 'MAIN_FEED', targetEntities: [], thirdPartyDistributionChannels: [] },
      lifecycleState: 'PUBLISHED',
      isReshareDisabledByAuthor: false,
    };
    if (mediaUrn) {
      postBody.content = { media: { id: mediaUrn } };
    }

    const res = await this.fetcher('https://api.linkedin.com/rest/posts', {
      method: 'POST',
      headers: this.linkedinHeaders(auth.access_token),
      body: JSON.stringify(postBody),
    });
    if (res.status < 200 || res.status >= 300) {
      throw httpFailure('LinkedIn', 'post', res.status);
    }
    // LinkedIn returns the created post's URN in the x-restli-id / x-linkedin-id
    // response header, not the JSON body (a 201 with no body is normal here).
    const postUrn = res.headers?.get?.('x-restli-id') ?? res.headers?.get?.('x-linkedin-id') ?? authorUrn;
    return { url: `https://www.linkedin.com/feed/update/${postUrn}/`, external_id: postUrn };
  }

  private linkedinHeaders(accessToken: string): Record<string, string> {
    return {
      authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json',
      'LinkedIn-Version': LINKEDIN_API_VERSION,
      'X-Restli-Protocol-Version': '2.0.0',
    };
  }

  private async fetchLinkedinAuthorUrn(accessToken: string): Promise<string> {
    const res = await this.fetcher('https://api.linkedin.com/v2/userinfo', {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    if (res.status < 200 || res.status >= 300) {
      throw httpFailure('LinkedIn', 'profile lookup', res.status);
    }
    const body = (await res.json()) as { sub?: string };
    if (!body.sub) {
      throw publishFailure('bad_response', 'LinkedIn did not say which member the connection belongs to.', false);
    }
    return `urn:li:person:${body.sub}`;
  }

  /** initializeUpload → PUT bytes → the resulting image URN, per LinkedIn's
   * Images API (the Step 4 sequence the ticket describes). */
  private async uploadLinkedinMedia(accessToken: string, authorUrn: string, media: MediaAsset): Promise<string> {
    const initRes = await this.fetcher('https://api.linkedin.com/rest/images?action=initializeUpload', {
      method: 'POST',
      headers: this.linkedinHeaders(accessToken),
      body: JSON.stringify({ initializeUploadRequest: { owner: authorUrn } }),
    });
    if (initRes.status < 200 || initRes.status >= 300) {
      throw httpFailure('LinkedIn', 'image upload', initRes.status);
    }
    const initBody = (await initRes.json()) as {
      value?: { uploadUrl?: string; image?: string };
    };
    const uploadUrl = initBody.value?.uploadUrl;
    const imageUrn = initBody.value?.image;
    if (!uploadUrl || !imageUrn) {
      throw publishFailure('bad_response', 'LinkedIn did not accept the image upload.', false);
    }
    const putRes = await this.fetcher(uploadUrl, {
      method: 'PUT',
      headers: { authorization: `Bearer ${accessToken}` },
      body: media.buffer.toString('binary'),
    });
    if (putRes.status < 200 || putRes.status >= 300) {
      throw httpFailure('LinkedIn', 'image upload', putRes.status);
    }
    return imageUrn;
  }

  // ── X ──────────────────────────────────────────────────────────────────

  private async publishToX(
    auth: Partial<XAuth>,
    action: PostSocialAction,
    media: MediaAsset | null,
  ): Promise<PostSocialResult> {
    if (!auth.access_token) {
      throw publishFailure('no_token', 'The X connection has no access token. Reconnect it.', false);
    }
    let mediaId: string | undefined;
    if (media) {
      mediaId = await this.uploadXMedia(auth.access_token, media);
    }
    const text = action.link ? `${action.text}\n\n${action.link}` : action.text;
    const body: Record<string, unknown> = { text };
    if (mediaId) body.media = { media_ids: [mediaId] };

    const res = await this.fetcher('https://api.twitter.com/2/tweets', {
      method: 'POST',
      headers: { authorization: `Bearer ${auth.access_token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.status < 200 || res.status >= 300) {
      throw httpFailure('X', 'post', res.status);
    }
    const json = (await res.json()) as { data?: { id?: string } };
    const tweetId = json.data?.id;
    if (!tweetId) {
      throw publishFailure('bad_response', 'X accepted the post but did not return its id, so the link could not be saved.', false);
    }
    return { url: `https://x.com/i/web/status/${tweetId}`, external_id: tweetId };
  }

  /** INIT → APPEND → FINALIZE against the v1.1 chunked media upload endpoint
   * — v2 has no media endpoint of its own yet, so posting an image on X still
   * goes through this older API even for an otherwise-v2 tweet. */
  private async uploadXMedia(accessToken: string, media: MediaAsset): Promise<string> {
    const auth = { authorization: `Bearer ${accessToken}` };
    const initRes = await this.fetcher('https://upload.twitter.com/1.1/media/upload.json', {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        command: 'INIT',
        total_bytes: String(media.buffer.byteLength),
        media_type: media.mime,
      }).toString(),
    });
    if (initRes.status < 200 || initRes.status >= 300) {
      throw httpFailure('X', 'image upload', initRes.status);
    }
    const initJson = (await initRes.json()) as { media_id_string?: string };
    const mediaId = initJson.media_id_string;
    if (!mediaId) throw publishFailure('bad_response', 'X did not accept the image upload.', false);

    const appendRes = await this.fetcher('https://upload.twitter.com/1.1/media/upload.json', {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        command: 'APPEND',
        media_id: mediaId,
        media_data: media.buffer.toString('base64'),
        segment_index: '0',
      }).toString(),
    });
    if (appendRes.status < 200 || appendRes.status >= 300) {
      throw httpFailure('X', 'image upload', appendRes.status);
    }

    const finalizeRes = await this.fetcher('https://upload.twitter.com/1.1/media/upload.json', {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ command: 'FINALIZE', media_id: mediaId }).toString(),
    });
    if (finalizeRes.status < 200 || finalizeRes.status >= 300) {
      throw httpFailure('X', 'image upload', finalizeRes.status);
    }
    return mediaId;
  }
}
