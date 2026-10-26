import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ModulesContainer } from '@nestjs/core';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';

/**
 * #1064 — `DELETE /views/not-a-uuid` was a 500: the id reached a uuid column and Postgres refused the cast. A malformed id can never
 * name anything, so the answer is a 404 (the same as a well-formed id that does not exist), on EVERY route, never a 500.
 *
 * The routes are ENUMERATED from the live route table, not listed by hand, and every `:param` route is called with a malformed
 * value in each position. A search for "uuid" or "views" produced a set; the router produces the real one.
 */
const METHODS: Record<number, string> = { 0: 'GET', 1: 'POST', 2: 'PUT', 3: 'DELETE', 4: 'PATCH' };
const MALFORMED = ['not-a-uuid', '1', "'; select 1; --", '00000000-0000-0000-0000-00000000000g', '%00'];
let app: NestFastifyApplication;
let token: string;
let ws: string;
const routes: Array<{ method: string; path: string }> = [];

beforeAll(async () => {
  app = await createTestApp();
  token = (await signUpUser(app, 'Malformed Ids')).token;
  ws = (await app.inject({ method: 'POST', url: '/api/v1/workspaces', headers: authed(token), payload: { name: 'Malformed WS' } })).json().id;
  for (const m of app.get(ModulesContainer).values()) {
    for (const c of m.controllers.values()) {
      const cls = c.metatype as (new (...a: never[]) => unknown) | null;
      if (!cls) continue;
      const base: string = Reflect.getMetadata('path', cls) ?? '/';
      for (const name of Object.getOwnPropertyNames(cls.prototype)) {
        const fn = cls.prototype[name as keyof typeof cls.prototype] as unknown;
        if (typeof fn !== 'function' || name === 'constructor') continue;
        const method = Reflect.getMetadata('method', fn);
        if (method === undefined) continue;
        const sub: string = Reflect.getMetadata('path', fn) ?? '/';
        const path = `/${base}/${sub}`.replace(/\/+/g, '/').replace(/(.)\/$/, '$1');
        if (path === '/' || path.startsWith('/healthz') || path.startsWith('/api/docs') || path === '/build-info' || !path.includes(':')) continue;
        routes.push({ method: METHODS[method]!, path: `/api/v1${path}` });
      }
    }
  }
}, 120_000);
afterAll(async () => { await app.close(); });

describe('#1064 a malformed path id is a 404, never a 500, on every route', () => {
  it('sanity: the enumeration found the parameterised routes', () => expect(routes.length).toBeGreaterThan(250));

  it('no parameterised route answers 5xx for a malformed id in any path position', async () => {
    const failures: string[] = [];
    for (const r of routes) {
      const params = [...r.path.matchAll(/:([A-Za-z_]+)/g)].map((m) => m[1]!);
      for (const bad of MALFORMED) {
        // `ws` stays a REAL workspace so the request gets past the workspace gate and reaches the inner id; then every other
        // position is malformed at once, and (separately) each position alone.
        const variants: Array<Record<string, string>> = [
          Object.fromEntries(params.map((p) => [p, p === 'ws' ? ws : bad])),
          ...params.filter((p) => p !== 'ws').map((only) => Object.fromEntries(params.map((p) => [p, p === only ? bad : p === 'ws' ? ws : '00000000-0000-4000-8000-000000000000']))),
        ];
        for (const v of variants) {
          const url = r.path.replace(/:([A-Za-z_]+)/g, (_m, p: string) => encodeURIComponent(v[p]!));
          const res = await app.inject({ method: r.method as never, url, headers: authed(token), payload: r.method === 'GET' || r.method === 'DELETE' ? undefined : ({} as never) });
          // 503 is a route that is switched off by configuration (billing is not set up in tests), not a failure on the id.
          if (res.statusCode >= 500 && res.statusCode !== 503) failures.push(`${res.statusCode} ${r.method} ${r.path}  [${Object.entries(v).map(([k, x]) => `${k}=${x.slice(0, 12)}`).join(' ')}]`);
        }
      }
    }
    const unique = [...new Set(failures)];
    expect(unique, `routes that answer 5xx for a malformed id:\n${unique.join('\n')}`).toEqual([]);
  }, 600_000);
});

describe('#1064 the answers are the right ones, not just non-5xx', () => {
  const call = (method: string, url: string, payload?: unknown) => app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(token), payload: payload as never });

  it('the reported case: DELETE /views/not-a-uuid is a 404 with the standard envelope', async () => {
    const res = await call('DELETE', `/workspaces/${ws}/views/not-a-uuid`);
    expect(res.statusCode, res.body).toBe(404);
    expect(res.json().error).toMatchObject({ code: 'not_found' });
  });

  it('a malformed id answers exactly like a well-formed id that does not exist (no way to tell them apart)', async () => {
    const malformed = await call('GET', `/workspaces/${ws}/databases/not-a-uuid`);
    const absent = await call('GET', `/workspaces/${ws}/databases/00000000-0000-4000-8000-000000000000`);
    expect(malformed.statusCode).toBe(absent.statusCode);
    expect(malformed.statusCode).toBe(404);
  });

  it('a malformed id in a BODY is the caller\'s bad input (4xx), never a 500', async () => {
    const res = await call('POST', `/workspaces/${ws}/views`, { name: 'x', type: 'dashboard', space_id: 'not-a-uuid' });
    expect(res.statusCode, res.body).toBeLessThan(500);
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  });

  it('a real server fault is still a 500 (the filter only reclassifies uuid/integer cast errors)', async () => {
    const { AllExceptionsFilter } = await import('../src/common/filters/all-exceptions.filter');
    const sent: Array<{ status: number }> = [];
    const reply = { status: (s: number) => { sent.push({ status: s }); return { send: () => undefined }; }, header: () => undefined };
    const host = { switchToHttp: () => ({ getResponse: () => reply, getRequest: () => ({ id: 'r', params: { id: 'x' } }) }) } as never;
    new AllExceptionsFilter().catch(Object.assign(new Error('boom'), { code: '22P02', cause: undefined }), host);
    new AllExceptionsFilter().catch(Object.assign(new Error('invalid input value for enum membership_status: "x"'), { code: '22P02' }), host);
    expect(sent.map((x) => x.status), 'an enum error and a plain error stay 500').toEqual([500, 500]);
    new AllExceptionsFilter().catch(Object.assign(new Error('Failed query'), { cause: Object.assign(new Error('invalid input syntax for type uuid: "x"'), { code: '22P02' }) }), host);
    expect(sent[2]!.status, 'a wrapped uuid cast error is a 404 when the request has path params').toBe(404);
  });
});
