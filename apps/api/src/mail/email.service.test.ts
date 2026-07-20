import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../config/env';

vi.mock('../config/env', () => ({ env: vi.fn() }));

import { env } from '../config/env';
import { EmailService } from './email.service';
import { LogMailDriver, ResendMailDriver, SmtpMailDriver } from './mail-driver';
import type { MailDriver, MailMessage } from './mail-driver';

const mockEnv = vi.mocked(env);

function envWith(overrides: Partial<Env>): Env {
  return {
    MAIL_FROM: 'StoryOS <noreply@storyos.dev>',
    SMTP_PORT: 1025,
    ...overrides,
  } as Env;
}

describe('EmailService — driver selection (MN-103)', () => {
  beforeEach(() => {
    mockEnv.mockReset();
  });

  it('prefers the Resend HTTP driver when RESEND_API_KEY is set', () => {
    mockEnv.mockReturnValue(envWith({ RESEND_API_KEY: 're_test_key' }));
    const service = new EmailService();
    void service.send({ kind: 'invite', to: 'a@b.com', role: 'member', acceptUrl: 'https://x/y' });
    expect(service.driver).toBeInstanceOf(ResendMailDriver);
  });

  it('falls back to the existing SMTP transport when RESEND_API_KEY is unset', () => {
    mockEnv.mockReturnValue(envWith({ SMTP_HOST: 'localhost' }));
    const service = new EmailService();
    void service.send({ kind: 'invite', to: 'a@b.com', role: 'member', acceptUrl: 'https://x/y' });
    expect(service.driver).toBeInstanceOf(SmtpMailDriver);
  });

  it('falls back to logging — never crashes — with neither configured (dev default)', () => {
    mockEnv.mockReturnValue(envWith({}));
    const service = new EmailService();
    void service.send({ kind: 'invite', to: 'a@b.com', role: 'member', acceptUrl: 'https://x/y' });
    expect(service.driver).toBeInstanceOf(LogMailDriver);
  });

  it('picks Resend over SMTP when both are configured', () => {
    mockEnv.mockReturnValue(envWith({ RESEND_API_KEY: 're_test_key', SMTP_HOST: 'localhost' }));
    const service = new EmailService();
    void service.send({ kind: 'invite', to: 'a@b.com', role: 'member', acceptUrl: 'https://x/y' });
    expect(service.driver).toBeInstanceOf(ResendMailDriver);
  });
});

describe('EmailService.send (MN-103)', () => {
  beforeEach(() => {
    mockEnv.mockReset();
    mockEnv.mockReturnValue(envWith({}));
  });

  it('does not block on the driver — resolves before the network call settles', async () => {
    let releaseDriver: (() => void) | undefined;
    const stalledDriver: MailDriver = {
      name: 'stalled',
      send: () =>
        new Promise((resolve) => {
          releaseDriver = resolve;
        }),
    };
    const service = new EmailService();
    service.driver = stalledDriver;

    const started = Date.now();
    await service.send({ kind: 'invite', to: 'a@b.com', role: 'member', acceptUrl: 'https://x/y' });
    expect(Date.now() - started).toBeLessThan(50); // send() itself never awaited the stalled driver

    releaseDriver?.(); // avoid an unresolved-promise leak between tests
  });

  it('renders the template and hands the exact message to the driver', async () => {
    const calls: MailMessage[] = [];
    const driver: MailDriver = {
      name: 'capture',
      send: async (message) => {
        calls.push(message);
      },
    };
    const service = new EmailService();
    service.driver = driver;

    await service.send({ kind: 'invite', to: 'new@example.com', role: 'admin', acceptUrl: 'https://x/invite' });
    // fire-and-forget: give the microtask queue a turn so the (already-started) send lands
    await Promise.resolve();

    expect(calls).toHaveLength(1);
    expect(calls[0]!.to).toBe('new@example.com');
    expect(calls[0]!.subject).toMatch(/invited to StoryOS/i);
    expect(calls[0]!.text).toContain('https://x/invite');
  });

  it('catches and logs a driver failure — never throws to the caller', async () => {
    const failingDriver: MailDriver = {
      name: 'failing',
      send: async () => {
        throw new Error('Resend API error: HTTP 401 — invalid key');
      },
    };
    const service = new EmailService();
    service.driver = failingDriver;

    await expect(
      service.send({ kind: 'invite', to: 'a@b.com', role: 'member', acceptUrl: 'https://x/y' }),
    ).resolves.toBeUndefined();
    await Promise.resolve(); // let the rejected promise's .catch() run before the test ends
  });
});
