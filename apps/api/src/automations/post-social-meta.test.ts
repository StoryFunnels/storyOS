import { describe, expect, it, vi } from 'vitest';
import { ProviderError } from '../common/provider-error';
import type { MetaAuth } from '../connections/providers/meta';
import { countHashtags, jpegSize, preflightInstagram, publishToMeta, resolveMetaPage } from './post-social-meta';
import type { MetaMedia, MetaPublishArgs } from './post-social-meta';
import type { PostSocialAction } from './post-social.action';
import { fakeJpeg } from '../../test/helpers/jpeg';

/**
 * Ticket #51 — the Meta publisher, against a SCRIPTED fake network. No real Graph API, token, page or account exists
 * here; every id and token is made up, and under NODE_ENV=test the real fetcher refuses anyway.
 */
const SECRET = 'EAAGsecretPAGEtokenXYZ';
const PERSON = 'Maya Chen';

const AUTH: Partial<MetaAuth> = {
  user_token: 'user-token-not-real',
  obtained_at: 1,
  pages: [
    { page_id: '1001', name: 'Foxglove Florist', page_token: 'page-token-1-not-real', ig_user_id: '17841400000000001', ig_username: 'foxglove' },
    { page_id: '1002', name: 'Hollow Oak Books', page_token: 'page-token-2-not-real' },
  ],
};

function action(over: Partial<PostSocialAction> = {}): PostSocialAction {
  return { type: 'post_social', connection_id: 'c1', target: 'facebook_page', account_id: '1001', text: 'Autumn is here', ...over } as PostSocialAction;
}
const media = (over: Partial<MetaMedia> = {}): MetaMedia => ({ attachmentId: 'att-1', buffer: fakeJpeg(1080, 1080), mime: 'image/jpeg', filename: 'a.jpg', ...over });

type Reply = { status: number; json?: unknown };
interface Call { url: string; method: string; headers: Record<string, string>; body: unknown }
function network(reply: (call: Call) => Reply | Error) {
  const calls: Call[] = [];
  const fetcher = (async (url: string, init?: { method?: string; headers?: Record<string, string>; body?: unknown }) => {
    const call: Call = { url: String(url), method: init?.method ?? 'GET', headers: init?.headers ?? {}, body: init?.body };
    calls.push(call);
    const r = reply(call);
    if (r instanceof Error) throw r;
    return { status: r.status, json: async () => r.json ?? {}, text: async () => '', headers: new Headers() };
  }) as unknown as typeof fetch;
  return { fetcher, calls };
}

function args(over: Partial<MetaPublishArgs> & { net: ReturnType<typeof network> }): MetaPublishArgs {
  return {
    auth: AUTH,
    action: action(),
    media: null,
    fetcher: over.net.fetcher,
    poll: { intervalMs: 0, maxAttempts: 4, sleep: vi.fn().mockResolvedValue(undefined) },
    mintImageUrl: (id) => `https://api.test/api/v1/attachments/signed/${id}?expires=1&sig=abc`,
    onReconnectRequired: vi.fn().mockResolvedValue(undefined),
    ...over,
  };
}

async function failure(p: Promise<unknown>): Promise<ProviderError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(ProviderError);
    return e as ProviderError;
  }
  throw new Error('expected the publish to fail');
}

