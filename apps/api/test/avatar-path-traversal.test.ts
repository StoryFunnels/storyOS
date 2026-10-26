import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';
import { getStorage } from '../src/attachments/storage';

/**
 * #1076 — `GET /users/:id/avatar` built the storage key as `avatars/${id}`, and the router decodes `%2F`, so any
 * signed-in user could read any object in attachment storage (another tenant's files) with `..%2F<key>`.
 */
let app: NestFastifyApplication;
let user: { token: string };
let userId: string;
const SECRET = Buffer.from('another tenant attachment 1076');
const SECRET_KEY = `traversal-1076-${Date.now()}/secret.bin`;
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

beforeAll(async () => {
  app = await createTestApp();
  user = await signUpUser(app, 'Avatar Reader');
  userId = (await app.inject({ method: 'GET', url: '/api/v1/me', headers: authed(user.token) })).json().id;
  await getStorage().put(SECRET_KEY, SECRET, 'application/octet-stream');
}, 120_000);
afterAll(async () => {
  await getStorage().delete(SECRET_KEY).catch(() => undefined);
  await app.close();
});

const avatar = (id: string) =>
  app.inject({ method: 'GET', url: `/api/v1/users/${id}/avatar`, headers: authed(user.token) });

describe('#1076 avatar ids cannot leave avatars/', () => {
  it.each([
    ['an encoded ../ walk', `..%2F${SECRET_KEY.replace('/', '%2F')}`],
    ['a double walk', `..%2F..%2F${SECRET_KEY.replace('/', '%2F')}`],
    ['a backslash walk', `..%5C${SECRET_KEY.replace('/', '%5C')}`],
  ])('404s %s and never returns the object', async (_n, id) => {
    const res = await avatar(id);
    expect(res.statusCode).toBe(404);
    expect(res.rawPayload.includes(SECRET)).toBe(false);
  });

  it('still serves a real avatar by user id (what the filter must KEEP)', async () => {
    await getStorage().put(`avatars/${userId}`, PNG, 'image/png');
    const res = await avatar(userId);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
  });
});
