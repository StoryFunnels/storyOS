import { describe, expect, it } from 'vitest';
import { LogMailDriver, ResendMailDriver } from './mail-driver';
import type { ResendFetcher } from './mail-driver';

describe('ResendMailDriver (MN-103)', () => {
  it('posts to the Resend API with the bearer key and message fields', async () => {
    const calls: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
    const fetcher: ResendFetcher = async (url, init) => {
      calls.push({ url, headers: init.headers, body: init.body });
      return { status: 200, text: async () => '{"id":"email_1"}' };
    };
    const driver = new ResendMailDriver('re_test_key', 'StoryOS <noreply@storyos.dev>');
    driver.fetcher = fetcher;

    await driver.send({ to: 'a@b.com', subject: 'Hi', html: '<p>hi</p>', text: 'hi' });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://api.resend.com/emails');
    expect(calls[0]!.headers.authorization).toBe('Bearer re_test_key');
    expect(JSON.parse(calls[0]!.body)).toEqual({
      from: 'StoryOS <noreply@storyos.dev>',
      to: ['a@b.com'],
      subject: 'Hi',
      html: '<p>hi</p>',
      text: 'hi',
    });
  });

  it('throws on a non-2xx response so the caller (EmailService) can log the failure', async () => {
    const fetcher: ResendFetcher = async () => ({
      status: 401,
      text: async () => 'invalid API key',
    });
    const driver = new ResendMailDriver('bad_key', 'StoryOS <noreply@storyos.dev>');
    driver.fetcher = fetcher;

    await expect(
      driver.send({ to: 'a@b.com', subject: 'Hi', html: '<p>hi</p>', text: 'hi' }),
    ).rejects.toThrow(/HTTP 401/);
  });
});

describe('LogMailDriver (MN-103)', () => {
  it('logs instead of sending — never throws — when no provider is configured', async () => {
    const logged: string[] = [];
    const driver = new LogMailDriver((message) => logged.push(message));

    await driver.send({ to: 'a@b.com', subject: 'Hi', html: '<p>hi</p>', text: 'hi there' });

    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain('a@b.com');
    expect(logged[0]).toContain('hi there');
  });
});
