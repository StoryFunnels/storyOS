import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';

/**
 * A view filtered by "me" and published by public link: a public page has NO signed-in visitor, so "me" resolves to
 * nobody and the page quietly shows nothing, while the same view shows the owner their records. Nothing refused the
 * share, so the owner saw their own link work (signed in) and could not tell the page was empty for everyone else.
 */
let app: NestFastifyApplication;
let owner: { token: string };
let ws: string;
let dbId: string;
let assigneeApi: string;
let createdByViewId: string;

const inject = (token: string | null, method: string, url: string, payload?: unknown) =>
  app.inject({ method: method as never, url: `/api/v1${url}`, headers: token ? authed(token) : {}, payload: payload as never });
const as = (method: string, url: string, payload?: unknown) => inject(owner.token, method, url, payload);

const ME_VIEW = { type: 'table', name: 'My tasks', config: { filters: { field: 'assignee', op: 'has', value: ['me'] }, sorts: [], hidden_field_ids: [], card_field_ids: [], dashboard_tiles: [], dashboard_widgets: [], summary_widgets: [], column_widths: {} } };

beforeAll(async () => {
  app = await createTestApp();
  owner = await signUpUser(app, 'Me Owner');
  ws = (await as('POST', '/workspaces', { name: 'Me Filter WS' })).json().id;
  const space = (await as('GET', `/workspaces/${ws}/spaces`)).json()[0].id;
  dbId = (await as('POST', `/workspaces/${ws}/databases`, { space_id: space, name: 'Tasks' })).json().id;
  const f = await as('POST', `/workspaces/${ws}/databases/${dbId}/fields`, { display_name: 'Assignee', type: 'user' });
  assigneeApi = f.json().apiName;
  const meId = (await as('GET', '/me')).json().id;
  await as('POST', `/workspaces/${ws}/databases/${dbId}/records`, { values: { name: 'Mine', [assigneeApi]: meId } });
  await as('POST', `/workspaces/${ws}/databases/${dbId}/records`, { values: { name: 'Unassigned' } });
  createdByViewId = '';
}, 120_000);
afterAll(async () => { await app.close(); });

const mkView = async (body: unknown) => {
  const r = await as('POST', `/workspaces/${ws}/databases/${dbId}/views`, body);
  expect(r.statusCode, r.body).toBe(201);
  return r.json().id as string;
};
const share = (viewId: string, payload: unknown = {}) => as('POST', `/workspaces/${ws}/databases/${dbId}/views/${viewId}/share`, payload);

