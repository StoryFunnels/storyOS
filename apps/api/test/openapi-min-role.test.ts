import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ModulesContainer } from '@nestjs/core';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { buildOpenApiDocument } from '../src/openapi.setup';
import { MIN_ROLE_KEY } from '../src/workspaces/workspace-access.guard';

/**
 * #1081 — the spec says which workspace role a route needs (`x-min-role`), derived from the same `@MinRole` the guard enforces, so the
 * MCP can list only the tools a person's role can use. The enumeration is the route table, not a search.
 */
const VERBS: Record<number, string> = { 0: 'get', 1: 'post', 2: 'put', 3: 'delete', 4: 'patch' };
let app: NestFastifyApplication;
let doc: ReturnType<typeof buildOpenApiDocument>;

beforeAll(async () => {
  app = await createTestApp();
  doc = buildOpenApiDocument(app);
}, 120_000);
afterAll(async () => { await app.close(); });

describe('#1081 x-min-role in the OpenAPI document', () => {
  it('EVERY route with a @MinRole carries exactly that role in the spec, and no route carries one it does not have', () => {
    const expected = new Map<string, string>();
    for (const m of app.get(ModulesContainer).values()) {
      for (const c of m.controllers.values()) {
        const cls = c.metatype as (new (...a: never[]) => unknown) | null;
        if (!cls) continue;
        const base: string = Reflect.getMetadata('path', cls) ?? '/';
        for (const name of Object.getOwnPropertyNames(cls.prototype)) {
          const fn = cls.prototype[name as keyof typeof cls.prototype] as unknown;
          if (typeof fn !== 'function' || name === 'constructor') continue;
          const verb = VERBS[Reflect.getMetadata('method', fn) as number];
          if (!verb) continue;
          const role = (Reflect.getMetadata(MIN_ROLE_KEY, fn) ?? Reflect.getMetadata(MIN_ROLE_KEY, cls)) as string | undefined;
          const sub: string = Reflect.getMetadata('path', fn) ?? '/';
          const path = `/api/v1/${base}/${sub}`.replace(/\/+/g, '/').replace(/(.)\/$/, '$1').replace(/:([A-Za-z_]+)/g, '{$1}');
          if (role === 'member' || role === 'admin') expected.set(`${verb} ${path}`, role);
        }
      }
    }
    expect(expected.size, 'the enumeration found the role-gated routes').toBeGreaterThan(80);
    const actual = new Map<string, string>();
    for (const [path, item] of Object.entries(doc.paths)) {
      for (const [verb, op] of Object.entries(item as Record<string, Record<string, unknown>>)) {
        if (op?.['x-min-role']) actual.set(`${verb} ${path}`, String(op['x-min-role']));
      }
    }
    const missing = [...expected].filter(([k, v]) => actual.get(k) !== v).map(([k, v]) => `${k} (${v})`);
    const extra = [...actual].filter(([k]) => !expected.has(k)).map(([k]) => k);
    expect({ missing, extra }).toEqual({ missing: [], extra: [] });
  });

  it('spot checks: the audit log is admin, creating a database is member, listing workspaces has none', () => {
    const op = (path: string, verb: string) => (doc.paths[path] as Record<string, Record<string, unknown>>)?.[verb];
    expect(op('/api/v1/workspaces/{ws}/audit-log', 'get')?.['x-min-role']).toBe('admin');
    expect(op('/api/v1/workspaces/{ws}/databases', 'post')?.['x-min-role']).toBe('member');
    expect(op('/api/v1/workspaces', 'get')?.['x-min-role']).toBeUndefined();
  });
});
