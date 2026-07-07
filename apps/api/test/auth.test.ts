import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';

let app: NestFastifyApplication;

beforeAll(async () => {
  app = await createTestApp();
});

afterAll(async () => {
  await app.close();
});

const EMAIL = 'olena@jcm.agency';
const PASSWORD = 'correct-horse-battery';

describe('auth (MN-006)', () => {
  let bearerToken: string;

  it('signs up with email/password and returns a session', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-up/email',
      payload: { email: EMAIL, password: PASSWORD, name: 'Olena' },
    });
    expect(res.statusCode).toBe(200);
    const token = res.headers['set-auth-token'];
    expect(token).toBeTruthy();
    bearerToken = String(token);
  });

  it('GET /me works with the bearer session token', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: { authorization: `Bearer ${bearerToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.email).toBe(EMAIL);
    expect(body.name).toBe('Olena');
  });

  it('GET /me without credentials → 401 envelope', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/me' });
    expect(res.statusCode).toBe(401);
    const body = res.json();
    expect(body.error.code).toBe('unauthorized');
    expect(body.error.request_id).toBeTruthy();
  });

  it('rejects a wrong password on sign-in', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-in/email',
      payload: { email: EMAIL, password: 'wrong-password' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('sign-out revokes the session immediately', async () => {
    const signIn = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-in/email',
      payload: { email: EMAIL, password: PASSWORD },
    });
    expect(signIn.statusCode).toBe(200);
    const token = String(signIn.headers['set-auth-token']);

    const out = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-out',
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    });
    expect(out.statusCode).toBe(200);

    const me = await app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(me.statusCode).toBe(401);
  });

  it('lists enabled providers (google absent without env credentials)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/auth/providers' });
    expect(res.statusCode).toBe(200);
    expect(res.json().providers).toEqual(['email']);
  });
});