describe('a view filtered by Me cannot be published', () => {
  it('REPRODUCTION: signed in the view shows the owner their record; published, an anonymous visitor gets an empty page', async () => {
    const viewId = await mkView(ME_VIEW);
    const signedIn = await as('POST', `/workspaces/${ws}/databases/${dbId}/records/query`, { filter: ME_VIEW.config.filters, limit: 10 });
    expect(signedIn.json().data.map((r: { title: string }) => r.title)).toEqual(['Mine']);
    const res = await share(viewId);
    const anon = res.statusCode === 201 ? await inject(null, 'GET', `/public/views/${res.json().token}`) : null;
    const served = anon ? (anon.json().records.data as Array<{ title: string }>).map((r) => r.title) : null;
    expect(res.statusCode, `share answered ${res.statusCode}; an anonymous visitor to that link is served ${JSON.stringify(served)}`).toBe(422);
    expect(res.body).toContain('Me');
    expect(res.body).not.toContain('token');
  });

  it('the refusal names the field and says what to do, in plain words', async () => {
    const viewId = await mkView(ME_VIEW);
    const res = await share(viewId);
    expect(res.statusCode).toBe(422);
    const message = res.json().error.message as string;
    expect(message).toContain('Assignee');
    expect(message).toMatch(/no signed-in visitor|nobody is signed in/i);
    expect(message).toMatch(/remove|filter by a specific person/i);
  });

  it('adding a Me condition to a view that is ALREADY public is refused, and the link keeps working unchanged', async () => {
    const viewId = await mkView({ type: 'table', name: 'All tasks' });
    const shared = await share(viewId);
    expect(shared.statusCode, shared.body).toBe(201);
    const patch = await as('PATCH', `/workspaces/${ws}/databases/${dbId}/views/${viewId}`, { config: ME_VIEW.config });
    expect(patch.statusCode, `served: ${patch.body}`).toBe(422);
    const anon = await inject(null, 'GET', `/public/views/${shared.json().token}`);
    expect(anon.statusCode).toBe(200);
    expect((anon.json().records.data as unknown[]).length, 'the public page still shows both records').toBe(2);
  });

  it('a Me condition nested in and/or, on created_by, and in a dashboard tile filter is refused too', async () => {
    const nested = await mkView({ ...ME_VIEW, name: 'Nested', config: { ...ME_VIEW.config, filters: { and: [{ field: 'name', op: 'contains', value: 'x' }, { or: [{ field: assigneeApi, op: 'has', value: ['me'] }] }] } } });
    expect((await share(nested)).statusCode).toBe(422);
    const mine = await mkView({ ...ME_VIEW, name: 'Created by me', config: { ...ME_VIEW.config, filters: { field: 'created_by', op: 'eq', value: 'me' } } });
    expect((await share(mine)).statusCode).toBe(422);
    const dash = await mkView({
      type: 'dashboard', name: 'KPIs',
      config: { ...ME_VIEW.config, filters: undefined, dashboard_tiles: [{ id: '5b1f4c1e-1d6a-4a6e-9a55-0f6a1d5c2b01', label: 'Mine', op: 'count', filter: { field: assigneeApi, op: 'has', value: ['me'] } }] },
    });
    expect((await share(dash)).statusCode).toBe(422);
  });

  it('AC5: publishing the shipped template\'s "My Tasks" view is refused and the message reads clearly', async () => {
    const space = (await as('POST', `/workspaces/${ws}/spaces`, { name: 'Template space' })).json().id;
    const tpl = await as('POST', `/workspaces/${ws}/templates/solo-dev/apply`, { space_id: space, include_samples: false });
    expect(tpl.statusCode, tpl.body).toBe(201);
    const issuesDb = tpl.json().databases.issues ?? Object.values(tpl.json().databases)[0];
    const detail = (await as('GET', `/workspaces/${ws}/databases/${issuesDb}`)).json();
    const myTasks = (detail.views as Array<{ id: string; name: string }>).find((v) => v.name === 'My Tasks');
    expect(myTasks, 'the template ships a My Tasks view').toBeTruthy();
    const res = await as('POST', `/workspaces/${ws}/databases/${issuesDb}/views/${myTasks!.id}/share`, {});
    expect(res.statusCode, res.body).toBe(422);
    expect(res.json().error.message).toMatch(/^This view filters by "Me" \(the "[^"]+" field\)\. A public link has no signed-in visitor/);
  });

  it('MUST KEEP WORKING: a Me view works for the signed-in owner; a view without Me, a text filter whose VALUE is "me", and a specific person are all publishable', async () => {
    const viewId = await mkView(ME_VIEW);
    expect((await as('POST', `/workspaces/${ws}/databases/${dbId}/records/query`, { filter: ME_VIEW.config.filters, limit: 10 })).json().data).toHaveLength(1);
    expect(viewId).toBeTruthy();
    const plain = await mkView({ type: 'table', name: 'Plain' });
    expect((await share(plain)).statusCode).toBe(201);
    const text = await mkView({ ...ME_VIEW, name: 'Title is me', config: { ...ME_VIEW.config, filters: { field: 'name', op: 'contains', value: 'me' } } });
    expect((await share(text)).statusCode, 'a text filter whose value happens to be "me" is not a Me condition').toBe(201);
    const meId = (await as('GET', '/me')).json().id;
    const person = await mkView({ ...ME_VIEW, name: 'Specific person', config: { ...ME_VIEW.config, filters: { field: assigneeApi, op: 'has', value: [meId] } } });
    expect((await share(person)).statusCode).toBe(201);
  });
});
