import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';

let app: NestFastifyApplication;
let admin: { token: string; email: string };
let wsId: string;

async function inject(method: string, url: string, payload?: unknown) {
  return app.inject({
    method: method as never,
    url: `/api/v1${url}`,
    headers: authed(admin.token),
    payload: payload as never,
  });
}

const ALL_SLUGS = [
  'calendar',
  'youtube-videos',
  'youtube-comments',
  'youtube-metrics',
  'client-work',
  'client-space',
  'agency-crm',
  'content-pipeline',
  'social-calendar',
  'funnels',
  'meetings',
  'customer-journey',
  'event-planning',
  'video-production',
  'campaigns-hq',
  'sales-crm',
  'org-chart',
  'time-off',
  'coaching-practice',
  'consulting',
  'author-studio',
  'dev-project',
  'solo-dev',
];

beforeAll(async () => {
  app = await createTestApp();
  admin = await signUpUser(app, 'Founder');
  wsId = (await inject('POST', '/workspaces', { name: 'Template WS' })).json().id;
});

afterAll(async () => {
  await app.close();
});

describe('template registry (MN-033/035/036/037)', () => {
  it('lists all templates with categories, scopes, previews, and intents', async () => {
    const res = await inject('GET', '/templates');
    const body = res.json();
    expect(body.data.map((t: { slug: string }) => t.slug).sort()).toEqual([...ALL_SLUGS].sort());
    const clientWork = body.data.find((t: { slug: string }) => t.slug === 'client-work');
    expect(clientWork.category).toBe('agency');
    expect(clientWork.preview.databases.map((d: { name: string }) => d.name)).toContain('Tasks');
    expect(clientWork.preview.relations.length).toBeGreaterThan(2);
    expect(body.intents.map((i: { id: string }) => i.id)).toContain('new-client');
    // MN-053: every pack ships a guide
    for (const t of body.data) {
      expect(t.guide, `${t.slug} must carry a guide`).toBeTruthy();
    }
    const newClient = body.intents.find((i: { id: string }) => i.id === 'new-client');
    expect(newClient.ends_with_invite).toBe(true);
  });

  it('installs EVERY template cleanly (each into its own workspace)', async () => {
    for (const slug of ALL_SLUGS) {
      const ws = (await inject('POST', '/workspaces', { name: `WS ${slug}` })).json().id;
      const options =
        slug === 'funnels' || slug === 'calendar' || slug.startsWith('youtube-')
          ? { space_id: (await inject('GET', `/workspaces/${ws}/spaces`)).json()[0].id }
          : {};
      const res = await inject('POST', `/workspaces/${ws}/templates/${slug}/apply`, options);
      expect(res.statusCode, `${slug}: ${res.body}`).toBe(201);
      expect(Object.keys(res.json().databases).length).toBeGreaterThan(0);
    }
  }, 120_000);

  it('calendar installs a renamed, immediately mappable database', async () => {
    const ws = (await inject('POST', '/workspaces', { name: 'Calendar template WS' })).json().id;
    const spaceId = (await inject('GET', `/workspaces/${ws}/spaces`)).json()[0].id;
    const res = await inject('POST', `/workspaces/${ws}/templates/calendar/apply`, {
      space_id: spaceId,
      database_name: 'Team Calendar',
      include_samples: false,
    });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().sample_records).toBe(0);
    expect(res.json().fields).toEqual(
      expect.objectContaining({
        'calendar.start': expect.any(String),
        'calendar.end': expect.any(String),
        'calendar.description': expect.any(String),
      }),
    );

    const databaseId = res.json().databases.calendar;
    const detail = (await inject('GET', `/workspaces/${ws}/databases/${databaseId}`)).json();
    expect(detail.name).toBe('Team Calendar');
    expect(detail.fields.map((field: { displayName: string }) => field.displayName)).toEqual(
      expect.arrayContaining(['Start', 'End', 'Description', 'Status', 'Location']),
    );
    expect(detail.views.map((view: { name: string }) => view.name)).toEqual(
      expect.arrayContaining(['Calendar', 'Upcoming events']),
    );
  });

  it('client-work ships Task DNA: Triage state, sub-tasks, My Tasks view, labels', async () => {
    const res = await inject('POST', `/workspaces/${wsId}/templates/client-work/apply`, {});
    expect(res.statusCode, res.body).toBe(201);
    const tasksDbId = res.json().databases.tasks;

    const detail = (await inject('GET', `/workspaces/${wsId}/databases/${tasksDbId}`)).json();
    const state = detail.fields.find((f: { apiName: string }) => f.apiName === 'state');
    expect(state.options.map((o: { label: string }) => o.label)).toContain('Triage');
    expect(state.options.map((o: { label: string }) => o.label)).toContain('Canceled');
    expect(detail.fields.some((f: { apiName: string }) => f.apiName === 'labels')).toBe(true);
    expect(
      detail.fields.filter((f: { type: string }) => f.type === 'relation').length,
    ).toBeGreaterThanOrEqual(3); // project + parent + blocked

    const viewNames = detail.views.map((v: { name: string }) => v.name);
    expect(viewNames).toEqual(
      expect.arrayContaining(['Task Board', 'Triage', 'My Tasks', 'Due This Week']),
    );

    // My Tasks resolves '@me' → the installer's records show up for me
    const myTasks = detail.views.find((v: { name: string }) => v.name === 'My Tasks');
    const query = await inject('POST', `/workspaces/${wsId}/databases/${tasksDbId}/records/query`, {
      filter: myTasks.config.filters,
    });
    expect(query.statusCode, query.body).toBe(201);
    expect(query.json().data.length).toBeGreaterThanOrEqual(1);

    // sub-task sample linked via parent relation
    const sub = await inject('POST', `/workspaces/${wsId}/databases/${tasksDbId}/records/query`, {
      filter: { field: 'parent_task', op: 'not_empty' },
    });
    expect(sub.json().data.length).toBe(1);
  });

  it('client-work (MN-082): Invoices interlink Clients + Projects, and the new view types wire up', async () => {
    const ws = (await inject('POST', '/workspaces', { name: 'MN-082 client-work' })).json().id;
    const res = await inject('POST', `/workspaces/${ws}/templates/client-work/apply`, {});
    expect(res.statusCode, res.body).toBe(201);
    const { clients, projects, contacts, invoices } = res.json().databases;
    expect(invoices).toBeTruthy();

    const detail = (await inject('GET', `/workspaces/${ws}/databases/${invoices}`)).json();
    const relationTargets = detail.fields
      .filter((f: { type: string }) => f.type === 'relation')
      .map((f: { relation: { target_database_name: string } }) => f.relation.target_database_name);
    expect(relationTargets).toEqual(expect.arrayContaining(['Clients', 'Projects']));

    // sample invoices actually link to both sides
    const linked = await inject('POST', `/workspaces/${ws}/databases/${invoices}/records/query`, {
      filter: { field: 'client', op: 'not_empty' },
    });
    expect(linked.json().data.length).toBeGreaterThanOrEqual(1);

    // new view types (MN-082): timeline on Projects, gallery on Clients, list on Contacts,
    // calendar + feed on Invoices — all present with the config the client needs to render them.
    const projectViews = (await inject('GET', `/workspaces/${ws}/databases/${projects}`)).json().views;
    const timeline = projectViews.find((v: { type: string }) => v.type === 'timeline');
    expect(timeline).toBeTruthy();
    expect(timeline.config.start_date_field_id).toBeTruthy();
    expect(timeline.config.end_date_field_id).toBeTruthy();

    const clientViews = (await inject('GET', `/workspaces/${ws}/databases/${clients}`)).json().views;
    expect(clientViews.some((v: { type: string }) => v.type === 'gallery')).toBe(true);

    const contactViews = (await inject('GET', `/workspaces/${ws}/databases/${contacts}`)).json().views;
    expect(contactViews.some((v: { type: string }) => v.type === 'list')).toBe(true);

    const invoiceViews = (await inject('GET', `/workspaces/${ws}/databases/${invoices}`)).json().views;
    expect(invoiceViews.some((v: { type: string }) => v.type === 'calendar')).toBe(true);
    const feed = invoiceViews.find((v: { type: string }) => v.type === 'feed');
    expect(feed).toBeTruthy();
    expect(feed.config.card_field_ids.length).toBeGreaterThan(0);
  });

  it('funnels (database-scoped) installs into an existing space and links to Clients cross-pack', async () => {
    const spaceId = (await inject('GET', `/workspaces/${wsId}/spaces`)).json()[0].id;
    const res = await inject('POST', `/workspaces/${wsId}/templates/funnels/apply`, {
      space_id: spaceId,
    });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().notes).toEqual([]); // Clients exists (client-work installed above) → relation created

    const funnelsDb = res.json().databases.funnels;
    const detail = (await inject('GET', `/workspaces/${wsId}/databases/${funnelsDb}`)).json();
    const relation = detail.fields.find((f: { type: string }) => f.type === 'relation');
    expect(relation.relation.target_database_name).toBe('Clients');
  });

  it('skips cross-pack relations gracefully when the target is missing', async () => {
    const ws = (await inject('POST', '/workspaces', { name: 'Lonely social' })).json().id;
    const res = await inject('POST', `/workspaces/${ws}/templates/social-calendar/apply`, {});
    expect(res.statusCode).toBe(201);
    expect(res.json().notes[0]).toContain('Articles');
  });

  it('include_samples: false installs structure only; sample removal is exact', async () => {
    const ws = (await inject('POST', '/workspaces', { name: 'Clean install' })).json().id;
    const res = await inject('POST', `/workspaces/${ws}/templates/solo-dev/apply`, {
      include_samples: false,
    });
    expect(res.json().sample_records).toBe(0);
    const issues = res.json().databases.issues;
    const list = await inject('GET', `/workspaces/${ws}/databases/${issues}/records`);
    expect(list.json().data).toHaveLength(0);

    // and the tracked-removal path still works
    await inject('POST', `/workspaces/${ws}/templates/solo-dev/apply`, {});
    const removed = await inject('DELETE', `/workspaces/${ws}/templates/sample-data`);
    expect(removed.json().removed).toBe(3);
  });

  it('client-space renames its space from space_name (the "new client" intent)', async () => {
    const res = await inject('POST', `/workspaces/${wsId}/templates/client-space/apply`, {
      space_name: 'Globex Corp',
    });
    expect(res.statusCode, res.body).toBe(201);
    const spaces = (await inject('GET', `/workspaces/${wsId}/spaces`)).json();
    expect(spaces.map((s: { name: string }) => s.name)).toContain('Globex Corp');
  });
});
