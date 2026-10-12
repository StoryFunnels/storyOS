import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';
import { DB } from '../src/db/db.module';
import type { Db } from '../src/db/client';
import { fields, user } from '../src/db/schema';
import { TokensService } from '../src/tokens/tokens.service';

/**
 * #598 — scan the workspace for lifecycle-looking selects and convert chosen ones to `workflow` through
 * the existing per-field conversion. Fixture = a REAL-shaped workspace, not a prefix of one: a plain
 * lifecycle, a RAG column called "Status" beside a better candidate (ambiguous), a database that already
 * has its workflow, one with nothing, and non-lifecycle selects (Priority, Type) that must NOT be offered.
 */
let app: NestFastifyApplication;
let db: Db;
let admin: { token: string; email: string };
let adminId: string;
let wsId: string;
const ids: Record<string, string> = {};

const as = (t: string, m: string, u: string, p?: unknown) => app.inject({ method: m as never, url: `/api/v1${u}`, headers: authed(t), payload: p as never });
const mkDb = async (name: string) =>
  (await as(admin.token, 'POST', `/workspaces/${wsId}/databases`, { space_id: ids.space, name })).json().id as string;
const mkSelect = async (dbId: string, name: string, labels: string[], type = 'select') => {
  const res = await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/fields`, {
    display_name: name, type, config: {}, options: labels.map((label) => ({ label })),
  });
  expect(res.statusCode, res.body).toBeLessThan(300);
  return res.json().id as string;
};
const scan = (t = admin.token) => as(t, 'GET', `/workspaces/${wsId}/workflow-nomination`);
const apply = (nominations: unknown[], dry_run?: boolean, t = admin.token) =>
  as(t, 'POST', `/workspaces/${wsId}/workflow-nomination`, dry_run === undefined ? { nominations } : { nominations, dry_run });
const typeOf = async (fieldId: string) => (await db.query.fields.findFirst({ where: eq(fields.id, fieldId) }))!.type;

beforeAll(async () => {
  app = await createTestApp();
  db = app.get(DB);
  admin = await signUpUser(app, 'Nominator');
  adminId = (await db.query.user.findFirst({ where: eq(user.email, admin.email) }))!.id;
  wsId = (await as(admin.token, 'POST', '/workspaces', { name: 'nomination' })).json().id;
  ids.space = (await as(admin.token, 'GET', `/workspaces/${wsId}/spaces`)).json()[0].id;

  ids.tasks = await mkDb('Tasks');
  ids.tasksStatus = await mkSelect(ids.tasks, 'Status', ['Backlog', 'In progress', 'Done']);
  ids.tasksPriority = await mkSelect(ids.tasks, 'Priority', ['Low', 'Medium', 'High']);
  ids.tasksType = await mkSelect(ids.tasks, 'Type', ['Bug', 'Feature']);

  ids.projects = await mkDb('Projects');
  ids.projectsRag = await mkSelect(ids.projects, 'Status', ['Red', 'Amber', 'Green']);
  ids.projectsPipeline = await mkSelect(ids.projects, 'Pipeline stage', ['New', 'Doing', 'Shipped']);

  ids.bugs = await mkDb('Bugs');
  ids.bugsWorkflow = await mkSelect(ids.bugs, 'State', ['Open', 'Closed'], 'workflow');

  ids.notes = await mkDb('Notes');
  await mkSelect(ids.notes, 'Kind', ['Idea', 'Reference']);

  // A record carrying a value, to prove conversion preserves it.
  const opt = (await as(admin.token, 'GET', `/workspaces/${wsId}/databases/${ids.tasks}`)).json().fields.find((f: { id: string }) => f.id === ids.tasksStatus).options as Array<{ id: string; label: string }>;
  ids.doneOption = opt.find((o) => o.label === 'Done')!.id;
  const rec = await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${ids.tasks}/records`, { values: { name: 'ship it', status: ids.doneOption } });
  expect(rec.statusCode, rec.body).toBeLessThan(300);
  ids.record = rec.json().id;
}, 120_000);

afterAll(async () => {
  await app.close();
});

describe('#598 — the scan (read-only)', () => {
  it('reports each database honestly: a lifecycle is a candidate, Priority/Type are NOT, a RAG "Status" is ranked BELOW a real pipeline (ambiguous), an existing workflow is left alone, nothing is nothing', async () => {
    const res = await scan();
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    const by = (name: string) => body.databases.find((d: { database_name: string }) => d.database_name === name);

    const tasks = by('Tasks');
    expect(tasks.status).toBe('candidates');
    expect(tasks.ambiguous).toBe(false);
    expect(tasks.candidates.map((c: { display_name: string }) => c.display_name)).toEqual(['Status']);
    expect(tasks.candidates[0].confidence).toBe('high');
    expect(JSON.stringify(tasks), 'Priority and Type are not lifecycles and must not be offered').not.toMatch(/Priority|"Type"/);

    const projects = by('Projects');
    expect(projects.ambiguous, 'two plausible lifecycles: a person must choose').toBe(true);
    expect(projects.candidates.map((c: { display_name: string }) => c.display_name)).toEqual(['Pipeline stage', 'Status']);
    expect(projects.candidates[1].confidence, 'the RAG column matches by name only').toBe('low');

    expect(by('Bugs').status).toBe('has_workflow');
    expect(by('Bugs').existing_workflow.display_name).toBe('State');
    expect(by('Notes').status).toBe('none');
    // The workspace also carries its own system database(s) (Members, #128); they hold no lifecycle select.
    const names = body.databases.map((d: { database_name: string }) => d.database_name);
    expect(names).toEqual(expect.arrayContaining(['Tasks', 'Projects', 'Bugs', 'Notes']));
    expect(body.summary).toMatchObject({ databases_scanned: names.length, with_workflow: 1, with_candidates: 2, ambiguous: 1 });
  });

  it('the scan changes nothing', async () => {
    await scan();
    expect(await typeOf(ids.tasksStatus)).toBe('select');
  });
});

