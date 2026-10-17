import 'reflect-metadata';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ModulesContainer } from '@nestjs/core';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { ACCESS_COVERAGE } from './access-coverage.registry';

/**
 * #944 / ADR-0018 — the access-coverage test. The inventory (docs/architecture/restricted-access-inventory.md) is a
 * point-in-time list; THIS is what keeps it true. Every endpoint of the running app must be declared in ACCESS_COVERAGE as
 * scoped | workspace-level | admin-only | public, and the declaration is cross-checked against the guards the route really carries.
 *
 * The route table is read from the booted app's controller metadata (the same metadata Nest routes from), never grepped.
 */
const SRC = join(import.meta.dirname, '..', 'src');
const METHODS: Record<number, string> = { 0: 'GET', 1: 'POST', 2: 'PUT', 3: 'DELETE', 4: 'PATCH' };
const MIN_ROLE_KEY = 'storyos:minRole';
const CLASSES = 'scoped | workspace-level | admin-only | public';

interface Route { key: string; controller: string; guards: string[]; minRole?: string }

let app: NestFastifyApplication;
let routes: Route[];

function controllerFile(name: string, dir = SRC): string | null {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { const hit = controllerFile(name, p); if (hit) return hit; }
    else if (e.name.endsWith('.ts') && !e.name.endsWith('.test.ts') && new RegExp(`export class ${name}\\b`).test(readFileSync(p, 'utf8'))) return p;
  }
  return null;
}

function moduleSource(file: string): string {
  const dir = dirname(file);
  return readdirSync(dir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts')).map((f) => readFileSync(join(dir, f), 'utf8')).join('\n');
}

beforeAll(async () => {
  app = await createTestApp();
  routes = [];
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
        let path = `/${base}/${sub}`.replace(/\/+/g, '/').replace(/(.)\/$/, '$1');
        // app.setup.ts: global prefix 'api/v1', excluding these
        const excluded = path === '/' || path === '/build-info' || path.startsWith('/healthz') || path.startsWith('/api/docs');
        if (!excluded) path = `/api/v1${path}`;
        const guards = [...(Reflect.getMetadata('__guards__', cls) ?? []), ...(Reflect.getMetadata('__guards__', fn) ?? [])].map((g: { name: string }) => g.name);
        routes.push({ key: `${METHODS[method]} ${path}`, controller: cls.name, guards, minRole: Reflect.getMetadata(MIN_ROLE_KEY, fn) ?? Reflect.getMetadata(MIN_ROLE_KEY, cls) });
      }
    }
  }
}, 120_000);
afterAll(async () => { await app.close(); });

describe('#944 access coverage — every endpoint declares who may see what it returns', () => {
  it('reads a real route table (sanity: not an empty or tiny enumeration)', () => {
    expect(routes.length).toBeGreaterThan(300);
    expect(new Set(routes.map((r) => r.key)).size, 'duplicate route keys').toBe(routes.length);
  });

  it('fails for an endpoint nobody classified, naming it and the four classes', () => {
    const missing = routes.filter((r) => !(r.key in ACCESS_COVERAGE)).map((r) => `${r.key}  (${r.controller})`);
    expect(missing, `Unclassified endpoint(s). Add each to test/access-coverage.registry.ts as ${CLASSES} — decide who may see what it returns:\n${missing.join('\n')}`).toEqual([]);
  });

  it('fails for a registry row whose endpoint no longer exists (no dead rules)', () => {
    const live = new Set(routes.map((r) => r.key));
    const dead = Object.keys(ACCESS_COVERAGE).filter((k) => !live.has(k));
    expect(dead, `Registry row(s) with no endpoint — delete them:\n${dead.join('\n')}`).toEqual([]);
  });

  it('every row carries its evidence: a reason, or a named check that still exists in its module', () => {
    const bad: string[] = [];
    for (const [key, cls] of Object.entries(ACCESS_COVERAGE)) {
      if (cls.kind === 'workspace-level' || cls.kind === 'public') {
        if (cls.reason.trim().length < 15) bad.push(`${key}: ${cls.kind} needs a one-line reason`);
      } else if (cls.kind === 'scoped') {
        const src = moduleSource(join(SRC, cls.file));
        for (const check of cls.check.split(' + ')) if (!new RegExp(`\\b${check}\\b`).test(src)) bad.push(`${key}: scoped by '${check}', which no longer appears in ${dirname(cls.file)}/`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('classes agree with the guards the route really has', () => {
    const bad: string[] = [];
    for (const r of routes) {
      const cls = ACCESS_COVERAGE[r.key];
      if (!cls) continue;
      const hasAuth = r.guards.includes('AuthGuard');
      const platformAdmin = r.guards.includes('PlatformAdminGuard');
      if (cls.kind === 'public' && hasAuth) bad.push(`${r.key}: declared public but carries AuthGuard`);
      if (!hasAuth && cls.kind !== 'public') bad.push(`${r.key}: has no AuthGuard so it must be declared public, not ${cls.kind}`);
      if (cls.kind === 'admin-only' && r.minRole !== 'admin' && !platformAdmin) bad.push(`${r.key}: declared admin-only but has neither @MinRole('admin') nor PlatformAdminGuard`);
      if (r.minRole === 'admin' && cls.kind !== 'admin-only') bad.push(`${r.key}: carries @MinRole('admin') so it must be declared admin-only, not ${cls.kind}`);
      if (platformAdmin && cls.kind !== 'admin-only') bad.push(`${r.key}: behind PlatformAdminGuard so it must be declared admin-only`);
      if (cls.kind === 'scoped' && !r.guards.includes('WorkspaceAccessGuard') && r.guards.includes('AuthGuard')) bad.push(`${r.key}: scoped content without WorkspaceAccessGuard resolving the membership`);
      const file = controllerFile(r.controller);
      if (cls.kind === 'scoped' && file && !cls.file.startsWith(dirname(file).replace(`${SRC}/`, ''))) bad.push(`${r.key}: scoped row points at ${cls.file}, not the ${r.controller} module`);
    }
    expect(bad).toEqual([]);
  });
});
