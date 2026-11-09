import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { API_SECURITY_HEADERS } from '../src/app.setup';

/** Ticket #1042: every API response, success, error or better-auth's raw route, carries the security headers. */
let app: NestFastifyApplication;

beforeAll(async () => {
  app = await createTestApp();
}, 120_000);
afterAll(async () => {
  await app.close();
});

describe('#1042 API security headers', () => {
  const cases: Array<[string, string]> = [
    ['a Nest route', '/healthz'],
    ['an error response', '/api/v1/workspaces'],
    ['a 404', '/api/v1/no-such-route'],
    ["better-auth's raw route", '/api/v1/auth/get-session'],
  ];

  it.each(cases)('%s carries every header', async (_label, url) => {
    const res = await app.inject({ method: 'GET', url });
    for (const [name, value] of Object.entries(API_SECURITY_HEADERS)) {
      expect(res.headers[name], `${name} on ${url}`).toBe(value);
    }
  });

  it('nothing the API serves can be framed', () => {
    expect(API_SECURITY_HEADERS['x-frame-options']).toBe('DENY');
    expect(API_SECURITY_HEADERS['content-security-policy']).toBe("frame-ancestors 'none'");
  });
});
