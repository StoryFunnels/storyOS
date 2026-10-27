import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { signUpUser } from './helpers/users';
import { call, joinAs } from './helpers/members';
import { ABSENT, compareRoute, liveWorkspaceRoutes, paramsOf, shape } from './helpers/route-sweep';
import type { SweepRoute } from './helpers/route-sweep';
import { DB } from '../src/db/db.module';
import type { Db } from '../src/db/client';
import { approvals, automationRuns, automations } from '../src/db/schema';

/**
 * ticket #1117 / ADR-0018 (b): the one caller the other sweeps do not model on a PLAIN database. A GUEST holds a grant on database A; database B
 * sits in the SAME space, is NOT restricted, and she has no grant on it (the only way a person can have partial access in a space is being a guest:
 * "a test without a GUEST fixture proves nothing"). For every route that takes B's id, with the REAL child ids inside B (record, field, view,
 * comment, rule, run...) sent on the hidden side, the answer (status, code, message) must equal the answer for ids that do not exist.
 * The earlier sweeps compared B against absent with every OTHER id absent too, and always on a RESTRICTED database.
 */
let app: NestFastifyApplication;
let owner: { token: string; email: string };
let ws: string, space: string, dbA: string, dbB: string, dbC: string;
let guest: { token: string };
let routes: SweepRoute[] = [];
let child: Record<string, string> = {};
let idCandidates: string[] = [];
let relBC: string, viewB: string;

const adm = (m: string, u: string, p?: unknown) => call(app, owner.token, m, u, p);
const mk = async (m: string, u: string, p?: unknown) => {
  const r = await adm(m, u, p);
  if (r.statusCode >= 300) throw new Error(`fixture ${m} ${u}: ${r.statusCode} ${r.body}`);
  return r.json();
};

beforeAll(async () => {
  app = await createTestApp();
  const dbh: Db = app.get(DB);
  owner = await signUpUser(app, 'GuestPartial Owner');
  ws = (await adm('POST', '/workspaces', { name: 'GuestPartial WS' })).json().id;
  space = (await adm('GET', `/workspaces/${ws}/spaces`)).json()[0].id;
  dbA = (await mk('POST', `/workspaces/${ws}/databases`, { space_id: space, name: 'Open to the guest' })).id;
  dbB = (await mk('POST', `/workspaces/${ws}/databases`, { space_id: space, name: 'Ungranted payroll' })).id;
  dbC = (await mk('POST', `/workspaces/${ws}/databases`, { space_id: space, name: 'Also ungranted' })).id;
  const base = `/workspaces/${ws}/databases/${dbB}`;
  const rec = (await mk('POST', `${base}/records`, { values: { name: 'Salaries' } })).id as string;
  const field = (await mk('POST', `${base}/fields`, { display_name: 'Level', type: 'select', options: [{ label: 'One', color: 'gray' }] })) as { id: string; options?: Array<{ id: string }> };
  const comment = (await mk('POST', `${base}/records/${rec}/comments`, { body: [{ type: 'text', text: 'secret' }] })).id as string;
  viewB = (await mk('POST', `${base}/views`, { name: 'B view', type: 'table', config: { sorts: [], hidden_field_ids: [], card_field_ids: [], column_widths: {} } })).id;
  relBC = (await mk('POST', `/workspaces/${ws}/relations`, { database_a_id: dbB, database_b_id: dbC, cardinality: 'many_to_many' })).id;
  const [rule] = await dbh.insert(automations).values({ databaseId: dbB, name: 'rule', trigger: { type: 'record_created' }, actions: [], createdBy: owner.email }).returning();
  const [run] = await dbh.insert(automationRuns).values({ automationId: rule!.id, workspaceId: ws, triggerRecordId: rec, status: 'ok', depth: 0, durationMs: 5 }).returning();
  const [appr] = await dbh.insert(approvals).values({ workspaceId: ws, ruleId: rule!.id, runId: run!.id, recordId: rec, actionIndex: 0, previewText: 'p', status: 'pending', actionSnapshot: { type: 'add_comment', ctx: { databaseId: dbB, workspaceId: ws } } }).returning();
  child = { rec, field: field.id, view: viewB, comment, run: run!.id, automation: rule!.id, rel: relBC, option: field.options?.[0]?.id ?? ABSENT };
  idCandidates = [rule!.id, run!.id, appr!.id, rec, field.id, viewB, comment];

  const g = await joinAs(app, owner.token, ws, 'GuestPartial Gina', 'guest', [{ database_id: dbA, role: 'viewer' }]);
  guest = g;
  routes = liveWorkspaceRoutes(app);
}, 300_000);
afterAll(async () => { await app.close(); });

