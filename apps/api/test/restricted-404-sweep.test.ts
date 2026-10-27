import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ModulesContainer } from '@nestjs/core';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { signUpUser } from './helpers/users';
import { call, grant, joinAs, setRestricted } from './helpers/members';
import type { Person } from './helpers/members';

/**
 * ticket #1098 / ADR-0018 (b) — a restricted database is hidden COMPLETELY: to a member with no grant the answer is the SAME 404 a
 * database that does not exist gets (status AND message). `PATCH /databases/:db {restricted}` answered 403 first, which confirmed the
 * database exists. The one route in the ticket is not the finding, the CLASS is: this sweep enumerates the LIVE route table and
 * calls every route that takes a database id (or a space id) as a member with no grant on a restricted database / space, for every
 * verb, with the id swapped for one that does not exist and everything else held identical.
 *
 * Bodies: `{}` alone would be refused by validation identically for both ids and mask an order-of-checks bug (that is how the PATCH
 * one hid), so each write is also sent bodies that pass validation for the routes that gate on a body field.
 */
const METHODS: Record<number, string> = { 0: 'GET', 1: 'POST', 2: 'PUT', 3: 'DELETE', 4: 'PATCH' };
const ABSENT = '00000000-0000-4000-8000-000000000000';
const DB_PARAMS = new Set(['db']);
const SPACE_PARAMS = new Set(['space']);
/** Admin-only by role: a member is refused by role before any id is read, identically for both ids. */
const SKIP = /\/restore$/;

interface R { method: string; path: string }
let app: NestFastifyApplication;
let owner: { token: string };
let ws: string, general: string, back: string, secretDb: string, backDb: string;
let bob: Person;
const routes: R[] = [];
const BODIES: Array<Record<string, unknown>> = [{}, { restricted: true }, { restricted: false, name: 'x' }, { name: 'x', type: 'text' }, { space_id: ABSENT, position: 1 }];

beforeAll(async () => {
  app = await createTestApp();
  owner = await signUpUser(app, 'Sweep Owner');
  const adm = (m: string, u: string, p?: unknown) => call(app, owner.token, m, u, p);
  ws = (await adm('POST', '/workspaces', { name: 'Sweep WS' })).json().id;
  general = (await adm('GET', `/workspaces/${ws}/spaces`)).json()[0].id;
  back = (await adm('POST', `/workspaces/${ws}/spaces`, { name: 'Back office' })).json().id;
  secretDb = (await adm('POST', `/workspaces/${ws}/databases`, { space_id: general, name: 'Payroll' })).json().id;
  backDb = (await adm('POST', `/workspaces/${ws}/databases`, { space_id: back, name: 'Board minutes' })).json().id;
  bob = await joinAs(app, owner.token, ws, 'Sweep Bob', 'member');
  await setRestricted(app, owner.token, ws, 'database', secretDb);
  await setRestricted(app, owner.token, ws, 'space', back);
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
        if (path.startsWith('/workspaces/:ws/') && !SKIP.test(path)) routes.push({ method: METHODS[method]!, path });
      }
    }
  }
}, 240_000);
afterAll(async () => { await app.close(); });

const fill = (path: string, id: Record<string, string>) =>
  path.replace(/:([A-Za-z_]+)/g, (_m, p: string) => (p === 'ws' ? ws : id[p] ?? ABSENT));
const shape = (r: { statusCode: number; json: () => { error?: { message?: unknown; code?: unknown } } }) => {
  let j: { error?: { message?: unknown; code?: unknown } } = {};
  try { j = r.json(); } catch { /* not json */ }
  return `${r.statusCode} ${String(j.error?.code ?? '')} ${JSON.stringify(j.error?.message ?? '')}`;
};

