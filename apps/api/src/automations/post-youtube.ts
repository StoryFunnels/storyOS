import { Readable } from 'node:stream';
import type { ProviderError } from '../common/provider-error';
import { RealNetworkRefused } from '../common/test-network-guard';
import { YOUTUBE_CHANNELS_URL } from '../connections/providers/youtube';
import type { YoutubeAuth } from '../connections/providers/youtube';
import { publishFailure } from './publish-failure';
import type { PostSocialAction, PostSocialResult } from './post-social.action';

/**
 * Ticket #60 — the YouTube half of `post_social` (target `youtube_channel`): resumable upload of one video to ONE NAMED channel.
 *
 * Everything that talks to Google lives here, behind an injected `fetcher`, so a test drives the whole protocol with a fake
 * session and nothing ever reaches the real API. The orchestration that needs the database (who is acting, which attachment,
 * where a session is kept) is in PostSocialActionService; this file never touches the database.
 *
 * The rules this file enforces, each with a test:
 *  - the channel the token belongs to is asked of YouTube and must be the channel the rule names, BEFORE a byte is sent;
 *  - the upload is the resumable protocol, one chunk in memory at a time, resumed from the byte YouTube says it has;
 *  - a session URI is only ever used (with the token) on a Google host;
 *  - a quota refusal is a coded, retryable failure scheduled for after the next reset, never the minute backoff;
 *  - nothing a provider said is stored: a failure is a code and a sentence this file wrote.
 */

export const YOUTUBE_INIT_URL = 'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status';
/** YouTube's own field limits. */
export const YOUTUBE_TITLE_MAX = 100;
export const YOUTUBE_DESCRIPTION_MAX_BYTES = 5000;
export const YOUTUBE_TAGS_MAX_CHARS = 500;
/** Chunks are a multiple of this (YouTube's resumable protocol). */
export const CHUNK_ALIGN = 256 * 1024;

/** What has been sent so far, kept on the job so a retry resumes instead of starting over. Holds no credential. */
export interface UploadSession {
  session_uri: string;
  bytes_sent: number;
  size: number;
  attachment_id: string;
}

export interface YoutubeVideo {
  attachmentId: string;
  filename: string;
  mime: string;
  size: number;
  /** The video's bytes from `offset` on. Storage has no range read, so the caller skips; this never buffers the file. */
  open: (offset: number) => Promise<Readable>;
}

export interface YoutubeUploadArgs {
  auth: Partial<YoutubeAuth>;
  action: PostSocialAction;
  video: YoutubeVideo;
  fetcher: typeof fetch;
  chunkBytes: number;
  /** A session saved by an earlier attempt of this job, if any. */
  session: UploadSession | null;
  saveSession: (session: UploadSession | null) => Promise<void>;
  /** The connection's CURRENT access token, re-read (the refresh loop may have replaced it during a long upload). */
  reloadToken: () => Promise<string | undefined>;
  /** Google said the credential is dead: flip the connection to `expired` so the owner is told. */
  onReconnectRequired: () => Promise<void>;
  signal?: AbortSignal;
  now?: () => Date;
}

/** `Range: bytes=0-N` into "N+1 bytes are safe". No header means none yet. */
export function parseRange(header: string | null | undefined): number {
  if (!header) return 0;
  const m = /^bytes=0-(\d+)$/.exec(header.trim());
  return m ? Number(m[1]) + 1 : 0;
}

/**
 * Milliseconds from `now` to just after the next YouTube quota reset, which is midnight in Pacific time. A day with a daylight
 * saving change can be an hour off; the margin absorbs it, and an early retry only meets the quota again and waits another day.
 */
export function msUntilQuotaReset(now: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hourCycle: 'h23', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(now);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const sinceMidnight = get('hour') * 3600 + get('minute') * 60 + get('second');
  return (86_400 - sinceMidnight) * 1000 + 5 * 60_000;
}

/** Google's `error.errors[0].reason` and nothing else of the body (the message can echo a title, a description or an id). */
async function googleReason(res: Response): Promise<string | undefined> {
  try {
    const body = (await res.json()) as { error?: { errors?: { reason?: unknown }[] } };
    const reason = body?.error?.errors?.[0]?.reason;
    return typeof reason === 'string' && /^[A-Za-z]{3,48}$/.test(reason) ? reason : undefined;
  } catch {
    return undefined;
  }
}

