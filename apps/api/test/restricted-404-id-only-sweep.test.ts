import './helpers/enable-mcp-oauth';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { signUpUser } from './helpers/users';
import { call, joinAs, setRestricted } from './helpers/members';
import type { Person } from './helpers/members';
import { connectMcpClient } from './helpers/mcp-oauth-flow';
import { restoreMcpOAuth } from './helpers/enable-mcp-oauth';
import { ABSENT, compareRoute, liveWorkspaceRoutes, paramsOf, shape } from './helpers/route-sweep';
import type { SweepRoute } from './helpers/route-sweep';
import { ACCESS_COVERAGE } from './access-coverage.registry';
import { DB } from '../src/db/db.module';
import type { Db } from '../src/db/client';
import { approvals, automationRuns, automations } from '../src/db/schema';

/**
 * ticket #1101 (part 2 of ticket #1098) / ADR-0018 (b): a restricted resource is hidden COMPLETELY — to a caller who cannot read it the
 * answer (status, code AND message) is byte-identical to the answer for an id that does not exist. Ticket #1098's sweep covered the
 * routes keyed by `:db` / `:space`, as a SESSION member. This file covers what it did not:
 *
 *   1. the same `:db` / `:space` sweep for a PAT caller, an OAuth (MCP) caller, a PAT BOUND to other resources (#543), and a GUEST;
 *   2. the routes keyed ONLY by a relation, view, document, folder, run, approval or favorite id, with no `:db` in the path, for all of
 *      those callers. The set is derived from the live route table and the access-coverage registry (#944): a `scoped` id-only route
 *      with no fixture here FAILS the file, so a new route cannot be added unswept (a hand list is how rule 3 of CLAUDE.md drifted).
 *
 * A test with no MEMBER fixture on a RESTRICTED resource proves nothing, so the caller is a member with no grant (and a guest holding a
 * grant on an UNRELATED database).
 */
let app: NestFastifyApplication;
let dbh: Db;
let owner: { token: string; email: string };
let ws: string, general: string, back: string;
let secretDb: string, backDb: string, openDb: string;
let bob: Person;
interface Caller { label: string; token: string }
const callers: Caller[] = [];
const routes: SweepRoute[] = [];

