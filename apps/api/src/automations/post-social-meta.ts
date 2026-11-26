import type { MetaAuth, MetaPage } from '../connections/providers/meta';
import { metaErrorCodes, metaGraphBase } from '../connections/providers/meta';
import type { ProviderError } from '../common/provider-error';
import { publishFailure } from './publish-failure';
import type { PostSocialAction, PostSocialResult } from './post-social.action';

/** The chosen attachment, fetched into memory (see PostSocialActionService.loadMedia). */
export interface MetaMedia {
  attachmentId: string;
  buffer: Buffer;
  mime: string;
  filename: string;
}

/** Instagram's documented limits for a single image post (ticket #51). */
export const IG_CAPTION_MAX = 2200;
export const IG_HASHTAG_MAX = 30;
export const IG_RATIO_MIN = 0.8;
export const IG_RATIO_MAX = 1.91;
export const IG_IMAGE_MAX_BYTES = 8 * 1024 * 1024;
/** Facebook's own post length cap is far above the schema's 3000; no tighter check is needed. */

export interface MetaPoll {
  intervalMs: number;
  maxAttempts: number;
  sleep: (ms: number) => Promise<void>;
}

export interface MetaPublishArgs {
  auth: Partial<MetaAuth>;
  action: PostSocialAction;
  media: MetaMedia | null;
  fetcher: typeof fetch;
  poll: MetaPoll;
  /** A short-lived signed URL Meta can fetch the image from (the attachment never becomes public). */
  mintImageUrl: (attachmentId: string) => string;
  /** Called when Meta says the credential is no longer valid, so the connection is flipped to `expired`. */
  onReconnectRequired: () => Promise<void>;
}

/** Width and height of a JPEG, read from its first SOF marker. Null when the bytes are not a readable JPEG. */
export function jpegSize(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8 || buf[2] !== 0xff) return null;
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) return null;
    let marker = buf[i + 1]!;
    while (marker === 0xff && i + 2 < buf.length) {
      i += 1;
      marker = buf[i + 1]!;
    }
    // Standalone markers carry no length.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    const length = buf.readUInt16BE(i + 2);
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      const height = buf.readUInt16BE(i + 5);
      const width = buf.readUInt16BE(i + 7);
      return width > 0 && height > 0 ? { width, height } : null;
    }
    if (length < 2) return null;
    i += 2 + length;
  }
  return null;
}