/** One failed call, reduced to a code and a sentence that carries the HTTP status and a vetted reason word, nothing else. */
export function youtubeFailure(step: string, status: number, reason: string | undefined, now: Date): ProviderError {
  if (reason === 'quotaExceeded' || reason === 'dailyLimitExceeded') {
    return publishFailure(
      'quota_exceeded',
      "YouTube's daily upload quota for this app is used up. It resets at midnight Pacific time, and the upload is scheduled to try again then.",
      true,
      msUntilQuotaReset(now),
    );
  }
  if (reason === 'uploadLimitExceeded') {
    return publishFailure('upload_limit', 'This channel has reached the number of videos YouTube lets it upload for now. Try again later.', false);
  }
  if (reason === 'rateLimitExceeded' || reason === 'userRateLimitExceeded' || status === 429) {
    return publishFailure('rate_limited', `YouTube asked us to slow down (HTTP ${status}). The upload will try again.`, true);
  }
  if (status === 401) return publishFailure('auth_refused', `YouTube refused the ${step} (HTTP 401). Reconnect the account.`, false);
  if (status === 403) {
    const scope = reason === 'insufficientPermissions' || reason === 'insufficientScope' || reason === 'forbidden';
    return publishFailure(
      'forbidden',
      `YouTube refused the ${step} (HTTP 403).${scope ? ' Reconnect the account and allow uploads.' : ' The connected account may not be allowed to upload to this channel.'}`,
      false,
    );
  }
  if (status === 404) return publishFailure('not_found', `YouTube did not find what the ${step} needs (HTTP 404).`, false);
  if (status >= 500) return publishFailure('provider_unavailable', `YouTube is busy (HTTP ${status}) during the ${step}. The upload will try again.`, true);
  return publishFailure('rejected', `YouTube rejected the ${step} (HTTP ${status}${reason ? `, ${reason}` : ''}).`, false);
}

/** The title, description, tags and privacy as YouTube takes them, or a refusal that says which one is wrong. Checked before any call. */
export function buildYoutubeMetadata(action: PostSocialAction): { snippet: { title: string; description: string; tags?: string[] }; status: { privacyStatus: 'private' | 'unlisted' | 'public' } } {
  const title = (action.title ?? '').trim();
  if (!title) throw publishFailure('bad_metadata', 'The video has no title. Fill the title in the rule (or the field it comes from) and run it again.', false);
  if ([...title].length > YOUTUBE_TITLE_MAX) {
    throw publishFailure('bad_metadata', `The title is ${[...title].length} characters and YouTube allows ${YOUTUBE_TITLE_MAX}.`, false);
  }
  const description = action.text;
  if (Buffer.byteLength(description, 'utf8') > YOUTUBE_DESCRIPTION_MAX_BYTES) {
    throw publishFailure('bad_metadata', `The description is longer than YouTube's ${YOUTUBE_DESCRIPTION_MAX_BYTES} bytes.`, false);
  }
  if (/[<>]/.test(title) || /[<>]/.test(description)) {
    throw publishFailure('bad_metadata', 'YouTube does not allow < or > in a title or description.', false);
  }
  const tags = [...new Set((action.tags ?? '').split(',').map((t) => t.trim()).filter(Boolean))];
  const tagChars = tags.reduce((n, t) => n + [...t].length + (t.includes(' ') ? 2 : 0), 0) + Math.max(0, tags.length - 1);
  if (tagChars > YOUTUBE_TAGS_MAX_CHARS) {
    throw publishFailure('bad_metadata', `The tags add up to ${tagChars} characters and YouTube allows ${YOUTUBE_TAGS_MAX_CHARS}.`, false);
  }
  // NEVER PUBLIC BY DEFAULT: only an explicit `public` is public.
  const privacyStatus = action.privacy ?? 'private';
  return { snippet: { title, description, ...(tags.length ? { tags } : {}) }, status: { privacyStatus } };
}

