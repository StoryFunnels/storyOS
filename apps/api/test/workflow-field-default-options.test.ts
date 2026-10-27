import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';

/**
 * #1087 — a new Workflow (status) field used to start with ZERO options, so every board column was typed by hand. With no options given
 * it now starts as To do / In progress / Done, with the #1014 categories and three distinct colours. The default lives in the API
 * (FieldsService.create), so the web dialog, REST and MCP add_field all get it; explicit options are used exactly as given.
 */
let app: NestFastifyApplication;
let token: string;
let ws: string;
const as = (method: string, url: string, payload?: unknown) => app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(token), payload: payload as never });

interface Opt { id: string; label: string; color: string; category: string | null; position?: number }
const newDb = async (name: string) => {
  const space = (await as('GET', `/workspaces/${ws}/spaces`)).json()[0].id as string;
  return (await as('POST', `/workspaces/${ws}/databases`, { space_id: space, name })).json().id as string;
};
const addField = (db: string, body: Record<string, unknown>) => as('POST', `/workspaces/${ws}/databases/${db}/fields`, body);

beforeAll(async () => {
  app = await createTestApp();
  token = (await signUpUser(app, 'Workflow Defaults')).token;
  ws = (await as('POST', '/workspaces', { name: 'Workflow Defaults WS' })).json().id;
}, 120_000);
afterAll(async () => { await app.close(); });

describe('#1087 a workflow field created with no options', () => {
  it('has To do / In progress / Done, in categories unstarted / started / completed, with three distinct colours', async () => {
    const db = await newDb('No options given');
    const res = await addField(db, { display_name: 'Status', type: 'workflow', config: {} });
    expect(res.statusCode, res.body).toBe(201);
    const options = (res.json().options ?? []) as Opt[];
    expect(options.map((o) => o.label), 'what a new Workflow field contains').toEqual(['To do', 'In progress', 'Done']);
    expect(options.map((o) => o.category)).toEqual(['unstarted', 'started', 'completed']);
    expect(new Set(options.map((o) => o.color)).size, 'three DISTINCT colours').toBe(3);
  });

  it('an EMPTY options list counts as none given (the web dialog sends one when the person adds nothing)', async () => {
    const db = await newDb('Empty list');
    const res = await addField(db, { display_name: 'Status', type: 'workflow', config: {}, options: [] });
    expect(res.statusCode, res.body).toBe(201);
    expect((res.json().options as Opt[]).map((o) => o.label)).toEqual(['To do', 'In progress', 'Done']);
  });

  it('the options are an ordered flow: positions 0, 1, 2 and the same set on a re-read', async () => {
    const db = await newDb('Defaults persist');
    const created = (await addField(db, { display_name: 'Status', type: 'workflow', config: {} })).json();
    const reread = (await as('GET', `/workspaces/${ws}/databases/${db}`)).json().fields.find((f: { id: string }) => f.id === created.id);
    expect((reread.options as Opt[]).map((o) => o.label)).toEqual(['To do', 'In progress', 'Done']);
    expect((reread.options as Opt[]).map((o) => o.category)).toEqual(['unstarted', 'started', 'completed']);
  });
});

describe('#1087 explicit options are used exactly as given, with nothing added on top', () => {
  it('your own options, your own categories and colours', async () => {
    const db = await newDb('Explicit options');
    const res = await addField(db, {
      display_name: 'Stage', type: 'workflow', config: {},
      options: [{ label: 'Idea', color: 'purple' }, { label: 'Shipped', color: 'teal' }],
    });
    expect(res.statusCode, res.body).toBe(201);
    const options = res.json().options as Opt[];
    expect(options.map((o) => o.label)).toEqual(['Idea', 'Shipped']);
    expect(options.map((o) => o.color)).toEqual(['purple', 'teal']);
    expect(options.map((o) => o.label)).not.toContain('To do');
  });

  it('a single option is just that option', async () => {
    const db = await newDb('One option');
    const res = await addField(db, { display_name: 'Stage', type: 'workflow', config: {}, options: [{ label: 'Only' }] });
    expect((res.json().options as Opt[]).map((o) => o.label)).toEqual(['Only']);
  });
});

describe('#1087 nothing else changes', () => {
  it('a plain select and a multi_select with no options stay empty', async () => {
    const db = await newDb('Other types');
    for (const type of ['select', 'multi_select']) {
      const res = await addField(db, { display_name: `Plain ${type}`, type, config: {} });
      expect(res.statusCode, res.body).toBe(201);
      expect((res.json().options ?? []) as Opt[], type).toEqual([]);
    }
  });

  it('a database still has at most ONE workflow field, and an existing workflow field is untouched', async () => {
    const db = await newDb('One workflow only');
    const first = (await addField(db, { display_name: 'Status', type: 'workflow', config: {}, options: [{ label: 'A' }, { label: 'B' }] })).json();
    expect((await addField(db, { display_name: 'Second', type: 'workflow', config: {} })).statusCode, 'a second workflow field is still refused').toBe(409);
    const again = (await as('GET', `/workspaces/${ws}/databases/${db}`)).json().fields.find((f: { id: string }) => f.id === first.id);
    expect((again.options as Opt[]).map((o) => o.label)).toEqual(['A', 'B']);
  });

  it('a pack-defined workflow keeps exactly its own states (Dev Project: Triage first, no To do added)', async () => {
    const w = (await as('POST', '/workspaces', { name: 'Pack workflow WS' })).json().id as string;
    const applied = await as('POST', `/workspaces/${w}/templates/dev-project/apply`, {});
    expect(applied.statusCode, applied.body).toBe(201);
    const issues = applied.json().databases['issues'] as string;
    const state = ((await as('GET', `/workspaces/${w}/databases/${issues}`)).json().fields as Array<{ apiName: string; options?: Opt[] }>).find((f) => f.apiName === 'state')!;
    expect(state.options!.map((o) => o.label)).toEqual(['Triage', 'Backlog', 'To Do', 'In Progress', 'In Review', 'Done', 'Canceled']);
  });
});