async function sweep(param: Set<string>, realIds: string[]) {
  const mine = routes.filter((r) => [...r.path.matchAll(/:([A-Za-z_]+)/g)].some((m) => param.has(m[1]!)));
  const leaks: string[] = [];
  let calls = 0;
  for (const r of mine) {
    const pname = [...r.path.matchAll(/:([A-Za-z_]+)/g)].map((m) => m[1]!).find((p) => param.has(p))!;
    const writes = r.method !== 'GET' && r.method !== 'DELETE';
    for (const body of writes ? BODIES : [undefined]) {
      const absent = await call(app, bob.token, r.method, fill(r.path, {}), body);
      for (const real of realIds) {
        const hidden = await call(app, bob.token, r.method, fill(r.path, { [pname]: real }), body);
        calls++;
        // A per-route throttle (the button press) answers 429 once the comparisons above have used its budget: not an answer about the id.
        if (hidden.statusCode === 429 || absent.statusCode === 429) continue;
        if (shape(hidden) !== shape(absent)) leaks.push(`${r.method} ${r.path} body=${JSON.stringify(body)}\n    hidden: ${shape(hidden)}\n    absent: ${shape(absent)}`);
      }
    }
  }
  return { mine: mine.length, calls, leaks: [...new Set(leaks)] };
}

describe('#1098 a member with no grant gets, for a restricted resource, the very answer for one that does not exist', () => {
  it('sanity: bob really cannot see them, and the enumeration found the routes', async () => {
    expect((await call(app, bob.token, 'GET', `/workspaces/${ws}/databases/${secretDb}`)).statusCode).toBe(404);
    expect((await call(app, bob.token, 'GET', `/workspaces/${ws}/databases/${backDb}`)).statusCode).toBe(404);
    expect(routes.filter((r) => r.path.includes(':db')).length).toBeGreaterThan(40);
    expect(routes.filter((r) => r.path.includes(':space')).length).toBeGreaterThan(5);
  });

  it('every route with a :db, as bob, restricted DATABASE and database inside a restricted SPACE', async () => {
    const out = await sweep(DB_PARAMS, [secretDb, backDb]);
    console.log(`db sweep: ${out.mine} routes, ${out.calls} comparisons, ${out.leaks.length} leaks`);
    expect(out.leaks, out.leaks.join('\n')).toEqual([]);
  }, 600_000);

  it('every route with a :space, as bob, restricted SPACE', async () => {
    const out = await sweep(SPACE_PARAMS, [back]);
    console.log(`space sweep: ${out.mine} routes, ${out.calls} comparisons, ${out.leaks.length} leaks`);
    expect(out.leaks, out.leaks.join('\n')).toEqual([]);
  }, 600_000);

  it('the reported route: PATCH /databases/:db {restricted} is a 404 for a member with no access, 403 only for one who can see it', async () => {
    const carol = await joinAs(app, owner.token, ws, 'Sweep Carol', 'member');
    await grant(app, owner.token, ws, carol.id, { database_id: secretDb }, 'creator');
    const url = (id: string) => `/workspaces/${ws}/databases/${id}`;
    const hidden = await call(app, bob.token, 'PATCH', url(secretDb), { restricted: false });
    const absent = await call(app, bob.token, 'PATCH', url(ABSENT), { restricted: false });
    expect(hidden.statusCode, hidden.body).toBe(404);
    expect(shape(hidden)).toBe(shape(absent));
    // MUST KEEP: someone who CAN see the database (creator grant) is still told sharing is an admin decision, and nothing changed.
    const seen = await call(app, carol.token, 'PATCH', url(secretDb), { restricted: false });
    expect(seen.statusCode, seen.body).toBe(403);
    expect((await call(app, owner.token, 'GET', url(secretDb))).json().restricted).toBe(true);
    // and the admin can still flip it
    expect((await call(app, owner.token, 'PATCH', url(secretDb), { restricted: false })).statusCode).toBe(200);
    await setRestricted(app, owner.token, ws, 'database', secretDb);
  });

  it('an absent record in a database the member cannot read is "Database not found", in a readable one it is still "Record not found"', async () => {
    const open = (await call(app, owner.token, 'POST', `/workspaces/${ws}/databases`, { space_id: general, name: 'Open tasks' })).json().id;
    const urls = (d: string) => [`/workspaces/${ws}/databases/${d}/records/${ABSENT}`, `/workspaces/${ws}/databases/${d}/records/${ABSENT}/backlinks`];
    for (const [i, u] of urls(secretDb).entries()) {
      expect(shape(await call(app, bob.token, 'GET', u)), u).toBe(shape(await call(app, bob.token, 'GET', urls(ABSENT)[i]!)));
    }
    for (const u of urls(open)) expect((await call(app, bob.token, 'GET', u)).json().error.message, u).toBe('Record not found');
  });
});