/** A session URI is only ever sent a token if it is a Google upload host: it came back from Google, but it is also read from a stored job. */
export function isGoogleSessionUri(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const u = new URL(value);
    return u.protocol === 'https:' && (u.hostname === 'googleapis.com' || u.hostname.endsWith('.googleapis.com'));
  } catch {
    return false;
  }
}

/** The bytes from `offset` on of a stream that can only be read from the start. Streams; never buffers more than one read. */
export function streamFromOffset(stream: Readable, offset: number): Readable {
  if (offset <= 0) return stream;
  async function* skipped(): AsyncGenerator<Buffer> {
    let seen = 0;
    for await (const piece of stream) {
      const buf = Buffer.isBuffer(piece) ? piece : Buffer.from(piece as string);
      if (seen + buf.length <= offset) {
        seen += buf.length;
        continue;
      }
      const from = Math.max(0, offset - seen);
      seen = offset;
      yield buf.subarray(from);
    }
  }
  return Readable.from(skipped());
}

/** Pulls exactly N bytes at a time out of a stream, holding at most one chunk plus one read. */
class ChunkReader {
  private readonly iterator: AsyncIterator<unknown>;
  private rest: Buffer = Buffer.alloc(0);
  private ended = false;

  constructor(private readonly stream: Readable) {
    this.iterator = stream[Symbol.asyncIterator]();
  }

  async take(n: number): Promise<Buffer> {
    const parts: Buffer[] = this.rest.length ? [this.rest] : [];
    let have = this.rest.length;
    this.rest = Buffer.alloc(0);
    while (have < n && !this.ended) {
      const next = await this.iterator.next();
      if (next.done) {
        this.ended = true;
        break;
      }
      const buf = Buffer.isBuffer(next.value) ? next.value : Buffer.from(next.value as string);
      parts.push(buf);
      have += buf.length;
    }
    const all = parts.length === 1 ? parts[0]! : Buffer.concat(parts, have);
    if (all.length > n) {
      this.rest = all.subarray(n);
      return all.subarray(0, n);
    }
    return all;
  }

  close(): void {
    this.stream.destroy();
  }
}