describe('#1117 a guest with a grant on database A, in a space that also holds ungranted database B', () => {
  it('sanity: she reads A and gets a 404 on B (the partial-access fixture is real)', async () => {
    expect((await call(app, guest.token, 'GET', `/workspaces/${ws}/databases/${dbA}`)).statusCode).toBe(200);
    const b = await call(app, guest.token, 'GET', `/workspaces/${ws}/databases/${dbB}`);
    expect(b.statusCode).toBe(404);
    expect(shape(b)).toBe(shape(await call(app, guest.token, 'GET', `/workspaces/${ws}/databases/${ABSENT}`)));
    expect((await adm('GET', `/workspaces/${ws}/databases/${dbB}/records/${child.rec}`)).statusCode).toBe(200);
  });

  it('every :db route, with the REAL child ids of B on the hidden side, answers as for nonexistent ids', async () => {
    const mine = routes.filter((r) => paramsOf(r.path).includes('db'));
    const out: string[] = [];
    let calls = 0, unmapped = new Set<string>();
    for (const r of mine) {
      const others = paramsOf(r.path).filter((p) => p !== 'ws' && p !== 'db');
      const variants: Array<Record<string, string>> = [];
      const idLike = others.filter((p) => !(p in child));
      others.forEach((p) => { if (!(p in child) && p !== 'id') unmapped.add(p); });
      if (idLike.length) for (const c of idCandidates) variants.push({ ...child, ...Object.fromEntries(idLike.map((p) => [p, c])) });
      else variants.push({ ...child });
      for (const hiddenExtra of variants) {
        const res = await compareRoute({ app, ws, token: guest.token, route: r, param: 'db', real: [dbB], hiddenExtra });
        calls += res.calls;
        out.push(...res.leaks);
      }
    }
    console.log(`guest partial :db sweep: ${mine.length} routes, ${calls} comparisons, ${[...new Set(out)].length} leaks; unmapped params: ${[...unmapped].join(',')}`);
    expect(mine.length).toBeGreaterThan(40);
    expect([...new Set(out)], [...new Set(out)].join('\n')).toEqual([]);
  }, 900_000);

  it('id-only routes keyed by a relation or view that lives in B answer as for nonexistent ids', async () => {
    const mine = routes.filter((r) => { const p = paramsOf(r.path); return !p.includes('db') && !p.includes('space') && (p.includes('rel') || p.includes('view')); });
    const out: string[] = [];
    for (const r of mine) {
      const param = paramsOf(r.path).includes('rel') ? 'rel' : 'view';
      const real = param === 'rel' ? [relBC] : [viewB];
      out.push(...(await compareRoute({ app, ws, token: guest.token, route: r, param, real })).leaks);
    }
    console.log(`guest partial id-only: ${mine.length} routes, ${out.length} leaks`);
    expect(mine.length).toBeGreaterThan(5);
    expect(out, out.join('\n')).toEqual([]);
  }, 900_000);

  it('MUST KEEP: she still reads A and a record in it', async () => {
    const r = await mk('POST', `/workspaces/${ws}/databases/${dbA}/records`, { values: { name: 'Visible' } });
    expect((await call(app, guest.token, 'GET', `/workspaces/${ws}/databases/${dbA}/records/${r.id}`)).statusCode).toBe(200);
    expect((await call(app, guest.token, 'GET', `/workspaces/${ws}/databases/${dbA}/records/${ABSENT}`)).json().error.message).toBe('Record not found');
  });
});
