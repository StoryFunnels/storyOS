import { UnprocessableEntityException } from '@nestjs/common';
import { afterEach, describe, expect, it } from 'vitest';
import { smtpProvider } from './smtp';

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

  it('accepts a config that verifies', async () => {
    smtpProvider.buildTransport = fakeTransport(async () => undefined);
    await expect(
      smtpProvider.healthCheck({ host: 'smtp.example.com', port: 587, from_address: 'a@example.com' }),
    ).resolves.toBeUndefined();
  });

  it('rejects when transporter.verify() throws', async () => {
    smtpProvider.buildTransport = fakeTransport(async () => {
      throw new Error('auth failed');
    });
    await expect(
      smtpProvider.healthCheck({ host: 'smtp.example.com', port: 587, from_address: 'a@example.com' }),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
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
