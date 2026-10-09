import { describe, expect, it, vi } from 'vitest';

const getStorageMock = vi.fn();
vi.mock('../attachments/storage', () => ({ getStorage: () => getStorageMock() }));

import { ProviderError } from '../common/provider-error';
import { PostSocialActionService } from './post-social.action';
import type { PostSocialAction, PostSocialJobPayload } from './post-social.action';

/** An async-iterable "stream" good enough for post-social.action.ts's own
 * `streamToBuffer` helper (it only ever does `for await (chunk of stream)`). */
function fakeStream(chunks: Buffer[]) {
  return {
    [Symbol.asyncIterator]: async function* () {
      for (const c of chunks) yield c;
    },
  };
}

/** A minimal fetch-shaped response, matching what `this.fetcher` (typeof
 * fetch) actually returns — including `.headers.get()`, which LinkedIn's
 * post-URN read depends on. */
function fakeResponse(overrides: Partial<{ status: number; json: unknown; text: string; headers: Record<string, string> }> = {}) {
  const headers = new Headers(overrides.headers ?? {});
  return {
    status: overrides.status ?? 200,
    headers,
    json: async () => overrides.json ?? {},
    text: async () => overrides.text ?? '',
  } as unknown as Response;
}

function newService(opts: { fieldsFindFirst?: unknown; attachmentsFindFirst?: unknown; recordsUpdate?: ReturnType<typeof vi.fn>; getRow?: ReturnType<typeof vi.fn> } = {}) {
  const db = {
    query: {
      fields: { findFirst: vi.fn().mockResolvedValue(opts.fieldsFindFirst ?? null) },
      // #826: the executor now lists the field's attachments and picks by the FIELD's order (see
      // test/post-social-media-rule.test.ts for the rule itself); this mock only supplies the row.
      attachments: {
        findFirst: vi.fn().mockResolvedValue(opts.attachmentsFindFirst ?? null),
        findMany: vi.fn().mockResolvedValue(opts.attachmentsFindFirst ? [{ id: 'att1', ...(opts.attachmentsFindFirst as object) }] : []),
      },
    },
  };
  const jobs = { registerExecutor: vi.fn() };
  const connections = {};
  const records = {
    update: opts.recordsUpdate ?? vi.fn().mockResolvedValue(undefined),
    getRow: opts.getRow ?? vi.fn().mockResolvedValue({ values: {} }),
  };
  const service = new PostSocialActionService(db as never, jobs as never, connections as never, records as never);
  return { service, db, jobs, connections, records };
}

function action(overrides: Partial<PostSocialAction> = {}): PostSocialAction {
  return {
    type: 'post_social',
    connection_id: 'conn1',
    target: 'linkedin_member',
    text: 'Hello world',
    ...overrides,
  } as PostSocialAction;
}

function payload(overrides: Partial<PostSocialAction> = {}, ctxOverrides: Partial<PostSocialJobPayload['ctx']> = {}): PostSocialJobPayload {
  return {
    action: action(overrides),
    ctx: { workspaceId: 'ws1', databaseId: 'db1', recordId: 'rec1', actorId: 'user1', depth: 0, ...ctxOverrides },
  };
}

function helpers(connectionAuth?: { provider: string; auth: unknown }) {
  return {
    connectionAuth: vi.fn().mockResolvedValue(connectionAuth ?? { provider: 'linkedin', auth: { access_token: 'tok' } }),
    fetcher: fetch,
    idempotencyKey: 'k1',
    signal: new AbortController().signal,
  };
}

