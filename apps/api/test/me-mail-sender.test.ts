import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';
import { env } from '../src/config/env';

let app: NestFastifyApplication;

describe('GET /me mail_sender (ticket #1266, for the notifications page)', () => {
  beforeAll(async () => {
    app = await createTestApp();
  });
  afterAll(async () => {
    await app.close();
  });

  it('gives any signed-in member the sender name and address, and nothing else from the mail config', async () => {
    const user = await signUpUser(app, 'MailSenderReader');
    const res = await app.inject({ method: 'GET', url: '/api/v1/me', headers: authed(user.token) });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const from = env().MAIL_FROM;
    expect(body.mail_sender).toEqual({
      name: from.replace(/\s*<.*$/, '').trim(),
      address: /<([^>]+)>/.exec(from)?.[1] ?? from,
    });
    const raw = JSON.stringify(body);
    for (const secret of ['SMTP', 'smtp_', 'RESEND', 'password']) expect(raw).not.toContain(secret);
    expect(Object.keys(body.mail_sender).sort()).toEqual(['address', 'name']);
  });

  it('is not readable without signing in', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/me' });
    expect(res.statusCode).toBe(401);
  });
});
