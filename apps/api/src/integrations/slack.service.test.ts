import { UnprocessableEntityException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { Db } from '../db/client';
import { SlackService, type SlackFetcher } from './slack.service';

/** A db stub whose only used method is `query.workspaces.findFirst`. */
function dbWithSlack(slack: Record<string, unknown> | undefined): Db {
  return {
    query: { workspaces: { findFirst: vi.fn().mockResolvedValue(slack ? { settings: { slack } } : { settings: {} }) } },
  } as unknown as Db;
}

/** Same as `dbWithSlack`, plus a spyable `update().set().where()` chain for write paths. */
function dbWithSlackAndUpdate(slack: Record<string, unknown> | undefined) {
  const set = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });
  const update = vi.fn().mockReturnValue({ set });
  const db = {
    query: { workspaces: { findFirst: vi.fn().mockResolvedValue(slack ? { settings: { slack } } : { settings: {} }) } },
    update,
  } as unknown as Db;
  return { db, set };
}

/** Captures the last request and returns a canned Slack response. */
function fetcherReturning(status: number, body: string) {
  const calls: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
  const fetcher: SlackFetcher = async (url, init) => {
    calls.push({ url, headers: init.headers, body: init.body });
    return { status, text: async () => body };
  };
  return { fetcher, calls };
}

describe('SlackService.sendMessage', () => {
  it('posts to chat.postMessage with a Bearer token and the right payload', async () => {
    const service = new SlackService(dbWithSlack({ bot_token: 'xoxb-abc', default_channel: '#general' }));
    const { fetcher, calls } = fetcherReturning(200, JSON.stringify({ ok: true }));
    service.fetcher = fetcher;

    const result = await service.sendMessage('ws1', { text: 'hello' });

    expect(result).toEqual({ ok: true, via: 'bot', channel: '#general' });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://slack.com/api/chat.postMessage');
    expect(calls[0]!.headers.authorization).toBe('Bearer xoxb-abc');
    expect(JSON.parse(calls[0]!.body)).toEqual({ channel: '#general', text: 'hello', blocks: undefined });
  });

  it('lets an explicit channel override the default', async () => {
    const service = new SlackService(dbWithSlack({ bot_token: 'xoxb-abc', default_channel: '#general' }));
    const { fetcher, calls } = fetcherReturning(200, JSON.stringify({ ok: true }));
    service.fetcher = fetcher;

    const result = await service.sendMessage('ws1', { channel: '#alerts', text: 'hi', blocks: [{ type: 'divider' }] });

    expect(result.channel).toBe('#alerts');
    expect(JSON.parse(calls[0]!.body)).toEqual({ channel: '#alerts', text: 'hi', blocks: [{ type: 'divider' }] });
  });

  it('surfaces a Slack API error (ok:false) as a 422', async () => {
    const service = new SlackService(dbWithSlack({ bot_token: 'xoxb-abc', default_channel: '#general' }));
    service.fetcher = fetcherReturning(200, JSON.stringify({ ok: false, error: 'channel_not_found' })).fetcher;

    await expect(service.sendMessage('ws1', { text: 'hi' })).rejects.toThrow(/channel_not_found/);
  });

  it('requires a channel when using a bot token with no default', async () => {
    const service = new SlackService(dbWithSlack({ bot_token: 'xoxb-abc' }));
    service.fetcher = fetcherReturning(200, JSON.stringify({ ok: true })).fetcher;

    await expect(service.sendMessage('ws1', { text: 'hi' })).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it('falls back to the incoming webhook when there is no bot token', async () => {
    const service = new SlackService(dbWithSlack({ webhook_url: 'https://hooks.slack.com/services/T/B/secret' }));
    const { fetcher, calls } = fetcherReturning(200, 'ok');
    service.fetcher = fetcher;

    const result = await service.sendMessage('ws1', { text: 'via hook' });

    expect(result).toEqual({ ok: true, via: 'webhook' });
    expect(calls[0]!.url).toBe('https://hooks.slack.com/services/T/B/secret');
    expect(JSON.parse(calls[0]!.body)).toEqual({ text: 'via hook', blocks: undefined });
  });

  it('throws when nothing is configured', async () => {
    const service = new SlackService(dbWithSlack(undefined));
    await expect(service.sendMessage('ws1', { text: 'hi' })).rejects.toThrow(/Configure a Slack bot token or webhook/);
  });
});

describe('SlackService.getConfig', () => {
  it('never returns the token or webhook — only presence flags + channel', async () => {
    const service = new SlackService(
      dbWithSlack({ bot_token: 'xoxb-abc', webhook_url: 'https://hooks.slack.com/x', default_channel: '#ops' }),
    );
    const cfg = await service.getConfig('ws1');
    expect(cfg).toEqual({ has_token: true, has_webhook: true, default_channel: '#ops' });
    expect(JSON.stringify(cfg)).not.toContain('xoxb-abc');
  });
});

describe('SlackService.disconnect (MN-249)', () => {
  it('clears the stored bot token, webhook and default channel', async () => {
    const { db, set } = dbWithSlackAndUpdate({
      bot_token: 'xoxb-abc',
      webhook_url: 'https://hooks.slack.com/x',
      default_channel: '#ops',
    });
    const service = new SlackService(db);

    const result = await service.disconnect('ws1');

    expect(result).toEqual({ has_token: false, has_webhook: false, default_channel: null });
    expect(set).toHaveBeenCalledWith({ settings: { slack: {} } });
  });
});
