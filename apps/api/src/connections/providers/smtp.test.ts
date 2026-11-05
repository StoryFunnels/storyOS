import { UnprocessableEntityException } from '@nestjs/common';
import { afterEach, describe, expect, it } from 'vitest';
import { smtpProvider, smtpTarget, SmtpTargetRefused } from './smtp';

describe('smtpProvider.healthCheck', () => {
  const originalBuild = smtpProvider.buildTransport;
  afterEach(() => {
    smtpProvider.buildTransport = originalBuild;
  });

  function fakeTransport(verify: () => Promise<void>) {
    return () => ({
      verify,
      close: () => undefined,
    }) as unknown as ReturnType<typeof originalBuild>;
  }

  it('rejects a missing host/port/from_address without building a transport', async () => {
    let built = false;
    smtpProvider.buildTransport = (() => {
      built = true;
      return fakeTransport(async () => undefined)();
    }) as typeof originalBuild;
    await expect(smtpProvider.healthCheck({})).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(built).toBe(false);
  });

  // A public IP literal: the transport is faked, so nothing connects, and no test depends on DNS.
  it('accepts a config that verifies', async () => {
    smtpProvider.buildTransport = fakeTransport(async () => undefined);
    await expect(
      smtpProvider.healthCheck({ host: '8.8.8.8', port: 587, from_address: 'a@example.com' }),
    ).resolves.toBeUndefined();
  });

  it('rejects when transporter.verify() throws, with a generic message (never the library error)', async () => {
    smtpProvider.buildTransport = fakeTransport(async () => {
      throw new Error('Invalid greeting from server: "220 internal-banner ESMTP"');
    });
    const err = await smtpProvider.healthCheck({ host: '8.8.8.8', port: 587, from_address: 'a@example.com' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnprocessableEntityException);
    expect((err as Error).message).toBe('SMTP check failed: could not connect to the mail server with these settings');
  });

  it('says so when the server rejects the credentials (an SMTP answer, nothing about the network)', async () => {
    smtpProvider.buildTransport = fakeTransport(async () => {
      throw Object.assign(new Error('535 5.7.8 auth failed'), { code: 'EAUTH' });
    });
    await expect(smtpProvider.healthCheck({ host: '8.8.8.8', port: 465, from_address: 'a@example.com' })).rejects.toThrow(
      'the mail server rejected the username or password',
    );
  });

  it('#1044: refuses a private, loopback, metadata or Docker-service host and a non-SMTP port, before building a transport', async () => {
    let built = 0;
    smtpProvider.buildTransport = (() => {
      built++;
      return fakeTransport(async () => undefined)();
    }) as typeof originalBuild;
    for (const host of ['10.0.0.5', '127.0.0.1', '169.254.169.254', '::1', 'localhost']) {
      await expect(smtpProvider.healthCheck({ host, port: 587, from_address: 'a@example.com' })).rejects.toThrow(
        'SMTP host must be a public mail server',
      );
    }
    for (const port of [5432, 6379, 22, 80]) {
      await expect(smtpProvider.healthCheck({ host: '8.8.8.8', port, from_address: 'a@example.com' })).rejects.toThrow(
        'SMTP port must be one of 25, 465, 587, 2525',
      );
    }
    expect(built).toBe(0);
  });
});

describe('smtpTarget (#1044)', () => {
  const saved = process.env.SMTP_ALLOW_PRIVATE_CIDRS;
  afterEach(() => {
    if (saved === undefined) delete process.env.SMTP_ALLOW_PRIVATE_CIDRS;
    else process.env.SMTP_ALLOW_PRIVATE_CIDRS = saved;
  });

  it('pins the connection to the checked address; an IP literal needs no servername', async () => {
    expect(await smtpTarget('8.8.8.8', 587)).toEqual({ host: '8.8.8.8', port: 587 });
  });

  it('a name is connected by the address it resolved to, with TLS verified against the name', async () => {
    process.env.SMTP_ALLOW_PRIVATE_CIDRS = '127.0.0.0/8, ::1/128'; // localhost answers both
    const t = await smtpTarget('localhost', 25);
    expect(['127.0.0.1', '::1']).toContain(t.host);
    expect(t.servername).toBe('localhost');
  });

  it("SMTP_ALLOW_PRIVATE_CIDRS lets a self-host reach its own relay, never the metadata address", async () => {
    process.env.SMTP_ALLOW_PRIVATE_CIDRS = '10.0.0.0/8, 169.254.0.0/16';
    expect(await smtpTarget('10.1.2.3', 587)).toEqual({ host: '10.1.2.3', port: 587 });
    await expect(smtpTarget('169.254.169.254', 587)).rejects.toBeInstanceOf(SmtpTargetRefused);
  });
});

describe('smtpProvider.resolveScopes', () => {
  it('returns a from: scope from the configured from_address', async () => {
    const scopes = await smtpProvider.resolveScopes!({
      host: 'smtp.example.com',
      port: 587,
      from_address: 'a@example.com',
    });
    expect(scopes).toEqual(['from:a@example.com']);
  });

  it('returns [] when from_address is absent', async () => {
    const scopes = await smtpProvider.resolveScopes!({ host: 'smtp.example.com', port: 587 });
    expect(scopes).toEqual([]);
  });
});
