import { createHash } from 'node:crypto';

/**
 * Ticket #60 — a scripted stand-in for the YouTube Data API, enough of it for the resumable upload protocol. NOTHING here is
 * real: the channel id, the video id and every token are made up, and the only way a request reaches this object is a test
 * assigning `fetch` to a service's `fetcher` seam (the default fetchers refuse the network under NODE_ENV=test).
 */
export const FAKE_CHANNEL = 'UCabcdefghijklmnopqrstuv';
export const OTHER_CHANNEL = 'UC0123456789abcdefghijkl';
export const FAKE_VIDEO_ID = 'vidFAKE12345';
export const INIT_PREFIX = 'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable';
export const SESSION_PREFIX = 'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&upload_id=';

export interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  /** The body as bytes when it was bytes, otherwise its text. Never retained beyond the length and a digest for chunks. */
  bodyText: string;
  bodyLength: number;
}

export type Reply = { status: number; json?: unknown; headers?: Record<string, string> };

interface Session {
  size: number;
  length: number;
  digest: ReturnType<typeof createHash>;
  metadata: unknown;
  complete: boolean;
}

export class FakeYoutube {
  channels: { id: string; snippet?: { title?: string; customUrl?: string } }[] = [{ id: FAKE_CHANNEL, snippet: { title: 'Foxglove Films', customUrl: '@foxglovefilms' } }];
  calls: Call[] = [];
  sessions = new Map<string, Session>();
  initCount = 0;
  /** Evaluated before the normal handling; return a Reply (or throw) to take over a call. */
  hook: ((call: Call, index: number) => Reply | Error | undefined) | null = null;
  /** The next chunk PUT keeps only this many of its bytes (YouTube accepting part of a chunk). */
  keepOnlyNext: number | null = null;
  /** The bytes of every chunk, in arrival order, only when asked: a large-stream test must not keep them. */
  keepBodies = false;
  bodies: Buffer[] = [];
  maxBody = 0;

  readonly fetch = (async (url: string | URL, init?: { method?: string; headers?: Record<string, string>; body?: unknown }): Promise<Response> => {
    const u = String(url);
    const method = init?.method ?? 'GET';
    const body = init?.body;
    const bytes = body instanceof Uint8Array ? body : null;
    const call: Call = {
      url: u,
      method,
      headers: Object.fromEntries(Object.entries(init?.headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)])),
      bodyText: bytes ? '' : typeof body === 'string' ? body : '',
      bodyLength: bytes ? bytes.length : typeof body === 'string' ? Buffer.byteLength(body) : 0,
    };
    this.calls.push(call);
    if (bytes) this.maxBody = Math.max(this.maxBody, bytes.length);
    const index = this.calls.length - 1;
    const hooked = this.hook?.(call, index);
    if (hooked instanceof Error) throw hooked;
    const reply = hooked ?? this.handle(call, bytes);
    return {
      status: reply.status,
      headers: new Headers(reply.headers ?? {}),
      json: async () => reply.json ?? {},
      text: async () => '',
    } as unknown as Response;
  }) as unknown as typeof fetch;

  private handle(call: Call, bytes: Uint8Array | null): Reply {
    if (call.url.startsWith('https://www.googleapis.com/youtube/v3/channels')) {
      return { status: 200, json: { items: this.channels } };
    }
    if (call.url.startsWith(INIT_PREFIX) && call.method === 'POST' && !call.url.includes('upload_id=')) {
      this.initCount += 1;
      const id = `S${this.initCount}`;
      this.sessions.set(id, { size: Number(call.headers['x-upload-content-length']), length: 0, digest: createHash('sha256'), metadata: JSON.parse(call.bodyText), complete: false });
      return { status: 200, headers: { location: `${SESSION_PREFIX}${id}` } };
    }
    if (call.url.startsWith(SESSION_PREFIX) && call.method === 'PUT') {
      const session = this.sessions.get(call.url.slice(SESSION_PREFIX.length));
      if (!session) return { status: 404 };
      const range = call.headers['content-range'] ?? '';
      const status = /^bytes \*\/(\d+)$/.exec(range);
      const reply308 = (): Reply => ({ status: 308, headers: session.length > 0 ? { range: `bytes=0-${session.length - 1}` } : {} });
      if (status) return session.complete ? { status: 200, json: { id: FAKE_VIDEO_ID } } : reply308();
      const m = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(range);
      if (!m || Number(m[1]) !== session.length || !bytes) return { status: 400, json: { error: { errors: [{ reason: 'badContentRange' }] } } };
      let keep = bytes;
      if (this.keepOnlyNext !== null) {
        keep = bytes.subarray(0, this.keepOnlyNext);
        this.keepOnlyNext = null;
      }
      session.digest.update(keep);
      session.length += keep.length;
      if (this.keepBodies) this.bodies.push(Buffer.from(keep));
      if (session.length === session.size) {
        session.complete = true;
        return { status: 200, json: { id: FAKE_VIDEO_ID } };
      }
      return reply308();
    }
    return { status: 500 };
  }

  /** sha256 of everything a session received, to compare against the source file without keeping the file. */
  digestOf(sessionId: string): string {
    const s = this.sessions.get(sessionId)!;
    return createHash('sha256').update(s.digest.copy().digest()).digest('hex');
  }

  receivedLength(sessionId: string): number {
    return this.sessions.get(sessionId)!.length;
  }

  chunkPuts(): Call[] {
    return this.calls.filter((c) => c.method === 'PUT' && /^bytes \d+-/.test(c.headers['content-range'] ?? ''));
  }

  inits(): Call[] {
    return this.calls.filter((c) => c.method === 'POST' && c.url.startsWith(INIT_PREFIX));
  }
}

/** What `digestOf` returns for the whole of `bytes`, so a test can compare without a second copy of the logic. */
export function expectedDigest(bytes: Buffer): string {
  return createHash('sha256').update(createHash('sha256').update(bytes).digest()).digest('hex');
}