describe('image helpers', () => {
  it('reads a JPEG size from its frame header and refuses anything that is not a JPEG', () => {
    expect(jpegSize(fakeJpeg(1080, 1350))).toEqual({ width: 1080, height: 1350 });
    expect(jpegSize(Buffer.from('not an image at all'))).toBeNull();
    expect(jpegSize(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBeNull(); // a PNG
    expect(jpegSize(fakeJpeg(1, 1).subarray(0, 12))).toBeNull(); // truncated before the frame header
  });
  it('counts hashtags as words starting with #, not a # inside a word or an anchor', () => {
    expect(countHashtags('#one two #three_3 #été')).toBe(3);
    expect(countHashtags('issue#12 and a#b')).toBe(0);
    expect(countHashtags('')).toBe(0);
  });
});

describe('Instagram pre-flight: every constraint fails BEFORE a call, with the specific reason', () => {
  const run = (a: Partial<PostSocialAction>, m: MetaMedia | null) => preflightInstagram({ text: 'hi', ...a } as PostSocialAction, m);
  const reasonOf = (a: Partial<PostSocialAction>, m: MetaMedia | null) => {
    try {
      run(a, m);
    } catch (e) {
      expect((e as ProviderError).retryable, 'a constraint violation never retries').toBe(false);
      return (e as ProviderError).message;
    }
    return null;
  };

  it('a valid square JPEG passes', () => expect(reasonOf({}, media())).toBeNull());
  it('no image at all', () => expect(reasonOf({}, null)).toMatch(/^\[media_required\] Instagram posts need an image/));
  it('a PNG', () => expect(reasonOf({}, media({ mime: 'image/png' }))).toMatch(/^\[media_unsupported\] .*JPEG/));
  it('a file labelled JPEG that is not one', () => expect(reasonOf({}, media({ buffer: Buffer.from('nope') }))).toMatch(/^\[media_unsupported\] .*not a readable JPEG/));
  it('more than 8 MB', () => {
    expect(reasonOf({}, media({ buffer: Buffer.concat([fakeJpeg(1080, 1080), Buffer.alloc(8 * 1024 * 1024)]) }))).toMatch(/8 MB/);
  });
  it('the 4:1 panorama names its own size and the allowed ratio', () => {
    expect(reasonOf({}, media({ buffer: fakeJpeg(2000, 500) }))).toMatch(/^\[media_unsupported\] The image is 2000 by 500\. Instagram needs a width-to-height ratio between 0\.8 and 1\.91/);
  });
  it('the ratio edges: 4:5 and 1.91:1 pass, just outside fails', () => {
    expect(reasonOf({}, media({ buffer: fakeJpeg(800, 1000) }))).toBeNull();
    expect(reasonOf({}, media({ buffer: fakeJpeg(1910, 1000) }))).toBeNull();
    expect(reasonOf({}, media({ buffer: fakeJpeg(799, 1000) }))).toMatch(/ratio/);
    expect(reasonOf({}, media({ buffer: fakeJpeg(1911, 1000) }))).toMatch(/ratio/);
  });
  it('caption length: 2200 passes, 2201 names the count; the link counts toward it', () => {
    expect(reasonOf({ text: 'a'.repeat(2200) }, media())).toBeNull();
    expect(reasonOf({ text: 'a'.repeat(2201) }, media())).toMatch(/^\[too_long\] .*2201 of 2200/);
    expect(reasonOf({ text: 'a'.repeat(2190), link: 'https://example.test/a-long-link' }, media())).toMatch(/too_long/);
  });
  it('hashtags: 30 pass, 31 is refused with the count', () => {
    const tags = (n: number) => Array.from({ length: n }, (_, i) => `#t${i}`).join(' ');
    expect(reasonOf({ text: tags(30) }, media())).toBeNull();
    expect(reasonOf({ text: tags(31) }, media())).toMatch(/^\[rejected\] The caption has 31 hashtags; Instagram allows 30/);
  });
});

describe('NOTHING POSTS FROM AN ACCOUNT THE CONNECTION DOES NOT HOLD', () => {
  it('a Page the connection was not granted is account_mismatch and nothing is sent', async () => {
    const net = network(() => ({ status: 200, json: { id: '1_2' } }));
    const err = await failure(publishToMeta(args({ net, action: action({ account_id: '9999' }) })));
    expect(err.message).toMatch(/^\[account_mismatch\] /);
    expect(err.retryable).toBe(false);
    expect(net.calls).toHaveLength(0);
  });
  it('an Instagram id given as a Facebook Page, and a Page id given as Instagram, are both refused', async () => {
    const net = network(() => ({ status: 200, json: { id: '1_2' } }));
    await expect(failure(publishToMeta(args({ net, action: action({ account_id: '17841400000000001' }) })))).resolves.toMatchObject({ message: expect.stringMatching(/account_mismatch/) });
    await expect(
      failure(publishToMeta(args({ net, action: action({ target: 'instagram_business', account_id: '1001' }), media: media() }))),
    ).resolves.toMatchObject({ message: expect.stringMatching(/account_mismatch/) });
    expect(net.calls).toHaveLength(0);
  });
  it('an Instagram account whose page is not on this connection is refused (another connection\'s account)', async () => {
    const net = network(() => ({ status: 200 }));
    expect(() => resolveMetaPage(AUTH, { target: 'instagram_business', account_id: '17841499999999999' })).toThrow(/account_mismatch/);
    expect(net.calls).toHaveLength(0);
  });
  it('a page without a token cannot post', () => {
    expect(() => resolveMetaPage({ pages: [{ page_id: '1001', name: 'x', page_token: '' }] }, { target: 'facebook_page', account_id: '1001' })).toThrow(/no_token/);
  });
});

describe('Facebook Page', () => {
  it('text goes to the NAMED page\'s feed with THAT page\'s token, in a header, never the URL', async () => {
    const net = network(() => ({ status: 200, json: { id: '1001_555' } }));
    const out = await publishToMeta(args({ net, action: action({ account_id: '1002', text: 'Hello', link: 'https://example.test/x' }) }));
    expect(out).toEqual({ url: 'https://www.facebook.com/1001_555', external_id: '1001_555' });
    expect(net.calls).toHaveLength(1);
    const c = net.calls[0]!;
    expect(c.url).toBe('https://graph.facebook.com/v21.0/1002/feed');
    expect(c.method).toBe('POST');
    expect(c.headers.authorization).toBe('Bearer page-token-2-not-real');
    expect(c.url).not.toContain('token');
    expect(String(c.body)).toContain('message=Hello');
    expect(String(c.body)).toContain('link=https%3A%2F%2Fexample.test%2Fx');
  });
  it('a photo uploads the bytes (nothing public, no signed URL minted)', async () => {
    const mint = vi.fn();
    const net = network(() => ({ status: 200, json: { id: '77', post_id: '1001_77' } }));
    const out = await publishToMeta(args({ net, media: media(), action: action({ link: 'https://example.test/x' }), mintImageUrl: mint }));
    expect(out.url).toBe('https://www.facebook.com/1001_77');
    const c = net.calls[0]!;
    expect(c.url).toBe('https://graph.facebook.com/v21.0/1001/photos');
    expect(c.body).toBeInstanceOf(FormData);
    const f = c.body as FormData;
    expect(f.get('source')).toBeInstanceOf(Blob);
    expect(String(f.get('caption'))).toBe('Autumn is here\n\nhttps://example.test/x');
    expect(mint).not.toHaveBeenCalled();
  });
  it('a response without a usable id is a bad_response, not a link to nowhere', async () => {
    const net = network(() => ({ status: 200, json: { id: '../../evil' } }));
    await expect(failure(publishToMeta(args({ net })))).resolves.toMatchObject({ message: expect.stringMatching(/^\[bad_response\]/) });
  });
});

describe('Instagram', () => {
  const ig = () => action({ target: 'instagram_business', account_id: '17841400000000001', text: 'Fresh stems #florist' });

  it('container -> poll until FINISHED -> publish, the image handed over by a signed URL, in that order', async () => {
    const statuses = ['IN_PROGRESS', 'IN_PROGRESS', 'FINISHED'];
    const net = network((c) => {
      if (c.url.endsWith('/17841400000000001/media')) return { status: 200, json: { id: '9001' } };
      if (c.url.includes('/9001?fields=status_code')) return { status: 200, json: { status_code: statuses.shift() } };
      if (c.url.endsWith('/17841400000000001/media_publish')) return { status: 200, json: { id: '9002' } };
      if (c.url.includes('/9002?fields=permalink')) return { status: 200, json: { permalink: 'https://www.instagram.com/p/ABC/' } };
      return { status: 500 };
    });
    const a = args({ net, action: ig(), media: media() });
    const out = await publishToMeta(a);
    expect(out).toEqual({ url: 'https://www.instagram.com/p/ABC/', external_id: '9002' });
    expect(net.calls.map((c) => c.url.replace('https://graph.facebook.com/v21.0', ''))).toEqual([
      '/17841400000000001/media',
      '/9001?fields=status_code',
      '/9001?fields=status_code',
      '/9001?fields=status_code',
      '/17841400000000001/media_publish',
      '/9002?fields=permalink',
    ]);
    const create = String(net.calls[0]!.body);
    expect(create).toContain('image_url=https%3A%2F%2Fapi.test%2Fapi%2Fv1%2Fattachments%2Fsigned%2Fatt-1');
    expect(create).toContain('caption=Fresh+stems+%23florist');
    expect(String(net.calls[4]!.body)).toBe('creation_id=9001');
    // every call used the linked PAGE's token
    for (const c of net.calls) expect(c.headers.authorization).toBe('Bearer page-token-1-not-real');
    expect(a.poll.sleep).toHaveBeenCalledTimes(2);
  });

  it('a container that ends in ERROR fails with the status only and NEVER reaches media_publish', async () => {
    const net = network((c) => {
      if (c.url.endsWith('/media')) return { status: 200, json: { id: '9001' } };
      return { status: 200, json: { status_code: 'ERROR', status: `Error: ${PERSON} ${SECRET}` } };
    });
    const err = await failure(publishToMeta(args({ net, action: ig(), media: media() })));
    expect(err.message).toMatch(/^\[rejected\] Instagram could not use the image \(status error\)\. Nothing was posted/);
    expect(err.retryable).toBe(false);
    expect(net.calls.some((c) => c.url.includes('media_publish'))).toBe(false);
    for (const leaked of [SECRET, PERSON]) expect(err.message).not.toContain(leaked);
  });

  it('a container still processing when the wait runs out is retryable and never published', async () => {
    const net = network((c) => (c.url.endsWith('/media') ? { status: 200, json: { id: '9001' } } : { status: 200, json: { status_code: 'IN_PROGRESS' } }));
    const err = await failure(publishToMeta(args({ net, action: ig(), media: media() })));
    expect(err.message).toMatch(/^\[provider_unavailable\] .*Nothing was posted/);
    expect(err.retryable).toBe(true);
    expect(net.calls.some((c) => c.url.includes('media_publish'))).toBe(false);
  });

  it('the permalink lookup failing does not fail (and so never retries) a post that is already live', async () => {
    const net = network((c) => {
      if (c.url.endsWith('/media')) return { status: 200, json: { id: '9001' } };
      if (c.url.includes('status_code')) return { status: 200, json: { status_code: 'FINISHED' } };
      if (c.url.endsWith('/media_publish')) return { status: 200, json: { id: '9002' } };
      return { status: 500 };
    });
    const out = await publishToMeta(args({ net, action: ig(), media: media() }));
    expect(out).toEqual({ url: 'https://www.instagram.com/foxglove/', external_id: '9002' });
  });

  it('no image: refused before any call', async () => {
    const net = network(() => ({ status: 200 }));
    await expect(failure(publishToMeta(args({ net, action: ig(), media: null })))).resolves.toMatchObject({ message: expect.stringMatching(/media_required/) });
    expect(net.calls).toHaveLength(0);
  });
});

describe('errors are mapped from Meta\'s numeric code only, and never carry its text', () => {
  const body = (code: number) => ({ error: { code, error_subcode: 463, message: `Token ${SECRET} for ${PERSON}`, fbtrace_id: 'trace' } });
  async function failWith(res: Reply, a: Partial<PostSocialAction> = {}, media: MetaMedia | null = null) {
    const net = network(() => res);
    const reconnect = vi.fn().mockResolvedValue(undefined);
    const err = await failure(publishToMeta(args({ net, onReconnectRequired: reconnect, action: action(a), media })));
    for (const leaked of [SECRET, PERSON, 'trace']) expect(err.message).not.toContain(leaked);
    return { err, reconnect, calls: net.calls.length };
  }

  it('190 (de-authorized / expired token): reconnect_required, not retryable, and the connection is flagged once', async () => {
    const { err, reconnect } = await failWith({ status: 400, json: body(190) });
    expect(err.message).toMatch(/^\[reconnect_required\] Meta no longer accepts this connection/);
    expect(err.retryable).toBe(false);
    expect(reconnect).toHaveBeenCalledTimes(1);
  });
  it('a 401 is the same', async () => {
    const { err, reconnect } = await failWith({ status: 401 });
    expect(err.message).toMatch(/reconnect_required/);
    expect(reconnect).toHaveBeenCalledTimes(1);
  });
  it('rate limits (429, 4, 17, 32, 613) are retryable and say so', async () => {
    for (const res of [{ status: 429 }, { status: 400, json: body(4) }, { status: 400, json: body(17) }, { status: 400, json: body(32) }, { status: 400, json: body(613) }]) {
      const { err } = await failWith(res);
      expect(err.message).toMatch(/^\[rate_limited\]/);
      expect(err.retryable).toBe(true);
    }
  });
  it('permission errors (10, 200..299) are forbidden and not retryable', async () => {
    for (const code of [10, 200, 283]) {
      const { err, reconnect } = await failWith({ status: 403, json: body(code) });
      expect(err.message).toMatch(/^\[forbidden\]/);
      expect(err.retryable).toBe(false);
      expect(reconnect).not.toHaveBeenCalled();
    }
  });
  it('a 5xx on the PUBLISHING call may already have posted: never retried by itself, one call only', async () => {
    const { err, calls } = await failWith({ status: 500, json: body(2) });
    expect(err.message).toMatch(/^\[provider_unavailable\] .*not posted twice/);
    expect(err.retryable).toBe(false);
    expect(calls).toBe(1);
  });
  it('a 5xx on the Instagram container step (nothing public yet) IS retryable', async () => {
    const net = network(() => ({ status: 503 }));
    const err = await failure(publishToMeta(args({ net, action: action({ target: 'instagram_business', account_id: '17841400000000001' }), media: media() })));
    expect(err.message).toMatch(/^\[provider_unavailable\] Meta had a temporary problem/);
    expect(err.retryable).toBe(true);
  });
  it('a dropped connection on the publishing call is a safe, non-retryable message that carries no error text', async () => {
    const net = network(() => new Error(`ECONNRESET ${SECRET}`));
    const err = await failure(publishToMeta(args({ net })));
    expect(err.message).toMatch(/^\[provider_unavailable\] Meta could not be reached/);
    expect(err.message).not.toContain(SECRET);
    expect(err.retryable).toBe(false);
  });
  it('anything else is rejected with the code and status only', async () => {
    const { err } = await failWith({ status: 400, json: body(100) });
    expect(err.message).toBe('[rejected] Meta refused the post (HTTP 400, code 100).');
    const spam = await failWith({ status: 400, json: body(368) });
    expect(spam.err.message).toMatch(/^\[rejected\] Meta blocked this post/);
  });
  it('an unreadable error body does not break the mapping', async () => {
    const net = network(() => ({ status: 400 }));
    const bad = (async () => ({ status: 400, json: async () => Promise.reject(new Error('not json')), text: async () => '', headers: new Headers() })) as unknown as typeof fetch;
    const err = await failure(publishToMeta({ ...args({ net }), fetcher: bad }));
    expect(err.message).toBe('[rejected] Meta refused the post (HTTP 400).');
  });
});