/** Hashtags the way Instagram counts them: a `#` starting a word of letters, digits or underscores. */
export function countHashtags(caption: string): number {
  return caption.match(/(^|[^\p{L}\p{N}_&])#[\p{L}\p{N}_]+/gu)?.length ?? 0;
}

export function instagramCaption(action: Pick<PostSocialAction, 'text' | 'link'>): string {
  return action.link ? `${action.text}\n\n${action.link}` : action.text;
}

/**
 * Instagram's constraints, checked BEFORE any provider call so the person sees the specific reason on the record and
 * nothing is created on Meta's side. Every failure here is non-retryable: the same image will fail the same way.
 */
export function preflightInstagram(action: Pick<PostSocialAction, 'text' | 'link'>, media: MetaMedia | null): void {
  if (!media) {
    throw publishFailure('media_required', 'Instagram posts need an image, and the record has none in the rule\'s image field.', false);
  }
  if (media.mime !== 'image/jpeg') {
    throw publishFailure('media_unsupported', 'Instagram only accepts JPEG images for this kind of post. Use a JPEG.', false);
  }
  if (media.buffer.byteLength > IG_IMAGE_MAX_BYTES) {
    throw publishFailure('media_unsupported', 'The image is larger than the 8 MB Instagram accepts.', false);
  }
  const size = jpegSize(media.buffer);
  if (!size) {
    throw publishFailure('media_unsupported', 'The image is not a readable JPEG, so its size could not be checked. Re-export it as a JPEG.', false);
  }
  const ratio = size.width / size.height;
  if (ratio < IG_RATIO_MIN || ratio > IG_RATIO_MAX) {
    throw publishFailure(
      'media_unsupported',
      `The image is ${size.width} by ${size.height}. Instagram needs a width-to-height ratio between ${IG_RATIO_MIN} and ${IG_RATIO_MAX}.`,
      false,
    );
  }
  const caption = instagramCaption(action);
  const chars = [...caption].length;
  if (chars > IG_CAPTION_MAX) {
    throw publishFailure('too_long', `The caption is too long for Instagram: ${chars} of ${IG_CAPTION_MAX} characters.`, false);
  }
  const tags = countHashtags(caption);
  if (tags > IG_HASHTAG_MAX) {
    throw publishFailure('rejected', `The caption has ${tags} hashtags; Instagram allows ${IG_HASHTAG_MAX}.`, false);
  }
}

/** Which of the connection's own pages the action names. NOTHING POSTS FROM AN ACCOUNT THE CONNECTION DOES NOT HOLD. */
export function resolveMetaPage(auth: Partial<MetaAuth>, action: Pick<PostSocialAction, 'target' | 'account_id'>): MetaPage {
  const pages = Array.isArray(auth.pages) ? auth.pages : [];
  const page =
    action.target === 'facebook_page'
      ? pages.find((p) => p.page_id === action.account_id)
      : pages.find((p) => !!p.ig_user_id && p.ig_user_id === action.account_id);
  if (!page) {
    throw publishFailure(
      'account_mismatch',
      action.target === 'facebook_page'
        ? 'The Facebook Page this post names is not one of the Pages this connection was granted. Pick a Page from the connection and run the rule again.'
        : 'The Instagram account this post names is not linked to any Page this connection was granted. Pick it from the connection and run the rule again.',
      false,
    );
  }
  if (!page.page_token) throw publishFailure('no_token', 'The connection has no access token for this Page. Reconnect it.', false);
  return page;
}

/**
 * One Meta failure, reduced to a code and a sentence this file wrote. ONLY Meta's numeric error code and the HTTP status
 * are read: the message and detail can echo the post text, a person's name or a token fragment, so they are never stored.
 *
 * `ambiguous` marks a call that, if it failed in a way that does not prove nothing was published (a timeout, a 5xx), may
 * still have gone out. A blind retry of that call could post twice on a client's public page, so it is never retried by
 * itself; a person can press Retry after looking.
 */
async function metaFailure(
  step: string,
  res: { status: number; json: () => Promise<unknown> },
  opts: { ambiguous: boolean },
  onReconnectRequired: () => Promise<void>,
): Promise<ProviderError> {
  const { code } = await metaErrorCodes(res);
  const status = res.status;
  if (code === 190 || status === 401) {
    await onReconnectRequired();
    return publishFailure('reconnect_required', `Meta no longer accepts this connection (the access was removed or has expired). Reconnect it.`, false);
  }
  if (status === 429 || (code !== undefined && [4, 17, 32, 613, 80001, 80002, 80003, 80004, 80006, 80007, 80008].includes(code))) {
    return publishFailure('rate_limited', `Meta is limiting how often this account can ${step}. It will be tried again later.`, true);
  }
  if (code === 10 || (code !== undefined && code >= 200 && code <= 299)) {
    return publishFailure('forbidden', `Meta did not allow this connection to ${step} as this account (permission). Check the Page role and the connection's permissions.`, false);
  }
  if (status >= 500 || code === 1 || code === 2) {
    return publishFailure(
      'provider_unavailable',
      opts.ambiguous
        ? `Meta had a problem while the post was being published. Check the account before trying again, so it is not posted twice.`
        : `Meta had a temporary problem during ${step} (HTTP ${status}).`,
      !opts.ambiguous,
    );
  }
  if (code === 368) return publishFailure('rejected', 'Meta blocked this post as not allowed on this account.', false);
  return publishFailure('rejected', `Meta refused the ${step} (HTTP ${status}${code !== undefined ? `, code ${code}` : ''}).`, false);
}

/** A thrown network error (no response at all) as a safe failure. */
function unreachable(ambiguous: boolean): ProviderError {
  return publishFailure(
    'provider_unavailable',
    ambiguous ? 'Meta could not be reached while the post was being published. Check the account before trying again, so it is not posted twice.' : 'Meta could not be reached.',
    !ambiguous,
  );
}

async function graph(
  args: Pick<MetaPublishArgs, 'fetcher' | 'onReconnectRequired'>,
  step: string,
  url: string,
  token: string,
  init: { method?: 'GET' | 'POST'; body?: string | FormData; ambiguous: boolean },
): Promise<unknown> {
  let res: Awaited<ReturnType<typeof fetch>>;
  try {
    res = await args.fetcher(url, {
      method: init.method ?? 'GET',
      headers: {
        authorization: `Bearer ${token}`,
        ...(typeof init.body === 'string' ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
      },
      body: init.body,
    });
  } catch {
    throw unreachable(init.ambiguous);
  }
  if (res.status < 200 || res.status >= 300) throw await metaFailure(step, res, { ambiguous: init.ambiguous }, args.onReconnectRequired);
  try {
    return await res.json();
  } catch {
    throw publishFailure('bad_response', 'Meta answered in a way that could not be read.', false);
  }
}

function form(values: Record<string, string | undefined>): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(values)) if (v !== undefined) params.set(k, v);
  return params.toString();
}