/** The whole protocol. Returns the video's URL and id; throws a coded failure (retryable ones resume from the saved session). */
export async function uploadToYoutube(args: YoutubeUploadArgs): Promise<PostSocialResult> {
  const { action, video, chunkBytes } = args;
  const now = args.now ?? (() => new Date());
  const metadata = buildYoutubeMetadata(action);
  let token = args.auth.access_token;
  if (!token) throw publishFailure('no_token', 'The YouTube connection has no access token. Reconnect it.', false);
  if (chunkBytes % CHUNK_ALIGN !== 0 || chunkBytes <= 0) throw new Error('chunkBytes must be a multiple of 256 KiB');

  /** One call, with the token; a 401 re-reads the connection's token once (a long upload outlives an access token). */
  const call = async (step: string, url: string, init: RequestInit): Promise<Response> => {
    const send = async (t: string): Promise<Response> => {
      try {
        return await args.fetcher(url, { ...init, headers: { ...(init.headers as Record<string, string>), authorization: `Bearer ${t}` }, signal: args.signal });
      } catch (error) {
        if (error instanceof RealNetworkRefused) throw error;
        throw publishFailure('provider_unavailable', `Could not reach YouTube during the ${step}. The upload will try again and resume where it stopped.`, true);
      }
    };
    let res = await send(token!);
    if (res.status === 401) {
      const fresh = await args.reloadToken();
      if (fresh && fresh !== token) {
        token = fresh;
        res = await send(token);
      }
      if (res.status === 401) {
        await args.onReconnectRequired();
        throw youtubeFailure(step, 401, undefined, now());
      }
    }
    return res;
  };

  const fail = async (step: string, res: Response): Promise<never> => {
    throw youtubeFailure(step, res.status, await googleReason(res), now());
  };

  // 1. WHICH CHANNEL. Asked of YouTube with this token, and it has to be the channel the rule names: a connection can be moved to
  //    another channel by reconnecting, and a video must never follow it there silently.
  const channels = await call('channel check', YOUTUBE_CHANNELS_URL, { method: 'GET' });
  if (channels.status < 200 || channels.status >= 300) await fail('channel check', channels);
  const body = (await channels.json().catch(() => ({}))) as { items?: { id?: unknown }[] };
  const ids = (body.items ?? []).map((i) => i.id).filter((i): i is string => typeof i === 'string');
  if (!action.account_id || !ids.includes(action.account_id)) {
    throw publishFailure('account_mismatch', 'The channel this rule names is not the channel the connection belongs to. Nothing was uploaded. Reconnect with the right channel or change the rule.', false);
  }

  // 2. THE SESSION: the one an earlier attempt opened (same file, Google host), or a new one.
  let session: UploadSession | null =
    args.session && args.session.attachment_id === video.attachmentId && args.session.size === video.size && isGoogleSessionUri(args.session.session_uri)
      ? args.session
      : null;
  let offset = 0;
  let finished: Response | null = null;

  if (session) {
    // Ask YouTube how much it has: our own count may be a chunk behind (died after the PUT, before the save).
    const status = await call('upload status check', session.session_uri, {
      method: 'PUT',
      headers: { 'content-range': `bytes */${video.size}` },
    });
    if (status.status === 308) offset = parseRange(status.headers.get('range'));
    else if (status.status === 200 || status.status === 201) finished = status;
    else if (status.status === 404 || status.status === 410) session = null;
    else await fail('upload status check', status);
  }

  if (!session) {
    const init = await call('upload start', YOUTUBE_INIT_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json; charset=UTF-8',
        'x-upload-content-length': String(video.size),
        'x-upload-content-type': video.mime,
      },
      body: JSON.stringify(metadata),
    });
    if (init.status < 200 || init.status >= 300) await fail('upload start', init);
    const uri = init.headers.get('location');
    if (!isGoogleSessionUri(uri)) {
      throw publishFailure('bad_response', 'YouTube did not open an upload session.', false);
    }
    session = { session_uri: uri, bytes_sent: 0, size: video.size, attachment_id: video.attachmentId };
    offset = 0;
    await args.saveSession(session);
  }

  // 3. THE BYTES. One chunk in memory at a time.
  if (!finished) {
    let reader = new ChunkReader(await video.open(offset));
    try {
      while (offset < video.size) {
        const want = Math.min(chunkBytes, video.size - offset);
        const chunk = await reader.take(want);
        if (chunk.length !== want) {
          throw publishFailure('video_missing', 'The stored video is shorter than it was when the upload started. Nothing more was sent.', false);
        }
        const res = await call('upload', session.session_uri, {
          method: 'PUT',
          headers: { 'content-range': `bytes ${offset}-${offset + chunk.length - 1}/${video.size}`, 'content-type': video.mime },
          body: chunk as unknown as BodyInit,
        });
        if (res.status === 200 || res.status === 201) {
          finished = res;
          break;
        }
        if (res.status === 308) {
          const accepted = parseRange(res.headers.get('range'));
          if (accepted !== offset + chunk.length) {
            // YouTube kept a different amount than was sent: read again from the byte it has, rather than guess.
            offset = accepted;
            reader.close();
            reader = new ChunkReader(await video.open(offset));
          } else {
            offset = accepted;
          }
          session = { ...session, bytes_sent: offset };
          await args.saveSession(session);
          continue;
        }
        if (res.status === 404 || res.status === 410) {
          // The session is gone (they expire): forget it so the next attempt opens a new one.
          await args.saveSession(null);
          throw publishFailure('provider_unavailable', 'YouTube closed the upload session. The upload will start again.', true);
        }
        await fail('upload', res);
      }
    } finally {
      reader.close();
    }
  }

  if (!finished) throw publishFailure('bad_response', 'YouTube did not confirm the upload.', false);
  const resource = (await finished.json().catch(() => ({}))) as { id?: unknown };
  const id = typeof resource.id === 'string' && /^[A-Za-z0-9_-]{6,32}$/.test(resource.id) ? resource.id : undefined;
  if (!id) {
    throw publishFailure('bad_response', 'YouTube took the upload but did not return the video id, so the link could not be saved.', false);
  }
  await args.saveSession(null).catch(() => undefined);
  return { url: `https://youtu.be/${id}`, external_id: id };
}
