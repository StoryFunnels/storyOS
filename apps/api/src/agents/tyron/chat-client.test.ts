import { describe, expect, it, vi, afterEach } from 'vitest';
import { OpenAiTyronChatClient } from './chat-client';

/**
 * Found live on production (#363's verification): a rejected API key produced
 * OpenAI's full JSON error body — including the key prefix and a link to the
 * account page — rendered verbatim in a member's chat panel.
 *
 * Two faults in one. Instance CONFIGURATION surfaced to an end user who can do
 * nothing about it, and it read like a crash rather than an explanation. The
 * operator still needs the detail, so it goes to the log.
 */
describe('a failed model call tells the user the CATEGORY, not the provider body', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  function respond(status: number, body: string) {
    globalThis.fetch = vi.fn(async () => new Response(body, { status })) as unknown as typeof fetch;
  }

  /** The exact shape that leaked, verbatim from the incident. */
  const OPENAI_401 = JSON.stringify({
    error: {
      message: 'Incorrect API key provided: sk-proj-abc123. You can find your API key at https://platform.openai.com/account/api-keys.',
      type: 'invalid_request_error',
      code: 'invalid_api_key',
    },
  });

  it('never puts the provider body, the key or the provider URL in front of the user', async () => {
    respond(401, OPENAI_401);
    const client = new OpenAiTyronChatClient('sk-proj-abc123', 'gpt-4o-mini');
    const err = await client.chat([{ role: 'user', content: 'hi' }], []).catch((e: Error) => e);

    const message = (err as Error).message;
    expect(message).not.toContain('sk-proj');
    expect(message).not.toContain('platform.openai.com');
    expect(message).not.toContain('invalid_api_key');
    expect(message).not.toContain('{');
  });

  it('says it is a configuration problem on OUR side, so nobody retries forever', async () => {
    respond(401, OPENAI_401);
    const client = new OpenAiTyronChatClient('k', 'm');
    const err = await client.chat([{ role: 'user', content: 'hi' }], []).catch((e: Error) => e);
    const message = (err as Error).message;
    expect(message).toMatch(/api key was rejected/i);
    expect(message).toMatch(/not something you did|admin/i);
  });

  it('still writes the provider detail to the log, for whoever has to fix it', async () => {
    const logged: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string) => {
      logged.push(String(chunk));
      return true;
    }) as never);
    respond(401, OPENAI_401);
    const client = new OpenAiTyronChatClient('k', 'm');
    await client.chat([{ role: 'user', content: 'hi' }], []).catch(() => undefined);

    // The operator needs exactly what the user must not see.
    expect(logged.join('')).toContain('invalid_api_key');
    expect(logged.join('')).toContain('401');
  });

  it('distinguishes a rate limit from a misconfiguration — different advice', async () => {
    respond(429, '{"error":{"message":"slow down"}}');
    const client = new OpenAiTyronChatClient('k', 'm');
    const err = await client.chat([{ role: 'user', content: 'hi' }], []).catch((e: Error) => e);
    // Retrying is the right move here, and the wrong move for a bad key.
    expect((err as Error).message).toMatch(/rate-limiting/i);
    expect((err as Error).message).toMatch(/again shortly/i);
  });

  it('treats a provider outage as retryable', async () => {
    respond(503, 'upstream boom');
    const client = new OpenAiTyronChatClient('k', 'm');
    const err = await client.chat([{ role: 'user', content: 'hi' }], []).catch((e: Error) => e);
    expect((err as Error).message).toMatch(/again shortly/i);
  });
});