describe('PostSocialActionService (ticket #42 / MN-257)', () => {
  it('registers itself as the post_social executor at boot', () => {
    const { service, jobs } = newService();
    service.onModuleInit();
    expect(jobs.registerExecutor).toHaveBeenCalledWith('post_social', expect.any(Function), { timeoutClass: 'long' });
  });

  describe('LinkedIn publish', () => {
    it('posts text-only and returns the post url/external_id from the response header', async () => {
      const fetcher = vi
        .fn()
        // fetchLinkedinAuthorUrn
        .mockResolvedValueOnce(fakeResponse({ json: { sub: 'member123' } }))
        // publish
        .mockResolvedValueOnce(fakeResponse({ status: 201, headers: { 'x-restli-id': 'urn:li:share:999' } }));
      const { service } = newService();
      service.fetcher = fetcher as unknown as typeof fetch;

      const result = await service.run(payload({ target: 'linkedin_member' }), helpers());

      expect(result).toEqual({ url: 'https://www.linkedin.com/feed/update/urn:li:share:999/', external_id: 'urn:li:share:999' });
      expect(fetcher).toHaveBeenCalledTimes(2);
      const [postUrl, postInit] = fetcher.mock.calls[1]!;
      expect(postUrl).toBe('https://api.linkedin.com/rest/posts');
      expect((postInit as { headers: Record<string, string> }).headers['LinkedIn-Version']).toBe('202401');
      expect((postInit as { headers: Record<string, string> }).headers['X-Restli-Protocol-Version']).toBe('2.0.0');
      const body = JSON.parse((postInit as { body: string }).body);
      expect(body.author).toBe('urn:li:person:member123');
      expect(body.commentary).toBe('Hello world');
    });

    it('appends the link to the commentary when set', async () => {
      const fetcher = vi
        .fn()
        .mockResolvedValueOnce(fakeResponse({ json: { sub: 'member123' } }))
        .mockResolvedValueOnce(fakeResponse({ status: 201, headers: { 'x-restli-id': 'urn:li:share:1' } }));
      const { service } = newService();
      service.fetcher = fetcher as unknown as typeof fetch;

      await service.run(payload({ link: 'https://example.com/post' }), helpers());

      const body = JSON.parse((fetcher.mock.calls[1]![1] as { body: string }).body);
      expect(body.commentary).toBe('Hello world\n\nhttps://example.com/post');
    });

    it('uploads media first (initializeUpload → PUT) then references the image urn in the post', async () => {
      const fetcher = vi
        .fn()
        .mockResolvedValueOnce(fakeResponse({ json: { sub: 'member123' } })) // userinfo
        .mockResolvedValueOnce(
          fakeResponse({ json: { value: { uploadUrl: 'https://upload.linkedin.com/x', image: 'urn:li:image:abc' } } }),
        ) // initializeUpload
        .mockResolvedValueOnce(fakeResponse({ status: 201 })) // PUT bytes
        .mockResolvedValueOnce(fakeResponse({ status: 201, headers: { 'x-restli-id': 'urn:li:share:2' } })); // posts
      const { service } = newService({
        attachmentsFindFirst: { storageKey: 'rec1/att1/original', mime: 'image/png', filename: 'cover.png' },
      });
      service.fetcher = fetcher as unknown as typeof fetch;
      getStorageMock.mockReturnValue({ getStream: vi.fn().mockResolvedValue(fakeStream([Buffer.from('fake-image-bytes')])) });

      const result = await service.run(payload({ media_field_id: 'media-field-id' }), helpers());

      expect(result).toEqual({ url: 'https://www.linkedin.com/feed/update/urn:li:share:2/', external_id: 'urn:li:share:2' });
      expect(fetcher).toHaveBeenCalledTimes(4);
      const [initUrl] = fetcher.mock.calls[1]!;
      expect(initUrl).toBe('https://api.linkedin.com/rest/images?action=initializeUpload');
      const [putUrl, putInit] = fetcher.mock.calls[2]!;
      expect(putUrl).toBe('https://upload.linkedin.com/x');
      expect((putInit as { method: string }).method).toBe('PUT');
      const postBody = JSON.parse((fetcher.mock.calls[3]![1] as { body: string }).body);
      expect(postBody.content).toEqual({ media: { id: 'urn:li:image:abc' } });
    });

    it('a connection whose provider is not "linkedin" refuses rather than posting', async () => {
      const fetcher = vi.fn();
      const { service } = newService();
      service.fetcher = fetcher as unknown as typeof fetch;

      const err = await service
        .run(payload({ target: 'linkedin_member' }), helpers({ provider: 'x', auth: { access_token: 'tok' } }))
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ProviderError);
      expect((err as ProviderError).retryable).toBe(false);
      expect(fetcher).not.toHaveBeenCalled();
    });
  });

  describe('X publish', () => {
    it('posts text-only via /2/tweets and returns the tweet url/id', async () => {
      const fetcher = vi.fn().mockResolvedValueOnce(fakeResponse({ json: { data: { id: 'tweet123' } } }));
      const { service } = newService();
      service.fetcher = fetcher as unknown as typeof fetch;

      const result = await service.run(
        payload({ target: 'x', text: 'Hi there' }),
        helpers({ provider: 'x', auth: { access_token: 'x-tok' } }),
      );

      expect(result).toEqual({ url: 'https://x.com/i/web/status/tweet123', external_id: 'tweet123' });
      expect(fetcher).toHaveBeenCalledTimes(1);
      const [url, init] = fetcher.mock.calls[0]!;
      expect(url).toBe('https://api.twitter.com/2/tweets');
      expect((init as { headers: Record<string, string> }).headers.authorization).toBe('Bearer x-tok');
      expect(JSON.parse((init as { body: string }).body)).toEqual({ text: 'Hi there' });
    });

    it('a 429 from the provider is reported as a retryable ProviderError', async () => {
      const fetcher = vi.fn().mockResolvedValueOnce(fakeResponse({ status: 429, text: 'rate limited' }));
      const { service } = newService();
      service.fetcher = fetcher as unknown as typeof fetch;

      const err = await service
        .run(payload({ target: 'x' }), helpers({ provider: 'x', auth: { access_token: 'x-tok' } }))
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ProviderError);
      expect((err as ProviderError).retryable).toBe(true);
    });

    it('uploads media via INIT/APPEND/FINALIZE before posting the tweet', async () => {
      const fetcher = vi
        .fn()
        .mockResolvedValueOnce(fakeResponse({ json: { media_id_string: 'media1' } })) // INIT
        .mockResolvedValueOnce(fakeResponse({ status: 204 })) // APPEND
        .mockResolvedValueOnce(fakeResponse({ status: 200 })) // FINALIZE
        .mockResolvedValueOnce(fakeResponse({ json: { data: { id: 'tweet456' } } })); // tweets
      const { service } = newService({
        attachmentsFindFirst: { storageKey: 'rec1/att1/original', mime: 'image/jpeg', filename: 'pic.jpg' },
      });
      service.fetcher = fetcher as unknown as typeof fetch;
      getStorageMock.mockReturnValue({ getStream: vi.fn().mockResolvedValue(fakeStream([Buffer.from('bytes')])) });

      const result = await service.run(
        payload({ target: 'x', media_field_id: 'media-field-id' }),
        helpers({ provider: 'x', auth: { access_token: 'x-tok' } }),
      );

      expect(result.external_id).toBe('tweet456');
      expect(fetcher).toHaveBeenCalledTimes(4);
      const commands = fetcher.mock.calls.slice(0, 3).map((call) => {
        const params = new URLSearchParams((call[1] as { body: string }).body);
        return params.get('command');
      });
      expect(commands).toEqual(['INIT', 'APPEND', 'FINALIZE']);
      const tweetBody = JSON.parse((fetcher.mock.calls[3]![1] as { body: string }).body);
      expect(tweetBody.media).toEqual({ media_ids: ['media1'] });
    });

    it('a 400 from the provider is reported as a non-retryable ProviderError', async () => {
      const fetcher = vi.fn().mockResolvedValueOnce(fakeResponse({ status: 400, text: 'bad request' }));
      const { service } = newService();
      service.fetcher = fetcher as unknown as typeof fetch;

      const err = await service
        .run(payload({ target: 'x' }), helpers({ provider: 'x', auth: { access_token: 'x-tok' } }))
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ProviderError);
      expect((err as ProviderError).retryable).toBe(false);
    });
  });

  describe('pre-flight checks (never reach the provider)', () => {
    it('rejects X text over the 280 weighted-character cap before any fetch call', async () => {
      const fetcher = vi.fn();
      const { service } = newService();
      service.fetcher = fetcher as unknown as typeof fetch;

      const longText = 'a'.repeat(281);
      const err = await service
        .run(payload({ target: 'x', text: longText }), helpers({ provider: 'x', auth: { access_token: 'x-tok' } }))
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(ProviderError);
      expect((err as ProviderError).retryable).toBe(false);
      expect((err as Error).message).toContain('too long for X');
      expect(fetcher).not.toHaveBeenCalled();
    });

    it('allows exactly 280 weighted characters on X', async () => {
      const fetcher = vi.fn().mockResolvedValueOnce(fakeResponse({ json: { data: { id: 't1' } } }));
      const { service } = newService();
      service.fetcher = fetcher as unknown as typeof fetch;

      const text = 'a'.repeat(280);
      const result = await service.run(
        payload({ target: 'x', text }),
        helpers({ provider: 'x', auth: { access_token: 'x-tok' } }),
      );
      expect(result.external_id).toBe('t1');
    });

    it('does not apply the 280-char cap to LinkedIn (only the zod schema max(3000) does)', async () => {
      const fetcher = vi
        .fn()
        .mockResolvedValueOnce(fakeResponse({ json: { sub: 'm1' } }))
        .mockResolvedValueOnce(fakeResponse({ status: 201, headers: { 'x-restli-id': 'urn:li:share:3' } }));
      const { service } = newService();
      service.fetcher = fetcher as unknown as typeof fetch;

      const text = 'a'.repeat(400); // well over X's cap, fine for LinkedIn
      const result = await service.run(payload({ target: 'linkedin_member', text }), helpers());
      expect(result.external_id).toBe('urn:li:share:3');
    });

    it('dedup: a non-empty existing value on result_field_id skips the post, non-retryably, with no provider call', async () => {
      const fetcher = vi.fn();
      const getRow = vi.fn().mockResolvedValue({ values: { 'result-field-id': 'https://already.posted/1' } });
      const { service } = newService({ getRow });
      service.fetcher = fetcher as unknown as typeof fetch;

      const err = await service
        .run(payload({ result_field_id: 'result-field-id' }), helpers())
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(ProviderError);
      expect((err as ProviderError).retryable).toBe(false);
      expect((err as Error).message).toContain('already posted');
      expect(fetcher).not.toHaveBeenCalled();
    });

    it('an empty-string value on result_field_id does NOT count as already posted', async () => {
      const fetcher = vi.fn().mockResolvedValueOnce(fakeResponse({ json: { data: { id: 't2' } } }));
      const getRow = vi.fn().mockResolvedValue({ values: { 'result-field-id': '' } });
      const { service } = newService({ getRow });
      service.fetcher = fetcher as unknown as typeof fetch;

      const result = await service.run(
        payload({ target: 'x', result_field_id: 'result-field-id' }),
        helpers({ provider: 'x', auth: { access_token: 'x-tok' } }),
      );
      expect(result.external_id).toBe('t2');
    });
  });

  describe('result write-back', () => {
    it('writes the published url onto result_field_id via RecordsService.update with depth+1', async () => {
      const fetcher = vi.fn().mockResolvedValueOnce(fakeResponse({ json: { data: { id: 't3' } } }));
      const recordsUpdate = vi.fn().mockResolvedValue(undefined);
      const { service } = newService({
        fieldsFindFirst: { id: 'result-field-id', apiName: 'post_url', databaseId: 'db1' },
        recordsUpdate,
      });
      service.fetcher = fetcher as unknown as typeof fetch;

      await service.run(
        payload({ target: 'x', result_field_id: 'result-field-id' }, { depth: 2 }),
        helpers({ provider: 'x', auth: { access_token: 'x-tok' } }),
      );

      expect(recordsUpdate).toHaveBeenCalledWith(
        'ws1',
        'db1',
        'rec1',
        { post_url: 'https://x.com/i/web/status/t3' },
        'user1',
        3,
        'automation',
      );
    });

    it('never writes back when result_field_id is unset', async () => {
      const fetcher = vi.fn().mockResolvedValueOnce(fakeResponse({ json: { data: { id: 't4' } } }));
      const recordsUpdate = vi.fn();
      const { service } = newService({ recordsUpdate });
      service.fetcher = fetcher as unknown as typeof fetch;

      await service.run(payload({ target: 'x' }), helpers({ provider: 'x', auth: { access_token: 'x-tok' } }));
      expect(recordsUpdate).not.toHaveBeenCalled();
    });
  });
});
