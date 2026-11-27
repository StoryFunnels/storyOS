import { beforeEach, describe, expect, it, vi } from 'vitest';

const guardedFetch = vi.fn();
vi.mock('../common/net-guard', () => ({ guardedFetch: (...args: unknown[]) => guardedFetch(...args) }));

import { callSlack, defaultSlackApiFetcher } from './slack-api';
import type { SlackApiFetcher } from './slack-api';

beforeEach(() => guardedFetch.mockReset());

describe('defaultSlackApiFetcher (ticket #1379: only Slack\'s own API host, ever)', () => {
  it('posts to slack.com/api/<method> through the guarded transport, with the token only in the Authorization header, and follows no redirect', async () => {
    guardedFetch.mockResolvedValue({ status: 200, text: '{"ok":true}' });
    const out = await defaultSlackApiFetcher('chat.unfurl', 'xoxb-secret-token', { channel: 'C1', ts: '1.1', unfurls: {} });
    expect(out).toEqual({ status: 200, text: '{"ok":true}' });

    const [fetcherArg, url, init, opts] = guardedFetch.mock.calls[0]! as [unknown, string, { method: string; headers: Record<string, string>; body: string }, { followRedirects: boolean }];
    expect(fetcherArg).toBeUndefined(); // the address-pinned transport, never a caller-supplied fetch
    expect(url).toBe('https://slack.com/api/chat.unfurl');
    expect(init.method).toBe('POST');
    expect(init.headers.authorization).toBe('Bearer xoxb-secret-token');
    expect(init.body).not.toContain('xoxb-secret-token');
    expect(opts.followRedirects).toBe(false);
  });

  it('the URL is built from the closed method union and a constant: no input of an event or a link can change the host', async () => {
    guardedFetch.mockResolvedValue({ status: 200, text: '{"ok":true}' });
    await defaultSlackApiFetcher('auth.test', 't', {});
    // A method outside the union is a compile error, and the one a caller could smuggle in at runtime still lands under the constant base.
    await defaultSlackApiFetcher('@evil.example.net/x' as never, 't', {});
    await defaultSlackApiFetcher('../../evil.example.net/x' as never, 't', {});
    const urls = guardedFetch.mock.calls.map((c) => c[1] as string);
    expect(urls[0]).toBe('https://slack.com/api/auth.test');
    for (const u of urls) expect(new URL(u).hostname).toBe('slack.com');
  });
});

describe('callSlack never throws and never repeats a response body or a token', () => {
  const answer = (status: number, text: string): SlackApiFetcher => async () => ({ status, text });

  it('passes a success through', async () => {
    expect(await callSlack(answer(200, '{"ok":true,"team_id":"T1"}'), 'auth.test', 't', {})).toEqual({ ok: true, data: { ok: true, team_id: 'T1' } });
  });

  it('turns Slack\'s own error code into the result, and anything that is not such a code into a status code', async () => {
    expect(await callSlack(answer(200, '{"ok":false,"error":"cannot_unfurl_url"}'), 'chat.unfurl', 't', {})).toEqual({ ok: false, error: 'cannot_unfurl_url' });
    const free = await callSlack(answer(200, '{"ok":false,"error":"Bearer xoxb-leaked free text!"}'), 'chat.unfurl', 't', {});
    expect(free).toEqual({ ok: false, error: 'http_200' });
  });

  it('handles an unreachable Slack, a non-JSON body and a non-object body', async () => {
    expect(await callSlack(async () => { throw new Error('connect ECONNREFUSED xoxb-in-the-message'); }, 'auth.test', 't', {})).toEqual({ ok: false, error: 'unreachable' });
    expect(await callSlack(answer(200, '<html>nope</html>'), 'auth.test', 't', {})).toEqual({ ok: false, error: 'bad_response' });
    expect(await callSlack(answer(502, '<html>bad gateway</html>'), 'auth.test', 't', {})).toEqual({ ok: false, error: 'http_502' });
    expect(await callSlack(answer(200, '42'), 'auth.test', 't', {})).toEqual({ ok: false, error: 'bad_response' });
    expect(await callSlack(answer(200, 'null'), 'auth.test', 't', {})).toEqual({ ok: false, error: 'bad_response' });
  });
});