/** Never put an id from a response into a URL path unchecked. */
function graphId(value: unknown): string | null {
  return typeof value === 'string' && /^[0-9_]{1,60}$/.test(value) ? value : null;
}

export async function publishToMeta(args: MetaPublishArgs): Promise<PostSocialResult> {
  const { action } = args;
  const page = resolveMetaPage(args.auth, action);
  const base = metaGraphBase();

  if (action.target === 'facebook_page') {
    if (args.media) {
      // Bytes go up with the request: nothing about the image is ever reachable from the internet.
      const body = new FormData();
      body.append('source', new Blob([new Uint8Array(args.media.buffer)], { type: args.media.mime }), args.media.filename);
      body.append('caption', instagramCaption(action));
      body.append('published', 'true');
      const out = (await graph(args, 'photo upload', `${base}/${page.page_id}/photos`, page.page_token, { method: 'POST', body, ambiguous: true })) as { id?: unknown; post_id?: unknown };
      const id = graphId(out.post_id) ?? graphId(out.id);
      if (!id) throw publishFailure('bad_response', 'Facebook accepted the photo but did not return its id, so the link could not be saved.', false);
      return { url: `https://www.facebook.com/${id}`, external_id: id };
    }
    const out = (await graph(args, 'post', `${base}/${page.page_id}/feed`, page.page_token, {
      method: 'POST',
      body: form({ message: action.text, link: action.link || undefined }),
      ambiguous: true,
    })) as { id?: unknown };
    const id = graphId(out.id);
    if (!id) throw publishFailure('bad_response', 'Facebook accepted the post but did not return its id, so the link could not be saved.', false);
    return { url: `https://www.facebook.com/${id}`, external_id: id };
  }

  // Instagram: image checked before anything is sent (preflightInstagram ran in the executor too, belt and braces for direct callers).
  preflightInstagram(action, args.media);
  const igId = page.ig_user_id!;
  const created = (await graph(args, 'image upload', `${base}/${igId}/media`, page.page_token, {
    method: 'POST',
    body: form({ image_url: args.mintImageUrl(args.media!.attachmentId), caption: instagramCaption(action) }),
    ambiguous: false,
  })) as { id?: unknown };
  const containerId = graphId(created.id);
  if (!containerId) throw publishFailure('bad_response', 'Instagram did not accept the image.', false);

  let ready = false;
  for (let attempt = 0; attempt < args.poll.maxAttempts; attempt += 1) {
    const status = (await graph(args, 'image check', `${base}/${containerId}?fields=status_code`, page.page_token, { ambiguous: false })) as { status_code?: unknown };
    const code = typeof status.status_code === 'string' ? status.status_code : '';
    if (code === 'FINISHED') {
      ready = true;
      break;
    }
    if (code === 'ERROR' || code === 'EXPIRED') {
      throw publishFailure('rejected', `Instagram could not use the image (status ${code.toLowerCase()}). Nothing was posted. Check the image and try again.`, false);
    }
    await args.poll.sleep(args.poll.intervalMs);
  }
  if (!ready) {
    throw publishFailure('provider_unavailable', 'Instagram was still processing the image when the wait ran out. Nothing was posted.', true);
  }

  const published = (await graph(args, 'post', `${base}/${igId}/media_publish`, page.page_token, {
    method: 'POST',
    body: form({ creation_id: containerId }),
    ambiguous: true,
  })) as { id?: unknown };
  const mediaId = graphId(published.id);
  if (!mediaId) throw publishFailure('bad_response', 'Instagram accepted the post but did not return its id, so the link could not be saved.', false);

  // The permalink is a nicety: the post is already live, so a failure here must never fail (and so never retry) the job.
  let url = page.ig_username ? `https://www.instagram.com/${encodeURIComponent(page.ig_username)}/` : 'https://www.instagram.com/';
  try {
    const link = (await graph(args, 'link lookup', `${base}/${mediaId}?fields=permalink`, page.page_token, { ambiguous: false })) as { permalink?: unknown };
    if (typeof link.permalink === 'string' && /^https:\/\/(www\.)?instagram\.com\//.test(link.permalink)) url = link.permalink;
  } catch {
    /* keep the profile link */
  }
  return { url, external_id: mediaId };
}
