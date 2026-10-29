import 'reflect-metadata';
import { ModulesContainer } from '@nestjs/core';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { call } from './members';

/**
 * Shared by the restricted-resource sweeps (ticket #1098, ticket #1101): the LIVE route table, and the one comparison they make.
 * A route list written by hand drifts (the rule-3 lesson in CLAUDE.md), so the table is read from the controllers' own metadata.
 */
const METHODS: Record<number, string> = { 0: 'GET', 1: 'POST', 2: 'PUT', 3: 'DELETE', 4: 'PATCH' };
export const ABSENT = '00000000-0000-4000-8000-000000000000';

export interface SweepRoute { method: string; path: string; handler: string }

/** Every `/workspaces/:ws/...` route of the running app, from controller metadata. */
export function liveWorkspaceRoutes(app: NestFastifyApplication): SweepRoute[] {
  const routes: SweepRoute[] = [];
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
        if (path.startsWith('/workspaces/:ws/')) routes.push({ method: METHODS[method]!, path, handler: `${cls.name}.${name}` });
      }
    }
  }
  return routes;
}

export const paramsOf = (path: string) => [...path.matchAll(/:([A-Za-z_]+)/g)].map((m) => m[1]!);

/** `ids` fills named params; every other param (except :ws) becomes an id that does not exist. */
export const fill = (ws: string, path: string, ids: Record<string, string>) =>
  path.replace(/:([A-Za-z_]+)/g, (_m, p: string) => (p === 'ws' ? ws : ids[p] ?? ABSENT));

/** status + error code + message: what a caller can tell the two answers apart by. */
export const shape = (r: { statusCode: number; json: () => { error?: { message?: unknown; code?: unknown } } }) => {
  let j: { error?: { message?: unknown; code?: unknown } } = {};
  try { j = r.json(); } catch { /* not json */ }
  return `${r.statusCode} ${String(j.error?.code ?? '')} ${JSON.stringify(j.error?.message ?? '')}`;
};

/** Bodies that pass validation for the routes that gate on a body field; `{}` alone would be refused identically for both ids. */
export const BODIES: Array<Record<string, unknown>> = [
  {}, { restricted: true }, { restricted: false, name: 'x' }, { name: 'x', type: 'text' }, { space_id: ABSENT, position: 1 },
  { auto_link: null }, { rules: [] }, { title: 'x', confirm: true }, { target_space_id: ABSENT }, { confirm: true }, { record_id: ABSENT },
];

export interface IdSweepOptions {
  app: NestFastifyApplication;
  ws: string;
  token: string;
  /** label -> the route's params to vary; each real id is compared with ABSENT for the SAME route and body. */
  route: SweepRoute;
  param: string;
  real: string[];
  fixed?: Record<string, string>;
  /** ids for OTHER params, used on the hidden side only (the absent side keeps ABSENT): the real child ids inside the hidden resource. */
  hiddenExtra?: Record<string, string>;
  bodies?: Array<Record<string, unknown>>;
}

/** One route, one caller: the answer for each real (hidden) id must equal the answer for an id that does not exist. */
export async function compareRoute(o: IdSweepOptions): Promise<{ calls: number; leaks: string[] }> {
  const { app, ws, token, route, param, real, fixed = {}, hiddenExtra = {} } = o;
  // DELETE too: `DELETE /relations/:rel` demands `{confirm:true}`, and a body-less call is refused by validation for BOTH ids, hiding the leak
  const writes = route.method !== 'GET';
  // a few GETs demand a query param (select-drift: record_id) and are refused identically for both ids without it
  const q = route.method === 'GET' ? `?record_id=${ABSENT}` : '';
  const leaks = new Map<string, string>();
  let calls = 0;
  for (const body of writes ? o.bodies ?? BODIES : [undefined]) {
    const absent = await call(app, token, route.method, fill(ws, route.path, { ...fixed, [param]: ABSENT }) + q, body);
    for (const id of real) {
      const hidden = await call(app, token, route.method, fill(ws, route.path, { ...fixed, ...hiddenExtra, [param]: id }) + q, body);
      calls++;
      // A per-route throttle answers 429 once earlier comparisons used its budget: not an answer about the id.
      if (hidden.statusCode === 429 || absent.statusCode === 429) continue;
      if (shape(hidden) !== shape(absent)) {
        // one line per (route, pair of answers): the body is only the first one that showed it
        const k = `${route.method} ${route.path}  hidden: ${shape(hidden)}  |  absent: ${shape(absent)}`;
        if (!leaks.has(k)) leaks.set(k, `${k}  (body=${JSON.stringify(body)})`);
      }
    }
  }
  return { calls, leaks: [...leaks.values()] };
}
