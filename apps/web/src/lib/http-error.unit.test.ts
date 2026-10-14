import { afterEach, describe, expect, it, vi } from 'vitest';
import { createStoryOSClient } from '@storyos/sdk';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ViewQueryError, queryErrorMessage } from '@/components/views/query-error';
import { UPSTREAM_UNAVAILABLE_MESSAGE, looksLikeMarkup, withSafeErrors } from './http-error';

/**
 * Ticket #921 — driven through the REAL SDK client with a stubbed `fetch`, and asserted on what the
 * error state renders to, not on how the helper is written. The 502 body is Cloudflare's actual
 * page shape (`<!DOCTYPE html> … cf-wrapper …`).
 */
const CLOUDFLARE_502 =
  '<!DOCTYPE html><html lang="en-US"><head><title>502: Bad gateway</title></head><body><div id="cf-wrapper"><h1>Bad gateway</h1><p>Error code 502</p></div></body></html>';

function client(respond: () => Response) {
  return createStoryOSClient({ baseUrl: 'http://api.test', fetch: withSafeErrors(async () => respond()) });
}
const query = (c: ReturnType<typeof client>) =>
  c.POST('/api/v1/workspaces/{ws}/databases/{db}/records/query', {
    params: { path: { ws: 'w', db: 'd' } },
    body: { limit: 10 } as never,
  });

describe('a proxy error page never reaches the screen (#921)', () => {
  for (const status of [502, 503, 504]) {
    it(`${status} with an HTML body renders the restart message, no markup, and a retry`, async () => {
      const { error } = await query(client(() => new Response(CLOUDFLARE_502, { status, headers: { 'content-type': 'text/html; charset=UTF-8' } })));
      expect(queryErrorMessage(error)).toBe(UPSTREAM_UNAVAILABLE_MESSAGE);
      const html = renderToStaticMarkup(createElement(ViewQueryError, { error, onRetry: () => undefined }));
      expect(html).toContain('StoryOS is restarting or unreachable');
      expect(html).toContain('Try again');
      expect(html).not.toMatch(/DOCTYPE|cf-wrapper|Bad gateway|Error code/i);
    });
  }

  it('an HTML body with no content-type, or a plain-text body, is not shown either', async () => {
    for (const init of [{ status: 502 }, { status: 502, headers: { 'content-type': 'text/plain' } }]) {
      const { error } = await query(client(() => new Response('upstream connect error or disconnect/reset before headers', init)));
      expect(queryErrorMessage(error)).toBe(UPSTREAM_UNAVAILABLE_MESSAGE);
    }
  });

  it('a non-502 non-JSON failure gets a fixed sentence naming the status, not the body', async () => {
    const { error } = await query(client(() => new Response('<html>nginx 404</html>', { status: 404, headers: { 'content-type': 'text/html' } })));
    const message = queryErrorMessage(error);
    expect(message).toContain('(404)');
    expect(message).not.toMatch(/nginx|<html/);
  });

  it("StoryOS's own JSON error still shows its message, as before", async () => {
    const body = JSON.stringify({ error: { code: 'validation_failed', message: 'op "has_none" on "status" expects a non-empty array of ids' } });
    for (const status of [422, 503]) {
      const { error } = await query(client(() => new Response(body, { status, headers: { 'content-type': 'application/json' } })));
      expect(queryErrorMessage(error)).toBe('op "has_none" on "status" expects a non-empty array of ids');
    }
  });

  it('a successful response passes through untouched', async () => {
    const { data, error } = await query(client(() => new Response(JSON.stringify({ data: [], next_cursor: null }), { status: 200, headers: { 'content-type': 'application/json' } })));
    expect(error).toBeUndefined();
    expect(data).toEqual({ data: [], next_cursor: null });
  });

  it('even a path that bypasses the client cannot print markup: the error state drops it', () => {
    expect(queryErrorMessage(CLOUDFLARE_502)).toBeNull();
    expect(queryErrorMessage({ message: CLOUDFLARE_502 })).toBeNull();
    const html = renderToStaticMarkup(createElement(ViewQueryError, { error: CLOUDFLARE_502 }));
    expect(html).not.toMatch(/DOCTYPE|cf-wrapper/i);
    expect(looksLikeMarkup('Your filter was rejected: status < 3 is not valid')).toBe(false);
  });
});

describe('the app\'s own exported client is the safe one (#921)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('a 502 HTML page through `api` yields the restart message', async () => {
    vi.stubGlobal('fetch', async () => new Response(CLOUDFLARE_502, { status: 502, headers: { 'content-type': 'text/html' } }));
    const { api } = await import('./api');
    const { error } = await api.POST('/api/v1/workspaces/{ws}/databases/{db}/records/query', {
      params: { path: { ws: 'w', db: 'd' } },
      body: { limit: 10 } as never,
    });
    expect(queryErrorMessage(error)).toBe(UPSTREAM_UNAVAILABLE_MESSAGE);
  });
});