describe('#598 — apply: dry run by DEFAULT, then really, through the existing conversion', () => {
  it('no dry_run given -> a dry run: would_convert, and NOTHING changed', async () => {
    const res = await apply([{ database_id: ids.tasks, field_id: ids.tasksStatus }]);
    expect(res.statusCode, res.body).toBeLessThan(300);
    expect(res.json().dry_run).toBe(true);
    expect(res.json().results[0].status).toBe('would_convert');
    expect(await typeOf(ids.tasksStatus), 'a default must never convert').toBe('select');
  });

  it('dry_run:false converts; the record keeps its value and the option ids; running it again is a skip, not an error', async () => {
    const res = await apply([{ database_id: ids.tasks, field_id: ids.tasksStatus }], false);
    expect(res.statusCode, res.body).toBeLessThan(300);
    expect(res.json().results[0].status).toBe('converted');
    expect(await typeOf(ids.tasksStatus)).toBe('workflow');
    const rec = (await as(admin.token, 'GET', `/workspaces/${wsId}/databases/${ids.tasks}/records/${ids.record}`)).json();
    expect(rec.values.status, 'the stored option id is preserved').toBe(ids.doneOption);
    const again = await apply([{ database_id: ids.tasks, field_id: ids.tasksStatus }], false);
    expect(again.json().results[0].status).toBe('skipped');
    // And the scan now reports it as already having its workflow.
    expect((await scan()).json().databases.find((d: { database_name: string }) => d.database_name === 'Tasks').status).toBe('has_workflow');
  });

  it('two nominations in ONE database in one batch: the second is refused even as a dry run (a database holds one workflow field)', async () => {
    const res = await apply(
      [{ database_id: ids.projects, field_id: ids.projectsPipeline }, { database_id: ids.projects, field_id: ids.projectsRag }],
      true,
    );
    expect(res.json().results.map((r: { status: string }) => r.status)).toEqual(['would_convert', 'error']);
    expect(res.json().results[1].reason).toMatch(/holds one workflow field/);
    expect(await typeOf(ids.projectsRag)).toBe('select');
  });

  it('one refusal does not stop the rest: a database that already has a workflow refuses, the good one still converts', async () => {
    const extra = await mkSelect(ids.bugs, 'Lifecycle', ['New', 'In progress', 'Done']);
    const res = await apply(
      [{ database_id: ids.bugs, field_id: extra }, { database_id: ids.projects, field_id: ids.projectsPipeline }],
      false,
    );
    expect(res.json().results[0].status).toBe('error');
    expect(res.json().results[0].reason).toMatch(/workflow/i);
    expect(res.json().results[1].status).toBe('converted');
    expect(await typeOf(ids.projectsPipeline)).toBe('workflow');
    expect(await typeOf(extra), 'the refused one is untouched').toBe('select');
  });

  it('a field from the wrong database, and a database that does not exist, are errors, not crashes', async () => {
    const res = await apply(
      [
        { database_id: ids.notes, field_id: ids.projectsRag },
        { database_id: '00000000-0000-4000-8000-000000000000', field_id: ids.projectsRag },
      ],
      true,
    );
    expect(res.statusCode).toBe(201);
    expect(res.json().results.map((r: { status: string }) => r.status)).toEqual(['error', 'error']);
  });
});

describe('#598 — who may scan and who may convert', () => {
  it('a read-scoped token scans but cannot apply; a guest sees only the databases they were granted and cannot convert', async () => {
    const readTok = (await app.get(TokensService).create(adminId, wsId, 'reader', 'read', true)).token;
    expect((await scan(readTok)).statusCode).toBe(200);
    expect((await apply([{ database_id: ids.notes, field_id: ids.projectsRag }], true, readTok)).statusCode).toBe(403);

    const guest = await signUpUser(app, 'Nomination Guest');
    const inv = await as(admin.token, 'POST', `/workspaces/${wsId}/invites`, { email: guest.email, role: 'guest', grants: [{ database_id: ids.notes, role: 'viewer' }] });
    await as(guest.token, 'POST', '/invites/accept', { token: new URL(inv.json().accept_url).searchParams.get('token')! });
    const seen = await scan(guest.token);
    expect(seen.statusCode, seen.body).toBe(200);
    expect(seen.body, 'databases the guest cannot read are ABSENT: no name, no count').not.toMatch(/Tasks|Projects|Bugs/);
    expect(seen.json().summary.databases_scanned, 'only the one granted database').toBe(1);
    const denied = await apply([{ database_id: ids.notes, field_id: ids.projectsRag }], false, guest.token);
    expect(denied.json().results[0].status, 'a viewer cannot change a schema').toBe('error');
    const hidden = await apply([{ database_id: ids.tasks, field_id: ids.tasksPriority }], true, guest.token);
    expect(hidden.json().results[0].reason, 'indistinguishable from a database that does not exist').toMatch(/not found/i);
  });
});