/** id-only routes: which param varies, and the ids (all inside something the caller cannot read) to compare with an absent one. */
interface IdFixture { re: RegExp; param: string; real: () => string[]; fixed?: Record<string, string> }
const idFixtures: IdFixture[] = [];
/** id-only routes that touch no restricted content, with the reason; anything `scoped` and not listed here needs a fixture above. */
const NOT_DATABASE_KEYED: Array<[RegExp, string]> = [
  [/\/notifications\/:id\//, 'a notification is the caller\'s OWN row; it carries no database or space to restrict'],
  [/\/space-groups\/:group/, 'a space group is a presentational heading: it owns nothing and carries no access rule (views-and-the-sidebar.md, 2026-10-23 amendment)'],
  [/\/files\/:id/, 'files carry no space/database at upload time (#238 note in files.controller.ts); the workspace is the only scope'],
];

const adm = (m: string, u: string, p?: unknown) => call(app, owner.token, m, u, p);
const id = async (m: string, u: string, p?: unknown) => {
  const r = await adm(m, u, p);
  if (r.statusCode >= 300) throw new Error(`fixture ${m} ${u}: ${r.statusCode} ${r.body}`);
  return r.json().id as string;
};

beforeAll(async () => {
  app = await createTestApp();
  dbh = app.get(DB);
  owner = await signUpUser(app, 'Idonly Owner');
  ws = (await adm('POST', '/workspaces', { name: 'Idonly WS' })).json().id;
  general = (await adm('GET', `/workspaces/${ws}/spaces`)).json()[0].id;
  back = await id('POST', `/workspaces/${ws}/spaces`, { name: 'Back office' });
  secretDb = await id('POST', `/workspaces/${ws}/databases`, { space_id: general, name: 'Payroll' });
  backDb = await id('POST', `/workspaces/${ws}/databases`, { space_id: back, name: 'Board minutes' });
  openDb = await id('POST', `/workspaces/${ws}/databases`, { space_id: general, name: 'Open tasks' });

  // fixtures INSIDE the restricted database / restricted space, created while the owner can still see everything
  const relSecret = await id('POST', `/workspaces/${ws}/relations`, { database_a_id: secretDb, database_b_id: openDb, cardinality: 'many_to_many' });
  const relBack = await id('POST', `/workspaces/${ws}/relations`, { database_a_id: backDb, database_b_id: openDb, cardinality: 'many_to_many' });
  const viewCfg = { sorts: [], hidden_field_ids: [], card_field_ids: [], column_widths: {} };
  const dbViewSecret = await id('POST', `/workspaces/${ws}/databases/${secretDb}/views`, { name: 'Secret view', type: 'table', config: viewCfg });
  const dbViewBack = await id('POST', `/workspaces/${ws}/databases/${backDb}/views`, { name: 'Back view', type: 'table', config: viewCfg });
  const spaceViewBack = await id('POST', `/workspaces/${ws}/spaces/${back}/views`, { name: 'Overview', type: 'dashboard' });
  const docBack = await id('POST', `/workspaces/${ws}/spaces/${back}/documents`, { title: 'Minutes' });
  const folderBack = await id('POST', `/workspaces/${ws}/spaces/${back}/folders`, { name: 'Board' });
  const recSecret = await id('POST', `/workspaces/${ws}/databases/${secretDb}/records`, { values: { name: 'Salaries' } });
  const mkRun = async (databaseId: string, record: string) => {
    const [rule] = await dbh.insert(automations).values({ databaseId, name: 'rule', trigger: { type: 'record_created' }, actions: [], createdBy: owner.email }).returning();
    const [run] = await dbh.insert(automationRuns).values({ automationId: rule!.id, workspaceId: ws, triggerRecordId: record, status: 'ok', depth: 0, durationMs: 5 }).returning();
    const [appr] = await dbh.insert(approvals).values({
      workspaceId: ws, ruleId: rule!.id, runId: run!.id, recordId: record, actionIndex: 0, previewText: 'p', status: 'pending',
      actionSnapshot: { type: 'add_comment', ctx: { databaseId, workspaceId: ws } },
    }).returning();
    return { run: run!.id, approval: appr!.id };
  };
  const secretRun = await mkRun(secretDb, recSecret);
  const backRec = await id('POST', `/workspaces/${ws}/databases/${backDb}/records`, { values: { name: 'Minutes rec' } });
  const backRun = await mkRun(backDb, backRec);

  bob = await joinAs(app, owner.token, ws, 'Idonly Bob', 'member');
  const gina = await joinAs(app, owner.token, ws, 'Idonly Gina', 'guest', [{ database_id: openDb, role: 'viewer' }]);
  await setRestricted(app, owner.token, ws, 'database', secretDb);
  await setRestricted(app, owner.token, ws, 'space', back);

  // the four ways of being a caller
  const pat = async (resource_scope?: unknown) => {
    const r = await call(app, bob.token, 'POST', '/me/tokens', { name: 'sweep', workspace_id: ws, scope: 'admin', ...(resource_scope ? { resource_scope } : {}) });
    if (r.statusCode !== 201) throw new Error(`mint: ${r.body}`);
    return r.json().token as string;
  };
  callers.push({ label: 'session member', token: bob.token });
  callers.push({ label: 'PAT member (admin scope)', token: await pat() });
  callers.push({ label: 'OAuth member', token: String((await connectMcpClient(app, bob.token)).access_token) });
  callers.push({ label: 'bound PAT (bound to the open database)', token: await pat({ database_ids: [openDb] }) });
  callers.push({ label: 'session guest (grant on an unrelated database)', token: gina.token });

  routes.push(...liveWorkspaceRoutes(app));
  idFixtures.push(
    { re: /\/relations\/:rel/, param: 'rel', real: () => [relSecret, relBack] },
    { re: /\/views\/:view/, param: 'view', real: () => [dbViewSecret, dbViewBack, spaceViewBack] },
    { re: /\/documents\/:doc/, param: 'doc', real: () => [docBack] },
    { re: /\/folders\/:folder/, param: 'folder', real: () => [folderBack] },
    { re: /\/runs\/:id/, param: 'id', real: () => [secretRun.run, backRun.run] },
    { re: /\/approvals\/:id\//, param: 'id', real: () => [secretRun.approval, backRun.approval] },
    { re: /\/favorites\/:type\/:id/, param: 'id', real: () => [secretDb, backDb], fixed: { type: 'database' } },
  );
}, 300_000);
afterAll(async () => { await app.close(); restoreMcpOAuth(); });

const covKey = (r: SweepRoute) => `${r.method} /api/v1${r.path}`;
const idOnly = () => routes.filter((r) => { const p = paramsOf(r.path); return !p.includes('db') && !p.includes('space') && p.some((x) => x !== 'ws'); });

describe('#1101 the id-only routes are enumerated from the live route table, and every scoped one has a fixture', () => {
  it('no `scoped` id-only route is left without a fixture (or a stated reason it is not database-keyed)', () => {
    const missing = idOnly().filter((r) => {
      if (ACCESS_COVERAGE[covKey(r)]?.kind !== 'scoped') return false;
      if (NOT_DATABASE_KEYED.some(([re]) => re.test(r.path))) return false;
      return !idFixtures.some((f) => f.re.test(r.path));
    });
    expect(missing.map(covKey), 'add a fixture for each, or list it in NOT_DATABASE_KEYED with the reason').toEqual([]);
    expect(idOnly().length).toBeGreaterThan(40);
  });
});

describe('#1101 sanity: the callers really cannot read what is hidden', () => {
  it('every caller gets a 404 (or the bound-token refusal) on the restricted database and its space', async () => {
    for (const c of callers) {
      for (const u of [`/workspaces/${ws}/databases/${secretDb}`, `/workspaces/${ws}/databases/${backDb}`]) {
        const r = await call(app, c.token, 'GET', u);
        expect([403, 404], `${c.label} ${u}: ${r.statusCode} ${r.body}`).toContain(r.statusCode);
      }
    }
    // MUST KEEP: the same person's PAT/OAuth still reads what is open, and the admin sees everything
    for (const c of callers.filter((x) => x.label.startsWith('PAT member') || x.label.startsWith('OAuth'))) {
      expect((await call(app, c.token, 'GET', `/workspaces/${ws}/databases/${openDb}`)).statusCode, c.label).toBe(200);
    }
    expect((await adm('GET', `/workspaces/${ws}/databases/${secretDb}`)).statusCode).toBe(200);
    expect((await adm('GET', `/workspaces/${ws}/relations/${(idFixtures[0]!.real())[0]}`)).statusCode).toBe(200);
  });
});

describe('#1101 callers by token type: the :db / :space routes (ticket #1098 covered a SESSION member only)', () => {
  for (const [kind, params, hiddenIds] of [
    ['every route with a :db', new Set(['db']), () => [secretDb, backDb]],
    ['every route with a :space', new Set(['space']), () => [back]],
  ] as const) {
    it(kind, async () => {
      const mine = routes.filter((r) => paramsOf(r.path).some((p) => params.has(p)));
      const out: string[] = [];
      let calls = 0;
      for (const c of callers) {
        for (const r of mine) {
          const pname = paramsOf(r.path).find((p) => params.has(p))!;
          const res = await compareRoute({ app, ws, token: c.token, route: r, param: pname, real: hiddenIds() });
          calls += res.calls;
          out.push(...res.leaks.map((l) => `[${c.label}] ${l}`));
        }
      }
      console.log(`${kind}: ${mine.length} routes x ${callers.length} callers, ${calls} comparisons, ${out.length} leaks`);
      expect(out, out.join('\n')).toEqual([]);
    }, 900_000);
  }
});

describe('#1101 callers by token type: routes keyed ONLY by a relation / view / document / folder / run / approval / favorite id', () => {
  it('a hidden id answers exactly as an id that does not exist', async () => {
    const out: string[] = [];
    let compared = 0;
    for (const c of callers) {
      for (const r of idOnly()) {
        const f = idFixtures.find((x) => x.re.test(r.path));
        if (!f || ACCESS_COVERAGE[covKey(r)]?.kind !== 'scoped') continue;
        const res = await compareRoute({ app, ws, token: c.token, route: r, param: f.param, real: f.real(), fixed: f.fixed });
        compared += res.calls;
        out.push(...res.leaks.map((l) => `[${c.label}] ${l}`));
      }
    }
    console.log(`id-only sweep: ${idOnly().length} id-only routes, ${compared} comparisons, ${out.length} leaks`);
    expect(out, out.join('\n')).toEqual([]);
  }, 900_000);

  it('MUST KEEP: a caller who CAN read the resource still gets the real answer (readable relation / view; 404 only for a missing id)', async () => {
    const readableRel = await id('POST', `/workspaces/${ws}/relations`, { database_a_id: openDb, database_b_id: await id('POST', `/workspaces/${ws}/databases`, { space_id: general, name: 'Other open' }), cardinality: 'many_to_many' });
    const readableView = await id('POST', `/workspaces/${ws}/databases/${openDb}/views`, { name: 'Open view', type: 'table', config: { sorts: [], hidden_field_ids: [], card_field_ids: [], column_widths: {} } });
    for (const c of callers.filter((x) => /^(session member|PAT member|OAuth)/.test(x.label))) {
      expect((await call(app, c.token, 'GET', `/workspaces/${ws}/relations/${readableRel}`)).statusCode, `${c.label} relation`).toBe(200);
      expect((await call(app, c.token, 'GET', `/workspaces/${ws}/views/${readableView}`)).statusCode, `${c.label} view`).toBe(200);
      const missing = await call(app, c.token, 'GET', `/workspaces/${ws}/relations/${ABSENT}`);
      expect(shape(missing), c.label).toContain('Relation not found');
    }
    // and the admin reads the hidden relation (nothing is hidden from an admin)
    expect((await adm('GET', `/workspaces/${ws}/relations/${idFixtures[0]!.real()[0]}`)).statusCode).toBe(200);
  });
});
